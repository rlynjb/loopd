import {
  getEntryById, getEntriesByDate, getAllEntries,
  getAISummary, getTodoMetasByEntry, getTodoMeta,
  updateTodoMeta,
} from '../database';
import { getProvider, getAnthropicKey, getOpenAIKey } from '../ai/config';
import { emit } from '../../utils/events';
import {
  getSystemPrompt, getUserMessage, type ExpansionContext,
} from './expandPrompts';
import { serializeExpansion } from './expandSerialize';
import type {
  TodoMeta, TodoExpansion, ExpandableType, IdeaExpansion, BugExpansion,
  QuestionExpansion, DecisionExpansion, KnowledgeExpansion, ContentExpansion,
} from '../../types/todoMeta';
import type { Entry, TodoItem } from '../../types/entry';

// Use the user's primary configured model (not the cheap classifier
// model) — expansion needs reasoning quality.
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const OPENAI_MODEL = 'gpt-4o';

// Cap concurrent expansions across the app. Each call is ~$0.04-0.05;
// stacking three is fine, more than that gets expensive fast.
const MAX_CONCURRENT = 3;
let _inFlight = new Set<string>();   // todoIds currently expanding
export function getExpandInFlight(): Set<string> { return new Set(_inFlight); }
export function isExpanding(todoId: string): boolean { return _inFlight.has(todoId); }
export const EXPAND_PROGRESS_EVENT = 'expand-progress';

async function callClaude(apiKey: string, system: string, user: string): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const r = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return r.content[0]?.type === 'text' ? r.content[0].text : '';
}

