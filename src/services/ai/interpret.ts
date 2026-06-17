import {
  getProvider, getAnthropicKey, getOpenAIKey,
  getStrictLocalMode, getChainRoute,
  type RouteChoice,
} from './config';
import {
  callGemmaLocal, shouldUseGemmaLocal,
  GEMMA_LOCAL_MODEL,
} from './providers/gemma';
import { orchestrateCloud } from './providers/cloud';
import { cachedCall, type CacheKeyInput } from './cache';
import type { Interpretation } from '../../types/ai';

// Long-form interpretation chain. Output is markdown — multi-section essay
// with emoji-prefixed H2 headings, blockquoted impact lines, bulleted
// thinking, occasional bold inline emphasis, and a final "strongest line +
// final thought" kicker. The structure is suggested, not rigid: the model
// follows the user's actual content rather than padding empty sections.
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OPENAI_MODEL = 'gpt-4o';
const MAX_TOKENS = 1800;
const TEMPERATURE = 0.7;

// Bump on meaningful prompt or output-format changes.
const PROMPT_VERSION = 'interpret-v2';

export const MIN_TEXT_LENGTH = 20;
export const MAX_INPUT_CHARS = 2000;

const SYSTEM_PROMPT = `You are an emotionally intelligent journal interpreter. The user has written a journal entry; your job is to mirror it back to them in long-form prose that helps them see what's underneath their own words.

You are not a therapist. You are not a coach. You are a calm, observant friend who reads carefully and reflects honestly. Never diagnose. Never use clinical labels ("trauma", "paranoid", "anxious", "avoidant"). Never moralize, never motivate, never lecture.

Output valid markdown — no preamble, no JSON, no code fences around the whole thing. Use this approximate structure (skip any section that doesn't fit the user's actual content; do not pad):

  • Opening: 1–2 sentences naming what the entry sounds like, with one bolded re-statement of the underlying drive in their voice.
  • A blockquote on its own line with that drive, e.g. > **"I can't afford to lose momentum or dependence on myself."**
  • A horizontal rule (---)
  • ## 🧠 Main themes I see — followed by 2–4 numbered subsections (### 1. <Theme name>, ### 2. <Theme name>, ...). Each names a theme, then unpacks it with a mix of: short paragraphs, bulleted lists ("- thing", "- thing"), bolded one-line re-statements, and a blockquote pulling the user's own line that gave you that read.
  • ## ⚖️ Healthy side of this — what this mindset gives them. Bullets.
  • ## ⚠️ The part to watch carefully — gentle, never alarmist. Use a "stay X vs never feel Y" comparison, not a warning.
  • ## 🧠 Your deeper fear (I think) — short. Say what it isn't, then what it likely is, in a blockquote.
  • ## 💡 What's actually happening — a wider read on the entry's emotional architecture.
  • ## 🔑 My honest interpretation — one or two lines, blockquoted, that crystallize the whole thing.
  • ## 🧭 The healthiest version of this mindset — show "Not: X / But: Y" with both quoted.
  • ## 💬 The strongest line in everything you wrote — pull the literal user line that carries the most weight, blockquote it, then one sentence on why.
  • ## 🧠 Final thought — close warmly. Bullet what they're really building. End on what those things represent to them.

Voice rules:
  • Conversational and grounded. Short paragraphs. Visual whitespace between thoughts. Use blockquotes liberally for impact lines and for the user's own quoted phrases.
  • Use markdown bold (**…**) for one-line distillations of underlying drives.
  • Use bullet lists ("- item") for "you're using X / Y / Z" parallel structures and for "what they're building" summaries.
  • Use horizontal rules (---) between major sections.
  • Speak in first person ("I see…", "this tells me…", "probably…"). Hedge ("probably", "I think", "this may reflect") rather than assert.
  • Quote the user back to themselves in their own words when you have something specific to point to.
  • Never recommend therapy, journaling more, productivity systems, or any external tool.
  • Never start with "Today you…" or "It sounds like you…" formulaically. Start with what the entry actually reads as.

If the entry is short, light, or doesn't carry deep emotional content, drop sections. A 3-section interpretation of a flat day is better than a forced 11-section read of nothing.

Return ONLY the markdown body. No preface, no signoff, no JSON wrapper.`;

export type InterpretResult =
  | { ok: true; interpretation: Interpretation }
  | { ok: false; reason: 'no-ai' | 'too-short' | 'malformed' | 'network'; message?: string };

