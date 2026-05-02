import { getAnthropicKey, getOpenAIKey, getProvider } from './config';
import type { CaptionInput, CaptionOutput, CaptionTheme } from '../../types/ai';

// Relatable-caption generator for the vlog editor. Implements
// docs/relatable-caption-spec.md verbatim — system + user prompt, JSON
// output, edge-case handling.
//
// Lives as a separate call from summarize() so the structured editor data
// (clip order, trims, filters) and the human-feeling caption don't share a
// long prompt. Cleaner separation, independently retryable, and the
// caption prompt can stay strict on its forbidden patterns without bleeding
// into the editor composition logic.

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OPENAI_MODEL = 'gpt-4o';

const SYSTEM_PROMPT = `You are the caption writer for loopd, a daily vlog journal app. Your job is to turn a user's raw daily log into a short, reflective caption that reads like an authentic personal thought — not a summary.

CORE PRINCIPLE: Turn actions into realizations.

STRUCTURE (always 3 beats):
1. Hook — an emotion, realization, or noticing (internal state, not action)
2. Light summary — 1–2 actions max, simplified
3. Reflection — what's shifting, clicking, or becoming clearer

RATIO: ~70% feeling/reflection, ~30% what was done.

VOICE:
- Grounded, calm, reflective
- First person, present-progressive ("noticing", "realizing", "starting to")
- Specific enough to feel real, never vague
- 2–4 lines total, TikTok-readable

NEVER:
- Start with "Today I…"
- List more than 2 actions
- Use hustle language ("crushed", "shipped", "executed", "locked in")
- Use motivational closers or hashtags
- Use self-help phrasing ("the journey", "trust the process")
- Overexplain the lesson

FORMULAS (rotate across days; check recent captions to avoid repetition):
A) "Lately I've been noticing ___ / Today I ___ / I think I'm starting to ___"
B) "Realizing ___ / [actions] / [shift]"
C) "Feels like ___ / [what happened] / [what it means]"

EDGE CASES:
- Empty rawLog → caption based purely on mood or a generic noticing; do not fabricate actions
- Very long log (10+ items) → pick the 1–2 most thematically connected items; ignore the rest
- Highly emotional mood (e.g. "burnt out", "grieving") → drop the action beat entirely; deliver a 2-line reflection only
- Only ideas (no actions) → reframe ideas as "noticing I keep coming back to…" rather than "did"
- Repetitive day (same as yesterday) → lean into the repetition itself as the reflection

OUTPUT FORMAT (strict JSON, no markdown fences):
{
  "caption": "string — 2–4 lines, \\n separated",
  "alternate": "string — shorter 2-line version",
  "detectedTheme": "growth|discipline|clarity|struggle|shift|curiosity"
}

Return ONLY the JSON object. No preamble, no explanation.`;

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
  lines.push('Generate the caption.');
  return lines.join('\n');
}

async function callClaude(apiKey: string, system: string, user: string): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 512,
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
      max_tokens: 512,
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

function parseAndValidate(text: string): CaptionOutput | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const caption = typeof obj.caption === 'string' ? obj.caption.trim() : '';
    const alternate = typeof obj.alternate === 'string' ? obj.alternate.trim() : '';
    const themeRaw = typeof obj.detectedTheme === 'string' ? obj.detectedTheme.trim().toLowerCase() : '';
    const detectedTheme = (VALID_THEMES as string[]).includes(themeRaw) ? themeRaw : 'clarity';
    if (!caption) return null;
    return {
      // Soft caps — the spec says 2–4 lines, but the model usually obeys. We
      // truncate gently rather than reject so the editor still gets something.
      caption: caption.split('\n').slice(0, 4).join('\n'),
      alternate: alternate ? alternate.split('\n').slice(0, 2).join('\n') : '',
      detectedTheme,
    };
  } catch {
    return null;
  }
}

export async function generateCaption(input: CaptionInput): Promise<{ output: CaptionOutput | null; error?: string }> {
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