async function callOpenAI(apiKey: string, system: string, user: string): Promise<string> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function parseExpansionJson(raw: string): unknown | null {
  try {
    const cleaned = raw.replace(/```(?:json)?\s*|```\s*/g, '').trim();
    // Find the first {...} block — model may include leading reasoning text.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Validates the parsed JSON against the expected shape for the type. Returns
// null on shape mismatch — caller can retry once with a stricter prompt.
function validateExpansion(type: ExpandableType, data: unknown): TodoExpansion | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  const str = (k: string) => typeof o[k] === 'string' ? (o[k] as string).trim() : '';
  const arr = (k: string) => Array.isArray(o[k]) ? (o[k] as unknown[]).filter(x => typeof x === 'string').map(x => (x as string).trim()) : [];

  switch (type) {
    case 'idea': {
      const d: IdeaExpansion = {
        what: str('what'), why: str('why'),
        conditions: str('conditions'), firstStep: str('firstStep'),
      };
      if (!d.what || !d.why) return null;
      return { type, data: d };
    }
    case 'bug': {
      const d: BugExpansion = {
        observed: str('observed'), expected: str('expected'),
        suspectedCause: str('suspectedCause'), reproSteps: arr('reproSteps'),
      };
      if (!d.observed) return null;
      return { type, data: d };
    }
    case 'question': {
      const conf = (o.confidence as string)?.toLowerCase?.();
      if (conf !== 'high' && conf !== 'medium' && conf !== 'low') return null;
      const d: QuestionExpansion = {
        answer: str('answer'),
        confidence: conf,
        followUps: arr('followUps'),
        toVerify: str('toVerify'),
      };
      if (!d.answer) return null;
      return { type, data: d };
    }
    case 'decision': {
      const d: DecisionExpansion = {
        decision: str('decision'), reason: str('reason'),
        tradeoff: str('tradeoff'), revisitWhen: str('revisitWhen'),
      };
      if (!d.decision) return null;
      return { type, data: d };
    }
    case 'knowledge': {
      const d: KnowledgeExpansion = {
        concept: str('concept'), whereUsed: str('whereUsed'),
        whyItMatters: str('whyItMatters'), example: str('example'),
      };
      if (!d.concept) return null;
      return { type, data: d };
    }
    case 'content': {
      const fmt = (o.format as string)?.toLowerCase?.();
      const validFormats = ['post', 'video', 'thread', 'tutorial', 'vlog'] as const;
      if (!validFormats.includes(fmt as typeof validFormats[number])) return null;
      const d: ContentExpansion = {
        hook: str('hook'),
        keyPoints: arr('keyPoints'),
        format: fmt as ContentExpansion['format'],
        draftOutline: str('draftOutline'),
      };
      if (!d.hook) return null;
      return { type, data: d };
    }
  }
}

// Builds the surrounding-context block: the entry text the todo lives in,
// up to 5 sibling todos in the same entry, and the last 3 days of entries
// (excluding the todo's own date) with their cached AI summaries when present.
async function buildContext(meta: TodoMeta): Promise<ExpansionContext> {
  const entry = await getEntryById(meta.entryId);
  const entryText = entry?.text ?? '';

  // Sibling todos in same entry — newest 5
  let siblingTodos: ExpansionContext['siblingTodos'] = [];
  if (entry) {
    const siblings = await getTodoMetasByEntry(entry.id);
    const siblingMap = new Map(siblings.map(s => [s.todoId, s]));
    for (const t of (entry.todos ?? [])) {
      if (t.id === meta.todoId) continue;
      const s = siblingMap.get(t.id);
      siblingTodos.push({
        text: t.text,
        type: s?.type ?? 'todo',
        done: t.done,
      });
      if (siblingTodos.length >= 5) break;
    }
  }

  // Last 3 calendar days before the todo's entryDate, with their entries.
  const recentEntries: ExpansionContext['recentEntries'] = [];
  const all = await getAllEntries();
  const byDate = new Map<string, Entry[]>();
  for (const e of all) {
    if (e.date >= meta.entryDate) continue;
    const arr = byDate.get(e.date) ?? [];
    arr.push(e);
    byDate.set(e.date, arr);
  }
  const recentDates = [...byDate.keys()].sort().reverse().slice(0, 3);
  for (const date of recentDates) {
    const dayEntries = byDate.get(date) ?? [];
    const text = dayEntries.map(e => e.text ?? '').filter(Boolean).join('\n\n');
    let aiSummary: string | undefined;
    try {
      const cached = await getAISummary(date);
      if (cached) {
        const parsed = JSON.parse(cached.summaryJson);
        aiSummary = typeof parsed?.summary === 'string' ? parsed.summary : undefined;
      }
    } catch { /* ignore parse errors */ }
    recentEntries.push({ date, text, aiSummary });
  }

  return {
    entryDate: meta.entryDate,
    entryText,
    recentEntries,
    siblingTodos,
  };
}

export type ExpandResult =
  | { ok: true; expandedMd: string; model: string }
  | { ok: false; reason: 'no-ai' | 'in-flight-cap' | 'wrong-type' | 'malformed' | 'network' | 'not-found'; message?: string };

// Run expansion for a single todo. Loads context, calls the primary LLM,
// parses + validates JSON, retries once on malformed output with a stricter
// instruction, then serializes to markdown and writes back to todo_meta.
//
// Skips todos with type='todo' (no expansion shape exists for plain todos).
// Caller is responsible for refreshing UI state via the EXPAND_PROGRESS_EVENT.
export async function expandTodo(todoId: string, todoText: string): Promise<ExpandResult> {
  if (_inFlight.size >= MAX_CONCURRENT) {
    return { ok: false, reason: 'in-flight-cap' };
  }

  const meta = await getTodoMeta(todoId);
  if (!meta) return { ok: false, reason: 'not-found' };
  if (meta.type === 'todo') return { ok: false, reason: 'wrong-type' };

  const provider = await getProvider();
  const apiKey = provider === 'openai' ? await getOpenAIKey() : await getAnthropicKey();
  if (!apiKey) return { ok: false, reason: 'no-ai' };

  _inFlight.add(todoId);
  emit(EXPAND_PROGRESS_EVENT);

  try {
    const ctx = await buildContext(meta);
    const system = getSystemPrompt(meta.type as ExpandableType);
    const user = getUserMessage(todoText, ctx);
    const useOpenAI = provider === 'openai';
    const modelId = useOpenAI ? OPENAI_MODEL : CLAUDE_MODEL;

    const callOnce = async (extraInstruction?: string): Promise<TodoExpansion | null> => {
      const finalSystem = extraInstruction ? `${system}\n\n${extraInstruction}` : system;
      const raw = useOpenAI
        ? await callOpenAI(apiKey, finalSystem, user)
        : await callClaude(apiKey, finalSystem, user);
      const parsed = parseExpansionJson(raw);
      return parsed ? validateExpansion(meta.type as ExpandableType, parsed) : null;
    };

    let expansion = await callOnce();
    if (!expansion) {
      // Retry once with a stricter instruction.
      expansion = await callOnce('Your previous output was not valid JSON for the schema. Re-emit ONLY a single JSON object that exactly matches the schema. No commentary.');
    }
    if (!expansion) {
      return { ok: false, reason: 'malformed' };
    }

    const md = serializeExpansion(expansion);
    await updateTodoMeta(todoId, {
      expandedMd: md,
      expandedAt: new Date().toISOString(),
      model: modelId,
    });
    return { ok: true, expandedMd: md, model: modelId };
  } catch (err) {
    console.warn('[expand] failed:', err);
    return { ok: false, reason: 'network', message: err instanceof Error ? err.message : String(err) };
  } finally {
    _inFlight.delete(todoId);
    emit(EXPAND_PROGRESS_EVENT);
  }
}
