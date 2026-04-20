import type { Entry, TodoItem } from '../../types/entry';
import {
  getEntryById,
  insertEntry,
  updateEntry,
  deleteEntry,
  getEntriesByDate,
} from '../database';
import { generateId } from '../../utils/id';
import { getTodayString } from '../../utils/time';

// Add a todo to an existing entry, or create a fresh today-dated entry holding
// just this todo if no `entryId` is given. Sets `createdAt` so the ranker can
// surface newer todos; returns the new TodoItem (with id + createdAt filled).
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

  // No target entry — drop this todo into today's journal as a fresh entry.
  const today = getTodayString();
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
  updates: Partial<Pick<TodoItem, 'text' | 'done' | 'pinned'>>,
): Promise<void> {
  const entry = await getEntryById(entryId);
  if (!entry) throw new Error(`Entry ${entryId} not found`);
  const now = new Date().toISOString();
  const todos = (entry.todos ?? []).map(t => {
    if (t.id !== todoId) return t;
    const next: TodoItem = { ...t, ...updates };
    if ('done' in updates) {
      next.completedAt = updates.done ? now : null;
    }
    return next;
  });
  await updateEntry({ ...entry, todos });
}

// Remove a todo. If the entry becomes empty (no text, no clips, no habits, no
// other todos), delete the entry itself so the ranker and Notion sync stop
// seeing it.
export async function deleteTodo(entryId: string, todoId: string): Promise<void> {
  const entry = await getEntryById(entryId);
  if (!entry) return;
  const todos = (entry.todos ?? []).filter(t => t.id !== todoId);
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