function truncateTail(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(s.length - max);
}

async function callClaude(apiKey: string, user: string): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const r = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `User journal entry:\n${user}` }],
  });
  return r.content[0]?.type === 'text' ? r.content[0].text : '';
}

async function callOpenAI(apiKey: string, user: string): Promise<string> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `User journal entry:\n${user}` },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function cleanMarkdown(raw: string): string | null {
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:markdown|md)?\s*\n?/i, '');
    s = s.replace(/\n?```\s*$/i, '');
    s = s.trim();
  }
  if (!s || s.length < 20) return null;
  return s;
}

// Routes the interpret LLM call. The existing callClaude/callOpenAI take
// only `user` and add the "User journal entry:\n" prefix internally — for
// the Gemma side we build the prefix once and pass system + fullUser
// directly to callGemmaLocal.
async function runInterpretLLM(
  strictLocal: boolean,
  route: RouteChoice,
  truncatedText: string,
): Promise<{ text: string; model: string }> {
  const fullUser = `User journal entry:\n${truncatedText}`;

  if (strictLocal) {
    if (!(await shouldUseGemmaLocal('interpret'))) {
      throw new Error('Strict local mode: on-device AI not ready');
    }
    const text = await callGemmaLocal('interpret', SYSTEM_PROMPT, fullUser, MAX_TOKENS, TEMPERATURE);
    return { text, model: GEMMA_LOCAL_MODEL };
  }

  if (route === 'on-device' && (await shouldUseGemmaLocal('interpret'))) {
    try {
      const text = await callGemmaLocal('interpret', SYSTEM_PROMPT, fullUser, MAX_TOKENS, TEMPERATURE);
      return { text, model: GEMMA_LOCAL_MODEL };
    } catch (err) {
      console.warn('[buffr ai] interpret gemma local failed, falling back to cloud:', err instanceof Error ? err.message : err);
    }
  }

  const primary = await getProvider();
  const [claudeKey, openaiKey] = await Promise.all([getAnthropicKey(), getOpenAIKey()]);
  const { result: text, servedBy } = await orchestrateCloud({
    primary,
    callClaude: () => callClaude(claudeKey ?? '', truncatedText),
    callOpenAI: () => callOpenAI(openaiKey ?? '', truncatedText),
    hasClaudeKey: !!claudeKey,
    hasOpenAIKey: !!openaiKey,
  });
  return { text, model: servedBy === 'claude' ? CLAUDE_MODEL : OPENAI_MODEL };
}

// Run the interpretation chain for a single piece of journal text.
// Snapshots `sourceText` (the truncated input that actually reached the
// model) so the modal can detect staleness later.
export async function interpretEntry(rawText: string): Promise<InterpretResult> {
  const text = rawText.trim();
  if (text.length < MIN_TEXT_LENGTH) return { ok: false, reason: 'too-short' };

  const strictLocal = await getStrictLocalMode();
  const route = await getChainRoute('interpret');

  const [claudeKey, openaiKey] = await Promise.all([getAnthropicKey(), getOpenAIKey()]);
  const cloudReady = !!claudeKey || !!openaiKey;
  const gemmaReady = await shouldUseGemmaLocal('interpret');
  if (strictLocal && !gemmaReady) {
    return { ok: false, reason: 'no-ai', message: 'Strict local mode: on-device AI not ready' };
  }
  if (!strictLocal && !gemmaReady && !cloudReady) {
    return { ok: false, reason: 'no-ai' };
  }

  const truncated = truncateTail(text, MAX_INPUT_CHARS);

  try {
    const cacheInput: CacheKeyInput = {
      chain: 'interpret',
      provider: strictLocal ? 'on-device' : route,
      promptVersion: PROMPT_VERSION,
      system: SYSTEM_PROMPT,
      user: truncated,
    };
    const { text: raw, modelServed: modelId } = await cachedCall(cacheInput, async () => {
      const r = await runInterpretLLM(strictLocal, route, truncated);
      return { text: r.text, modelServed: r.model };
    });
    const md = cleanMarkdown(raw);
    if (!md) return { ok: false, reason: 'malformed' };

    return {
      ok: true,
      interpretation: {
        markdown: md,
        sourceText: truncated,
        generatedAt: new Date().toISOString(),
        model: modelId,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No API key') || msg.includes('Strict local mode')) {
      return { ok: false, reason: 'no-ai', message: msg };
    }
    return { ok: false, reason: 'network', message: msg };
  }
}
