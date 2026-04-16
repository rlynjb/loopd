import { getAnthropicKey, getOpenAIKey, getProvider } from './config';
import { buildPrompt } from './prompt';
import { validateSummary } from './validate';
import { getEntriesByDate, upsertAISummary } from '../database';
import type { AISummary } from '../../types/ai';

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OPENAI_MODEL = 'gpt-4o';

async function callClaude(apiKey: string, system: string, user: string): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
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
      max_tokens: 1024,
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

export async function summarize(date: string): Promise<{ summary: AISummary | null; error?: string }> {
  const provider = await getProvider();
  const apiKey = provider === 'openai' ? await getOpenAIKey() : await getAnthropicKey();
  if (!apiKey) return { summary: null, error: 'No API key configured' };

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
  const model = provider === 'openai' ? OPENAI_MODEL : CLAUDE_MODEL;

  try {
    const text = provider === 'openai'
      ? await callOpenAI(apiKey, system, user)
      : await callClaude(apiKey, system, user);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { summary: null, error: 'No JSON in response' };

    const parsed = JSON.parse(jsonMatch[0]);
    const { summary, errors } = validateSummary(parsed, clipIds, clipDurations);
    if (errors.length > 0) console.warn('[loopd ai] Validation warnings:', errors);

    await upsertAISummary(date, JSON.stringify(summary), model);
    return { summary };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[loopd ai] Summarize error:', msg);
    return { summary: null, error: msg };
  }
}

export async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  const provider = await getProvider();
  const apiKey = provider === 'openai' ? await getOpenAIKey() : await getAnthropicKey();
  if (!apiKey) return { ok: false, error: 'No API key' };

  try {
    if (provider === 'openai') {
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
