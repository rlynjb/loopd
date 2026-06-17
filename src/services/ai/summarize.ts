import {
  getAnthropicKey, getOpenAIKey, getProvider,
  getStrictLocalMode, getChainRoute,
  type RouteChoice,
} from './config';
import {
  callGemmaLocal, shouldUseGemmaLocal,
  GEMMA_LOCAL_MODEL,
} from './providers/gemma';
import { orchestrateCloud } from './providers/cloud';
import { cachedCall, type CacheKeyInput } from './cache';
import { buildPrompt } from './prompt';
import { validateSummary } from './validate';
import { generateCaption } from './caption';
import { getEntriesByDate, getRecentAISummaries, upsertAISummary } from '../database';
import type { AISummary, CaptionInput } from '../../types/ai';
import type { Entry } from '../../types/entry';

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OPENAI_MODEL = 'gpt-4o';
const MAX_TOKENS = 1024;

// Bump on meaningful prompt or output-format changes. v2 is the
// dryrun-parity refactor that swapped the cache key's `provider` field
// from AIProvider to RouteChoice; old rows naturally expire by missing
// the new key.
const PROMPT_VERSION = 'summarize-v2';

async function callClaude(apiKey: string, system: string, user: string): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return response.content[0]?.type === 'text' ? response.content[0].text : '';
}

