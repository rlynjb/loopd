import type { Entry, TodoItem } from '../../types/entry';
import {
  getEntryById,
  insertEntry,
  updateEntry,
  deleteEntry,
  getEntriesByDate,
  enqueueSyncDeletion,
} from '../database';
import { generateId } from '../../utils/id';
import { getTodayString } from '../../utils/time';
import { rewriteTodoLine } from './scanTodos';

// Add a todo to an existing entry (if `entryId` is given) or to today's
// shared todos-bucket entry. The bucket is a todos-only entry (no text, no
// clips, no habits) that accumulates all dashboard-added todos for the day —
// prevents the journal from filling up with one entry per todo.
export async function addTodo(
  text: string,
  entryId?: string,
): Promise<{ todo: TodoItem; entryId: string }> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Todo text is required');

  const todo: TodoItem = {
    id: generateId('todo'),
    text: trimmed,
    done: false,
    completedAt: null,
    createdAt: new Date().toISOString(),
  };

  if (entryId) {
    const existing = await getEntryById(entryId);
    if (!existing) throw new Error(`Entry ${entryId} not found`);
    await updateEntry({ ...existing, todos: [...(existing.todos ?? []), todo] });
    return { todo, entryId };
  }

  // Find today's todos-only bucket (if any) and append to it.
  const today = getTodayString();
  const todaysEntries = await getEntriesByDate(today);
  const bucket = todaysEntries.find(e =>
    !e.text
    && e.clips.length === 0
    && !e.clipUri
    && e.habits.length === 0
    && (e.todos?.length ?? 0) > 0,
  );
  if (bucket) {
    await updateEntry({ ...bucket, todos: [...(bucket.todos ?? []), todo] });
    return { todo, entryId: bucket.id };
  }

  // No bucket yet — create one.
  const newEntry: Entry = {
    id: generateId('entry'),
    date: today,
    text: null,
    habits: [],
    todos: [todo],
    clipUri: null,
    clipDurationMs: null,
    clips: [],
    createdAt: new Date().toISOString(),
  };
  await insertEntry(newEntry);
  return { todo, entryId: newEntry.id };
}

// Apply a partial update to one todo inside an entry. Setting `done` flips
// `completedAt` to the current ISO time; clearing it nulls completedAt.
export async function updateTodo(
  entryId: string,
  todoId: string,
  updates: Partial<Pick<TodoItem, 'text' | 'done'>>,
): Promise<void> {
  const entry = await getEntryById(entryId);
  if (!entry) throw new Error(`Entry ${entryId} not found`);
  const now = new Date().toISOString();

  const targetTodo = (entry.todos ?? []).find(t => t.id === todoId);
  const todos = (entry.todos ?? []).map(t => {
    if (t.id !== todoId) return t;
    const next: TodoItem = { ...t, ...updates };
    if ('done' in updates) {
      next.completedAt = updates.done ? now : null;
    }
    return next;
  });

  // Round-trip the done/text change into the source prose so the "[]" line
  // in the journal reflects the new state next time it's viewed.
  const nextText = targetTodo
    ? rewriteTodoLine(entry.text, targetTodo, updates)
    : entry.text;

  await updateEntry({ ...entry, text: nextText, todos });
}

// Remove a todo. If the entry becomes empty (no text, no clips, no habits, no
// other todos), delete the entry itself so the ranker and Notion sync stop
// seeing it. If the removed todo was synced to Notion as its own page,
// enqueue a sync_deletion so the next Notion sync archives the page.
export async function deleteTodo(entryId: string, todoId: string): Promise<void> {
  const entry = await getEntryById(entryId);
  if (!entry) return;
  const removed = (entry.todos ?? []).find(t => t.id === todoId);
  const todos = (entry.todos ?? []).filter(t => t.id !== todoId);

  if (removed?.notionPageId) {
    await enqueueSyncDeletion('todo', todoId, removed.notionPageId);
  }

  const wouldBeEmpty =
    !entry.text &&
    entry.clips.length === 0 &&
    !entry.clipUri &&
    entry.habits.length === 0 &&
    todos.length === 0;
  if (wouldBeEmpty) {
    await deleteEntry(entry.id);
    return;
  }
  await updateEntry({ ...entry, todos });
}

// Convenience for callsites that want to render the current state of all
// todos across all dates (the /todos screen, SmartTodoList on the dashboard).
export async function getAllEntriesWithTodos(): Promise<Entry[]> {
  const { getAllEntries } = await import('../database');
  const all = await getAllEntries();
  return all.filter(e => (e.todos?.length ?? 0) > 0);
}

// Re-export for completeness — some callers just want today's entries.
export { getEntriesByDate };
