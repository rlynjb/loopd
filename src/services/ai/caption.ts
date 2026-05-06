import { getAnthropicKey, getOpenAIKey, getProvider } from './config';
import {
  CAPTION_VARIANT_KEYS,
  type CaptionInput,
  type CaptionTheme,
  type CaptionVariantKey,
  type CaptionVariantOutput,
} from '../../types/ai';

// 4-variant tonal caption generator for the vlog editor. Implements
// docs/loopd-caption-variants-plan.md §2 (the system prompt converted from
// the user's tonal-style sample). Single LLM call emits four variants of
// the same day in different voices.
//
// Lives as a separate call from summarize() so the structured editor data
// (clip order, trims, filters) and the human-feeling caption don't share a
// long prompt. Cleaner separation, independently retryable, and the
// caption prompt can stay strict on its forbidden patterns without bleeding
// into the editor composition logic.

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OPENAI_MODEL = 'gpt-4o';

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
  "the morning workout", "the loopd codebase". Don't invent details.
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
    // 4 variants × ~30 tokens + theme + JSON overhead ≈ 200–300 tokens.
    // 768 leaves headroom for verbose models without runaway cost.
    max_tokens: 768,
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
      max_tokens: 768,
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
  // Soft cap at 3 lines — the prompt asks for exactly 3 but models drift.
  // Take the first 3 non-empty lines.
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

  // Insufficient-input escape hatch from the prompt.
  if (typeof obj.error === 'string') return null;

  const variants: Partial<Record<CaptionVariantKey, string>> = {};
  for (const key of CAPTION_VARIANT_KEYS) {
    const normalized = normalizeVariant(obj[key]);
    if (normalized) variants[key] = normalized;
  }
  // Require all four variants — partial output is treated as malformed.
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

export async function generateCaption(
  input: CaptionInput,
): Promise<{ output: CaptionVariantOutput | null; error?: string }> {
  const provider = await getProvider();
  const apiKey = provider === 'openai' ? await getOpenAIKey() : await getAnthropicKey();
  if (!apiKey) return { output: null, error: 'No API key configured' };

  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(input);

  try {
    const text = provider === 'openai'
      ? await callOpenAI(apiKey, system, user)
      : await callClaude(apiKey, system, user);
    const output = parseAndValidate(text);
    if (!output) return { output: null, error: 'Could not parse caption JSON' };
    return { output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[loopd ai] Caption error:', msg);
    return { output: null, error: msg };
  }
}
