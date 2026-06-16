import * as SecureStore from 'expo-secure-store';
import {
  getAllEntries, getAllTodoMetas, updateTodoMeta,
} from '../database';
import { reconcileTodoMetaForEntry } from './reconcileMeta';
import { classifyTodo, isClassifierAvailable } from './classify';
import { heuristicClassify } from './heuristicClassify';
import type { TodoItem } from '../../types/entry';

// Bumping this key forces a re-run on next boot — useful if the heuristic
// rule set changes meaningfully.
const BACKFILL_KEY = 'todo_meta_backfill_v1_done';

// Cap on how many LLM-bound rows the boot-time catch-up will process per
// launch. Heuristic-classifiable rows are NOT counted against this cap (they
// run for free). The rest roll forward to the next boot.
//
// Why a cap exists at all: under Phase C the LLM classifier is Gemma 3 4B
// running on-device. Serial inference at ~3s/call means even 20 rows would
// block boot for a minute. Capping at 10 keeps the boot-time path under
// ~30s on-device and is well within cloud rate limits otherwise. Tune up
// if Gemma local turns out faster than expected.
const BOOT_BATCH_SIZE = 10;

// One-time backfill that walks every existing entry and runs the
// todo_meta reconcile against it. After this finishes:
//   - every TodoItem in todos_json has a paired todo_meta row
//   - heuristic-classifiable todos have classifier_confidence = 'heuristic'
//     (type matches the heuristic return; today only 'todo', but Phase C
//     widening adds idea / knowledge / study / reflect)
//   - ambiguous todos have type = 'todo' with classifier_confidence = null
//     and the LLM classifier upgrades them in classifyAmbiguousMeta
//
// SecureStore-gated so it runs at most once per install.
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

// Boot-time catch-up pass over rows whose classifier_confidence is still
// null. Two passes:
//
//   Pass 1 — heuristic (free).
//     Re-runs heuristicClassify on every target. Catches rows that became
//     classifiable after a heuristic widening shipped (between when the
//     row was reconciled and now). No LLM cost. Always runs in full.
//
//   Pass 2 — LLM (capped, only if AI is available).
//     Walks the remaining heuristic-null rows. Caps at BOOT_BATCH_SIZE
//     per boot to avoid minutes of serial on-device inference under
//     Phase C. Skips:
//       - rows where the user has manually overridden the type
//       - rows whose underlying todo is done (no value categorizing
//         completed items — burns tokens / battery for nothing)
//
// Sequential. No SecureStore flag — cheap to re-run on every boot and
// self-quiet when there's nothing to do; new ambiguous rows captured
// later get caught on subsequent boots.
export async function classifyAmbiguousMeta(): Promise<{
  classified: number;
  skipped: boolean;
  reason?: string;
}> {
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

  // Pass 1: heuristic re-run on all targets (free).
  const remaining: { todoId: string; text: string }[] = [];
  let total = 0;
  for (const t of targets) {
    const h = heuristicClassify(t.text);
    if (h) {
      try {
        await updateTodoMeta(t.todoId, {
          type: h,
          classifierConfidence: 'heuristic',
          classifierModel: null,
        });
        total++;
      } catch (err) {
        console.warn('[classify catch-up] heuristic update failed for', t.todoId, err);
      }
    } else {
      remaining.push(t);
    }
  }

  // Pass 2: LLM-bound, capped.
  if (!(await isClassifierAvailable())) {
    return {
      classified: total,
      skipped: total === 0,
      reason: total === 0 ? 'no AI configured' : undefined,
    };
  }

  const batch = remaining.slice(0, BOOT_BATCH_SIZE);
  for (const { todoId, text } of batch) {
    try {
      const result = await classifyTodo(text);
      if (!result) continue;
      await updateTodoMeta(todoId, {
        type: result.type,
        classifierConfidence: result.confidence,
        classifierModel: result.model,
      });
      total++;
    } catch (err) {
      console.warn('[classify catch-up] failed for', todoId, err);
    }
  }

  return { classified: total, skipped: false };
}

// Count the ambiguous, not-done meta rows that would be classified on the
// next catch-up pass. Used by the /todos banner to show "configure AI to
// categorize N todos" when no provider is set. Not capped — reports the
// real backlog so the banner copy is accurate even when BOOT_BATCH_SIZE
// throttles per-boot progress.
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
