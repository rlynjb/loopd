import { getProvider, getAnthropicKey, getOpenAIKey } from './config';
import type { Interpretation } from '../../types/ai';

// Per docs/interpret-spec.md §model-config.
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OPENAI_MODEL = 'gpt-4o';
const MAX_TOKENS = 800;
const TEMPERATURE = 0.7;

export const MIN_TEXT_LENGTH = 20;
export const MAX_INPUT_CHARS = 2000;

const SYSTEM_PROMPT = `You are an emotionally intelligent journal interpreter.

Analyze the user's journal entry and explain what it may
reveal about their mindset, emotional patterns, values,
and deeper themes.

Do not diagnose. Do not judge. Do not over-motivate.
Keep the tone calm, grounded, reflective, and honest.

Use this exact structure and return valid JSON only —
no preamble, no explanation outside the JSON:

{
  "mainInterpretation": "2–4 sentences on the deeper meaning",
  "coreThemes": [
    { "label": "Theme name", "explanation": "One sentence" },
    { "label": "Theme name", "explanation": "One sentence" },
    { "label": "Theme name", "explanation": "One sentence" }
  ],
  "emotionalPattern": "One paragraph explaining the repeating emotional or behavioural pattern",
  "healthyReframe": "Rewrite the intense or protective thought into a more grounded version",
  "keyTakeaway": "One powerful insight the user can carry forward"
}

Tone rules:
  → Calm, honest, reflective, emotionally intelligent
  → Not clinical, not motivational, not judgmental
  → Never diagnose or label the user
  → Never say: "you have trauma", "you are paranoid", "you need therapy", "this is unhealthy"
  → Prefer language like: "this sounds like…", "a theme here is…", "this may reflect…", "a healthier framing could be…"

Minimum 3 core themes, maximum 5.`;

export type InterpretResult =
  | { ok: true; interpretation: Interpretation }
  | { ok: false; reason: 'no-ai' | 'too-short' | 'malformed' | 'network'; message?: string };

// Keep the most recent 2000 chars — per spec §Input. The user's most recent
// thought matters more than older sentences from earlier in the day.
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
      response_format: { type: 'json_object' },
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

function parseJson(raw: string): unknown | null {
  try {
    const cleaned = raw.replace(/```(?:json)?\s*|```\s*/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Validate the parsed JSON against the spec shape. Required fields must be
// non-empty strings; coreThemes must be a non-empty array of {label,
// explanation} pairs. Returns null on shape mismatch — caller retries once.
function validate(data: unknown, sourceText: string, model: string): Interpretation | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  const str = (k: string): string | null =>
    typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : null;

  const main = str('mainInterpretation');
  const pattern = str('emotionalPattern');
  const reframe = str('healthyReframe');
  const takeaway = str('keyTakeaway');
  if (!main || !pattern || !reframe || !takeaway) return null;

  if (!Array.isArray(o.coreThemes)) return null;
  const coreThemes = (o.coreThemes as unknown[])
    .map(t => {
      if (!t || typeof t !== 'object') return null;
      const obj = t as Record<string, unknown>;
      const label = typeof obj.label === 'string' ? obj.label.trim() : '';
      const explanation = typeof obj.explanation === 'string' ? obj.explanation.trim() : '';
      if (!label || !explanation) return null;
      return { label, explanation };
    })
    .filter((t): t is { label: string; explanation: string } => t !== null);
  if (coreThemes.length === 0) return null;

  return {
    mainInterpretation: main,
    coreThemes,
    emotionalPattern: pattern,
    healthyReframe: reframe,
    keyTakeaway: takeaway,
    sourceText,
    generatedAt: new Date().toISOString(),
    model,
  };
}

// Run the interpretation chain for a single piece of journal text. Provider
// follows the user's configured preference (Claude → OpenAI fallback). One
// retry on malformed JSON with a stricter system instruction. Snapshots
// `sourceText` (the truncated input that actually reached the model) so the
// modal can detect staleness later.
export async function interpretEntry(rawText: string): Promise<InterpretResult> {
  const text = rawText.trim();
  if (text.length < MIN_TEXT_LENGTH) return { ok: false, reason: 'too-short' };

  const provider = await getProvider();
  const apiKey = provider === 'openai' ? await getOpenAIKey() : await getAnthropicKey();
  if (!apiKey) return { ok: false, reason: 'no-ai' };

  const truncated = truncateTail(text, MAX_INPUT_CHARS);
  const useOpenAI = provider === 'openai';
  const modelId = useOpenAI ? OPENAI_MODEL : CLAUDE_MODEL;

  const callOnce = async (extra?: string): Promise<Interpretation | null> => {
    const userMsg = extra ? `${truncated}\n\n${extra}` : truncated;
    try {
      const raw = useOpenAI
        ? await callOpenAI(apiKey, userMsg)
        : await callClaude(apiKey, userMsg);
      const parsed = parseJson(raw);
      return parsed ? validate(parsed, truncated, modelId) : null;
    } catch (err) {
      throw err;
    }
  };

  try {
    let interp = await callOnce();
    if (!interp) {
      interp = await callOnce('Your previous reply was not valid JSON for the schema. Re-emit ONLY a single JSON object that exactly matches the schema. No commentary.');
    }
    if (!interp) return { ok: false, reason: 'malformed' };
    return { ok: true, interpretation: interp };
  } catch (err) {
    return {
      ok: false,
      reason: 'network',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
