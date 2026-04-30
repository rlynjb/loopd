import {
  getThreadById, getMentionsByThread, getAllEntries, getAllTodoMetas,
} from '../database';
import type { Thread, ThreadMention } from '../../types/thread';
import type { TodoType } from '../../types/todoMeta';

// Per-thread aggregate consumed by the thread detail page.
//
// Shape decisions:
//   - openTodos / doneTodos are flattened TodoItems (text + done + completedAt)
//     paired with their entry_date and todo_meta.type (for the badge). Sorted
//     by createdAt DESC.
//   - doneTodos capped at the most recent 5 (stale completed work isn't
//     interesting on the detail page; full history is in /todos).
//   - entryMentions are line excerpts where the tag appeared in entry prose.
//     One row per mention; if a mention's source_line is stale (out of
//     bounds after edits), the excerpt falls back to the entry's first 100
//     chars to give the reader some context.
export type ThreadDetailTodo = {
  todoId: string;
  entryId: string;
  entryDate: string;
  text: string;
  done: boolean;
  completedAt: string | null;
  createdAt: string;
  type: TodoType;
};

export type ThreadDetailEntry = {
  mentionId: string;
  entryId: string;
  entryDate: string;
  excerpt: string;
};

export type ThreadDetail = {
  thread: Thread;
  openTodos: ThreadDetailTodo[];
  doneTodos: ThreadDetailTodo[];
  doneTotalCount: number;
  entryMentions: ThreadDetailEntry[];
  entriesThisWeek: number;
  lastMentionAt: string | null;
};

const DONE_LIMIT = 5;

export async function getThreadDetail(threadId: string): Promise<ThreadDetail | null> {
  const thread = await getThreadById(threadId);
  if (!thread) return null;

  const mentions = await getMentionsByThread(threadId, 1000);
  const entries = await getAllEntries();
  const metas = await getAllTodoMetas();
  const metaByTodoId = new Map(metas.map(m => [m.todoId, m]));

  // Build a lookup: todoId → { entryId, entryDate, text, done, completedAt, createdAt }
  const todoLookup = new Map<string, {
    entryId: string;
    entryDate: string;
    text: string;
    done: boolean;
    completedAt: string | null;
    createdAt: string;
  }>();
  // Also per-entry text for entry-mention excerpts.
  const entryById = new Map(entries.map(e => [e.id, e]));
  for (const e of entries) {
    for (const t of e.todos ?? []) {
      todoLookup.set(t.id, {
        entryId: e.id,
        entryDate: e.date,
        text: t.text,
        done: t.done,
        completedAt: t.completedAt,
        createdAt: t.createdAt ?? e.createdAt,
      });
    }
  }

  const seenTodoIds = new Set<string>();
  const openTodos: ThreadDetailTodo[] = [];
  const doneTodos: ThreadDetailTodo[] = [];
  const entryMentions: ThreadDetailEntry[] = [];

  for (const m of mentions) {
    if (m.todoId) {
      if (seenTodoIds.has(m.todoId)) continue; // dedupe — same todo may have multiple mentions
      const t = todoLookup.get(m.todoId);
      if (!t) continue; // todo was deleted; mention is a tombstone
      seenTodoIds.add(m.todoId);
      const meta = metaByTodoId.get(m.todoId);
      const item: ThreadDetailTodo = {
        todoId: m.todoId,
        entryId: t.entryId,
        entryDate: t.entryDate,
        text: t.text,
        done: t.done,
        completedAt: t.completedAt,
        createdAt: t.createdAt,
        type: meta?.type ?? 'todo',
      };
      (t.done ? doneTodos : openTodos).push(item);
    } else if (m.entryId) {
      const e = entryById.get(m.entryId);
      const excerpt = extractExcerpt(e?.text ?? null, m.sourceLine);
      entryMentions.push({
        mentionId: m.id,
        entryId: m.entryId,
        entryDate: m.entryDate,
        excerpt,
      });
    }
  }

  openTodos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  doneTodos.sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt));
  entryMentions.sort((a, b) => b.entryDate.localeCompare(a.entryDate));

  // Entries-this-week count: distinct entry_ids whose entry_date is in the
  // current ISO week.
  const weekStart = startOfISOWeek(new Date());
  const distinctEntryIdsThisWeek = new Set<string>();
  for (const m of mentions) {
    if (m.entryId && m.entryDate >= weekStart) distinctEntryIdsThisWeek.add(m.entryId);
  }

  const lastMentionAt = mentions.length > 0
    ? mentions.map(m => m.createdAt).sort().pop() ?? null
    : null;

  return {
    thread,
    openTodos,
    doneTodos: doneTodos.slice(0, DONE_LIMIT),
    doneTotalCount: doneTodos.length,
    entryMentions,
    entriesThisWeek: distinctEntryIdsThisWeek.size,
    lastMentionAt,
  };
}

// Pull the line at `sourceLine`, trimmed, capped at ~140 chars so the page
// stays scannable. If the line is out of bounds (the entry was edited and
// the mention is stale), fall back to the first non-empty line.
function extractExcerpt(text: string | null, sourceLine: number): string {
  if (!text) return '';
  const lines = text.split('\n');
  const candidate = lines[sourceLine] ?? lines.find(l => l.trim().length > 0) ?? '';
  const trimmed = candidate.trim();
  return trimmed.length > 140 ? trimmed.slice(0, 137) + '…' : trimmed;
}

function startOfISOWeek(date: Date): string {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}
