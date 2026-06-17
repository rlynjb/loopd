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
import {
  CAPTION_VARIANT_KEYS,
  type CaptionInput,
  type CaptionTheme,
  type CaptionVariantKey,
  type CaptionVariantOutput,
} from '../../types/ai';

// 4-variant tonal caption generator for the vlog editor. Implements
// docs/buffr-caption-variants-plan.md §2 (the system prompt converted from
// the user's tonal-style sample). Single LLM call emits four variants of
// the same day in different voices.

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OPENAI_MODEL = 'gpt-4o';
const MAX_TOKENS = 768;

// Bump on meaningful prompt or output-format changes.
const PROMPT_VERSION = 'caption-v2';

const SYSTEM_PROMPT = `You generate four variant captions for a daily vlog from the user's raw log. Each variant is the same 3-line body about the same day, written in a different tonal voice. The user picks which voice to publish.

OUTPUT: a single valid JSON object with EXACTLY this shape:

{
  "clean":      "Line1\\nLine2\\nLine3",
  "smoother":   "Line1\\nLine2\\nLine3",
  "reflective": "Line1\\nLine2\\nLine3",
  "punchy":     "Line1\\nLine2\\nLine3",
  "detectedTheme": "growth" | "discipline" | "clarity" | "struggle" | "shift" | "curiosity"
}

No prose preamble, no markdown fences, no commentary. JSON only.

VARIANT VOICES — distinct per key:

clean (default voice):
  Present-progressive, observational, plain. Direct sentences.
  No hedging like "really" / "kind of". No "feels like".
  Example body:
    Realizing how much words shape understanding
    Spent the morning digging into technical terms and concepts
    Starting to see communication as the bridge between thought and expression

smoother:
  Conversational, slightly hedged, gentle. Use "really" / "kind of"
  / "feels like" sparingly to soften observations.
  Example body:
    Been realizing how important words are in shaping understanding
    Spent the morning studying technical concepts and terminology
    Communication really feels like the bridge between ideas and expression

reflective:
  Contemplative. Mix past-tense action ("Spent the morning…", "Morning
  spent…") with present-tense realization ("Realizing…", "Starting to
  appreciate…"). Slower pace, longer phrasing.
  Example body:
    Starting to appreciate the weight words carry
    Morning spent learning technical concepts and terminology
    Realizing communication is what connects thoughts to expression

punchy:
  Axiomatic and terse. Parallel structure across the three lines —
  same grammatical shape repeated. 2–5 words per line. No filler.
  Example body:
    Words shape understanding
    Concepts shape thinking
    Communication bridges both

UNIVERSAL RULES (apply to all four variants):
- Exactly 3 body lines, separated by a single newline.
- First-person implied — never write "I" / "you" / "we".
- No hashtags. No emojis. No "today I…" / "Today was…" framings.
- No questions, no exclamations.
- No motivational platitudes ("trust the process", "embrace the journey").
- Use specific nouns from the raw log when natural — "technical concepts",
  "the morning workout", "the buffr codebase". Don't invent details.
- All four variants describe the SAME day. Don't shift the topic between
  voices. Only the surface changes.

THEME DETECTION:
Pick one detectedTheme that best matches the day:
  growth      — learning, breakthrough, leveling-up
  discipline  — habits, repetition, showing up
  clarity     — understanding, finding the right framing
  struggle    — friction, blocked, pushing through
  shift       — pivot, realization, changed direction
  curiosity   — exploring, asking questions, going wide

INPUTS YOU'LL RECEIVE:
- date, rawLog (bullet list), mood (optional), recentCaptions (last 5), themeHint (optional)

If the rawLog is sparse (1–2 short lines), still emit four valid variants but keep them tight. Don't pad with invented content.

If you can't form a coherent caption from the raw log, return:
  { "error": "insufficient-input" }
…with no other keys.`;