async function callOpenAI(apiKey: string, system: string, user: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// Routes the summarize LLM call based on strict-local + per-chain route.
// Returns {text, model} so the cache layer records what actually served.
async function runSummarizeLLM(
  strictLocal: boolean,
  route: RouteChoice,
  system: string,
  user: string,
): Promise<{ text: string; model: string }> {
  // Strict-local: on-device only. Skips all cloud paths regardless of
  // the per-chain route.
  if (strictLocal) {
    if (!(await shouldUseGemmaLocal('summarize'))) {
      throw new Error('Strict local mode: on-device AI not ready');
    }
    const text = await callGemmaLocal('summarize', system, user, MAX_TOKENS);
    return { text, model: GEMMA_LOCAL_MODEL };
  }

  // route='on-device': try local, fall back to cloud on failure.
  if (route === 'on-device' && (await shouldUseGemmaLocal('summarize'))) {
    try {
      const text = await callGemmaLocal('summarize', system, user, MAX_TOKENS);
      return { text, model: GEMMA_LOCAL_MODEL };
    } catch (err) {
      console.warn('[buffr ai] summarize gemma local failed, falling back to cloud:', err instanceof Error ? err.message : err);
    }
  }

  // Cloud path: Anthropic primary + OpenAI fallback (per orchestrateCloud).
  const primary = await getProvider();
  const [claudeKey, openaiKey] = await Promise.all([getAnthropicKey(), getOpenAIKey()]);
  const { result: text, servedBy } = await orchestrateCloud({
    primary,
    callClaude: () => callClaude(claudeKey ?? '', system, user),
    callOpenAI: () => callOpenAI(openaiKey ?? '', system, user),
    hasClaudeKey: !!claudeKey,
    hasOpenAIKey: !!openaiKey,
  });
  return { text, model: servedBy === 'claude' ? CLAUDE_MODEL : OPENAI_MODEL };
}

export async function summarize(date: string): Promise<{ summary: AISummary | null; error?: string }> {
  const strictLocal = await getStrictLocalMode();
  const route = await getChainRoute('summarize');

  // Check whether ANY path can serve this chain before spending DB I/O.
  const [claudeKey, openaiKey] = await Promise.all([getAnthropicKey(), getOpenAIKey()]);
  const cloudReady = !!claudeKey || !!openaiKey;
  const gemmaReady = await shouldUseGemmaLocal('summarize');
  if (strictLocal && !gemmaReady) {
    return { summary: null, error: 'Strict local mode: on-device AI not ready' };
  }
  if (!strictLocal && !gemmaReady && !cloudReady) {
    return { summary: null, error: 'No API key configured' };
  }

  const entries = await getEntriesByDate(date);
  if (entries.length === 0) return { summary: null, error: 'No entries for this date' };

  const allClips: { id: string; entryId: string; durationMs: number }[] = [];
  const clipIds = new Set<string>();
  const clipDurations = new Map<string, number>();
  let clipIdx = 0;
  for (const e of entries) {
    for (const c of e.clips) {
      const id = `clip-${clipIdx}`;
      allClips.push({ id, entryId: e.id, durationMs: c.durationMs });
      clipIds.add(id);
      clipDurations.set(id, c.durationMs);
      clipIdx++;
    }
  }

  const allHabits = [...new Set(entries.flatMap(e => e.habits))];
  const { system, user } = buildPrompt(entries, allClips, allHabits, date);

  try {
    // Cache key uses the route as the "provider" axis — what kind of
    // compute path served the call. Switching from cloud to on-device
    // (or vice versa) misses the cache and re-runs naturally.
    const cacheInput: CacheKeyInput = {
      chain: 'summarize',
      provider: strictLocal ? 'on-device' : route,
      promptVersion: PROMPT_VERSION,
      system,
      user,
    };
    const { text, modelServed: model } = await cachedCall(cacheInput, async () => {
      const r = await runSummarizeLLM(strictLocal, route, system, user);
      return { text: r.text, modelServed: r.model };
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { summary: null, error: 'No JSON in response' };

    const parsed = JSON.parse(jsonMatch[0]);
    const { summary, errors } = validateSummary(parsed, clipIds, clipDurations);
    if (errors.length > 0) console.warn('[buffr ai] Validation warnings:', errors);

    // Second LLM call: 4-variant tonal caption per
    // docs/buffr-caption-variants-plan.md. Single call emits all four
    // variants (clean / smoother / reflective / punchy). Independent of the
    // structured summary — kept in its own call so the caption prompt can
    // stay strict on its forbidden patterns. Failures here don't fail the
    // summarize chain; the editor falls back to summary.summary for the
    // text overlay.
    try {
      const captionInput = await buildCaptionInput(date, entries, summary.mood);
      const { output: captionOut } = await generateCaption(captionInput);
      if (captionOut) {
        summary.variants = captionOut.variants;
        summary.variantsTheme = captionOut.detectedTheme;
      }
    } catch (err) {
      console.warn('[buffr ai] Caption skipped:', err instanceof Error ? err.message : err);
    }

    await upsertAISummary(date, JSON.stringify(summary), model);
    return { summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[buffr ai] Summarize error:', msg);
    return { summary: null, error: msg };
  }
}

// Build the caption-generator input from a day's entries.
// rawLog = entry text + done todos (each as its own bullet); ideas/open
// todos folded into the "things I noticed" framing so the model can apply
// the spec's "ideas → noticing" reframe rule (§10).
async function buildCaptionInput(
  date: string,
  entries: Entry[],
  mood: AISummary['mood'],
): Promise<CaptionInput> {
  const rawLog: string[] = [];
  for (const e of entries) {
    if (e.text) {
      // Split by sentence-ish boundaries; keep non-empty trimmed pieces.
      const pieces = e.text.split(/(?:[.!?]\s+|\n+)/).map(s => s.trim()).filter(Boolean);
      rawLog.push(...pieces);
    }
    for (const t of e.todos ?? []) {
      if (t.done) rawLog.push(t.text);
    }
  }

  // Pull last 5 cached captions for tonal continuity / anti-repetition.
  // Falls back to the structured `summary` field on older rows that
  // pre-date the caption feature.
  const recentRows = await getRecentAISummaries(date, 5);
  const recentCaptions: string[] = [];
  for (const row of recentRows) {
    try {
      const parsed = JSON.parse(row.summaryJson) as Partial<AISummary>;
      if (parsed.caption) recentCaptions.push(parsed.caption);
    } catch {
      /* skip malformed */
    }
  }

  // Map structured mood → spec-flavored mood string. The spec accepts an
  // open-text mood, so this is just a translation that gives the model a
  // useful starting impression rather than a forced enum.
  const moodLabel = (() => {
    switch (mood) {
      case 'flat': return 'flat / low energy';
      case 'ok': return 'steady';
      case 'good': return 'good';
      case 'great': return 'great';
      case 'fired': return 'fired up';
      default: return undefined;
    }
  })();

  return {
    date,
    rawLog,
    recentCaptions: recentCaptions.length > 0 ? recentCaptions : undefined,
    mood: moodLabel,
    themeHint: null,
  };
}

export async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  const primary = await getProvider();
  const [claudeKey, openaiKey] = await Promise.all([getAnthropicKey(), getOpenAIKey()]);
  const apiKey = primary === 'openai' ? openaiKey : claudeKey;
  if (!apiKey) return { ok: false, error: 'No API key' };

  try {
    if (primary === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 10, messages: [{ role: 'user', content: 'Say ok' }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true };
    } else {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      await client.messages.create({ model: CLAUDE_MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'Say "ok"' }] });
      return { ok: true };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
