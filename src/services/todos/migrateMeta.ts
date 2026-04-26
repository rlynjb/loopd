import * as SecureStore from 'expo-secure-store';
import {
  getAllEntries, getAllTodoMetas, updateTodoMeta,
} from '../database';
import { reconcileTodoMetaForEntry } from './reconcileMeta';
import { classifyTodo, isClassifierAvailable } from './classify';
import type { TodoItem } from '../../types/entry';

// Bumping this key forces a re-run on next boot — useful if the heuristic
// rule set changes meaningfully.
const BACKFILL_KEY = 'todo_meta_backfill_v1_done';

// One-time backfill that walks every existing entry and runs the
// todo_meta reconcile against it. After this finishes:
//   - every TodoItem in todos_json has a paired todo_meta row
//   - heuristic-classifiable todos have type = 'todo' with classifier_confidence = 'heuristic'
//   - ambiguous todos have type = 'todo' with classifier_confidence = null
//     (Phase B's LLM classifier upgrades them later)
//
// Phase A is heuristic-only — no LLM calls during backfill. SecureStore-gated
// so it runs at most once per install.
export async function backfillTodoMeta(): Promise<{
  scannedEntries: number;
  skipped: boolean;
}> {
  const done = await SecureStore.getItemAsync(BACKFILL_KEY);
  if (done) return { scannedEntries: 0, skipped: true };

  const entries = await getAllEntries();
  for (const entry of entries) {
    if (!entry.todos || entry.todos.length === 0) continue;
    try {
      await reconcileTodoMetaForEntry(entry);
    } catch (err) {
      console.warn('[todo_meta backfill] entry failed:', entry.id, err);
    }
  }

  await SecureStore.setItemAsync(BACKFILL_KEY, new Date().toISOString());
  return { scannedEntries: entries.length, skipped: false };
}

// Phase B catch-up pass: walks every meta row whose classifier_confidence is
// still null (i.e. the heuristic returned null) and runs the LLM classifier
// on the underlying todo text. Skips:
//   - rows where the user has manually overridden the type (locked)
//   - rows whose underlying todo is done (no value categorizing completed
//     items — burns tokens for nothing)
//
// Sequential, throttled by the LLM's own rate limits. No SecureStore flag —
// this is cheap to re-run on every boot and self-quiet when there's nothing
// to do; new ambiguous rows captured later get caught on subsequent boots.
export async function classifyAmbiguousMeta(): Promise<{
  classified: number;
  skipped: boolean;
  reason?: string;
}> {
  if (!(await isClassifierAvailable())) {
    return { classified: 0, skipped: true, reason: 'no AI configured' };
  }

  const [allMetas, allEntries] = await Promise.all([getAllTodoMetas(), getAllEntries()]);
  const todoById = new Map<string, TodoItem>();
  for (const e of allEntries) {
    for (const t of e.todos ?? []) todoById.set(t.id, t);
  }

  const targets: { todoId: string; text: string }[] = [];
  for (const meta of allMetas) {
    if (meta.classifierConfidence !== null) continue;  // already classified or heuristic
    if (meta.userOverriddenType) continue;             // user locked
    const todo = todoById.get(meta.todoId);
    if (!todo) continue;                                // orphan; skip
    if (todo.done) continue;                            // exclude done items
    targets.push({ todoId: meta.todoId, text: todo.text });
  }

  if (targets.length === 0) return { classified: 0, skipped: false };

  let classified = 0;
  for (const { todoId, text } of targets) {
    try {
      const result = await classifyTodo(text);
      if (!result) continue;
      await updateTodoMeta(todoId, {
        type: result.type,
        classifierConfidence: result.confidence,
        classifierModel: result.model,
      });
      classified++;
    } catch (err) {
      console.warn('[classify catch-up] failed for', todoId, err);
    }
  }

  return { classified, skipped: false };
}

// Count the ambiguous, not-done meta rows that would be classified on the
// next catch-up pass. Used by the /todos banner to show "configure AI to
// categorize N todos" when no provider is set.
export async function countAmbiguousNotDone(): Promise<number> {
  const [allMetas, allEntries] = await Promise.all([getAllTodoMetas(), getAllEntries()]);
  const todoById = new Map<string, TodoItem>();
  for (const e of allEntries) {
    for (const t of e.todos ?? []) todoById.set(t.id, t);
  }
  let count = 0;
  for (const meta of allMetas) {
    if (meta.classifierConfidence !== null) continue;
    if (meta.userOverriddenType) continue;
    const todo = todoById.get(meta.todoId);
    if (!todo || todo.done) continue;
    count++;
  }
  return count;
}