function buildUserPrompt(input: CaptionInput): string {
  const lines: string[] = [];
  lines.push(`Raw log for ${input.date}:`);
  if (input.rawLog.length === 0) {
    lines.push('(no entries today)');
  } else {
    for (const item of input.rawLog) lines.push(`- ${item}`);
  }
  lines.push('');
  if (input.mood) lines.push(`Mood: ${input.mood}`);
  if (input.themeHint) lines.push(`Theme hint: ${input.themeHint}`);
  if (input.recentCaptions && input.recentCaptions.length > 0) {
    lines.push('');
    lines.push('Recent captions (avoid repeating phrasing or formula):');
    lines.push(input.recentCaptions.join('\n---\n'));
  }
  lines.push('');
  lines.push('Generate the four variants.');
  return lines.join('\n');
}

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
      response_format: { type: 'json_object' },
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

const VALID_THEMES: CaptionTheme[] = ['growth', 'discipline', 'clarity', 'struggle', 'shift', 'curiosity'];

function normalizeVariant(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3);
  if (lines.length === 0) return null;
  return lines.join('\n');
}

function parseAndValidate(text: string): CaptionVariantOutput | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (typeof obj.error === 'string') return null;

  const variants: Partial<Record<CaptionVariantKey, string>> = {};
  for (const key of CAPTION_VARIANT_KEYS) {
    const normalized = normalizeVariant(obj[key]);
    if (normalized) variants[key] = normalized;
  }
  if (CAPTION_VARIANT_KEYS.some(k => !variants[k])) return null;

  const themeRaw = typeof obj.detectedTheme === 'string'
    ? obj.detectedTheme.trim().toLowerCase()
    : '';
  const detectedTheme = (VALID_THEMES as string[]).includes(themeRaw) ? themeRaw : 'clarity';

  return {
    variants: variants as Record<CaptionVariantKey, string>,
    detectedTheme,
  };
}

async function runCaptionLLM(
  strictLocal: boolean,
  route: RouteChoice,
  system: string,
  user: string,
): Promise<{ text: string; model: string }> {
  if (strictLocal) {
    if (!(await shouldUseGemmaLocal('caption'))) {
      throw new Error('Strict local mode: on-device AI not ready');
    }
    const text = await callGemmaLocal('caption', system, user, MAX_TOKENS);
    return { text, model: GEMMA_LOCAL_MODEL };
  }

  if (route === 'on-device' && (await shouldUseGemmaLocal('caption'))) {
    try {
      const text = await callGemmaLocal('caption', system, user, MAX_TOKENS);
      return { text, model: GEMMA_LOCAL_MODEL };
    } catch (err) {
      console.warn('[buffr ai] caption gemma local failed, falling back to cloud:', err instanceof Error ? err.message : err);
    }
  }

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

export async function generateCaption(
  input: CaptionInput,
): Promise<{ output: CaptionVariantOutput | null; error?: string }> {
  const strictLocal = await getStrictLocalMode();
  const route = await getChainRoute('caption');

  const [claudeKey, openaiKey] = await Promise.all([getAnthropicKey(), getOpenAIKey()]);
  const cloudReady = !!claudeKey || !!openaiKey;
  const gemmaReady = await shouldUseGemmaLocal('caption');
  if (strictLocal && !gemmaReady) {
    return { output: null, error: 'Strict local mode: on-device AI not ready' };
  }
  if (!strictLocal && !gemmaReady && !cloudReady) {
    return { output: null, error: 'No API key configured' };
  }

  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(input);

  try {
    const cacheInput: CacheKeyInput = {
      chain: 'caption',
      provider: strictLocal ? 'on-device' : route,
      promptVersion: PROMPT_VERSION,
      system,
      user,
    };
    const { text } = await cachedCall(cacheInput, async () => {
      const r = await runCaptionLLM(strictLocal, route, system, user);
      return { text: r.text, modelServed: r.model };
    });
    const output = parseAndValidate(text);
    if (!output) return { output: null, error: 'Could not parse caption JSON' };
    return { output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[buffr ai] Caption error:', msg);
    return { output: null, error: msg };
  }
}
