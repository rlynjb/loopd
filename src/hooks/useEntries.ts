import { useCallback, useEffect, useState } from 'react';
import type { Entry } from '../types/entry';
import { getEntriesByDate, insertEntry, updateEntry, deleteEntry } from '../services/database';
import { scanTodosFromText } from '../services/todos/scanTodos';
import { reconcileTodoMetaForEntry } from '../services/todos/reconcileMeta';
import { scanNutritionForEntry } from '../services/nutrition/scanNutrition';

// Commit-level helper: run the checkbox-drop scan on the entry's text so any
// "[] foo" / "[x] foo" lines are reflected in todos_json. Silent keystroke
// saves go straight to updateEntry in the database layer and bypass this —
// that's intentional so we don't churn todos mid-word.
function applyTodoScan(entry: Entry): Entry {
  return { ...entry, todos: scanTodosFromText(entry.text, entry.todos ?? []) };
}

// Fire-and-forget nutrition scan. Runs after the entry itself has been saved,
// so a scanner failure can't break the journal's save.
function scheduleNutritionScan(entry: Entry): void {
  scanNutritionForEntry(entry.id, entry.date, entry.text).catch(err => {
    console.warn('[nutrition] scan failed:', err);
  });
}

// Same fire-and-forget pattern for the todo_meta reconcile — keeps the
// 1:1 invariant between todos_json and todo_meta. Self-heals on next
// commit if it fails mid-reconcile.
function scheduleTodoMetaReconcile(entry: Entry): void {
  reconcileTodoMetaForEntry(entry).catch(err => {
    console.warn('[todo-meta reconcile] schedule failed:', err);
  });
}

export function useEntries(date: string) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await getEntriesByDate(date);
    setEntries(result);
    setLoading(false);
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  const addEntry = useCallback(async (entry: Entry) => {
    const scanned = applyTodoScan(entry);
    await insertEntry(scanned);
    setEntries(prev => [...prev, scanned]);
    scheduleNutritionScan(scanned);
    scheduleTodoMetaReconcile(scanned);
  }, []);

  const editEntry = useCallback(async (entry: Entry) => {
    const scanned = applyTodoScan(entry);
    await updateEntry(scanned);
    setEntries(prev => prev.map(e => e.id === scanned.id ? scanned : e));
    scheduleNutritionScan(scanned);
    scheduleTodoMetaReconcile(scanned);
  }, []);

  const removeEntry = useCallback(async (id: string) => {
    await deleteEntry(id);
    setEntries(prev => prev.filter(e => e.id !== id));
  }, []);

  return { entries, loading, addEntry, editEntry, removeEntry, reload: load };
}
