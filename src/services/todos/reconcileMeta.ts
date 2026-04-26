import type { Entry } from '../../types/entry';
import type { TodoMeta } from '../../types/todoMeta';
import {
  getTodoMetasByEntry, insertTodoMeta, updateTodoMeta, deleteTodoMeta,
} from '../database';
import { heuristicClassify } from './heuristicClassify';
import { classifyTodo } from './classify';

// Fire the LLM classifier for a single new ambiguous todo, asynchronously.
// Updates the meta row when the call returns. Self-quiet on no-AI / failure
// — the row stays at type='todo', classifier_confidence=null and the next
// boot's catch-up will pick it up if/when AI is configured.
function scheduleClassify(todoId: string, text: string): void {
  classifyTodo(text)
    .then(async result => {
      if (!result) return;
      try {
        await updateTodoMeta(todoId, {
          type: result.type,
          classifierConfidence: result.confidence,
          classifierModel: result.model,
        });
      } catch (err) {
        console.warn('[classify on-commit] update failed:', err);
      }
    })
    .catch(err => console.warn('[classify on-commit] schedule failed:', err));
}

// After scanTodosFromText materializes the new todos array, reconcile the
// 1:1 todo_meta side:
//
//   - For every TodoItem that has no paired meta row → INSERT a fresh meta.
//     Run the free heuristic classifier inline; if it returns 'todo' set
//     classifier_confidence = 'heuristic'; otherwise leave the row at the
//     default type='todo' with classifier_confidence = null and let the
//     Phase B LLM classifier upgrade it later.
//
//   - For every meta row whose todoId no longer appears in todos_json →
//     DELETE the meta row.
//
//   - Existing matched todos are untouched. Type is preserved across edits
//     (spec §5.4) and across user overrides (user_overridden_type lock).
//
// Self-healing: a failed reconcile leaves orphaned/missing meta rows; the
// next commit sees the gap via the same diff and patches it. Best-effort
// from the journal's perspective — never throws.
export async function reconcileTodoMetaForEntry(entry: Entry): Promise<void> {
  try {
    const existing = await getTodoMetasByEntry(entry.id);
    const existingByTodoId = new Map(existing.map(m => [m.todoId, m]));
    const currentTodos = entry.todos ?? [];
    const currentIds = new Set(currentTodos.map(t => t.id));

    for (const todo of currentTodos) {
      if (existingByTodoId.has(todo.id)) continue;
      const heuristic = heuristicClassify(todo.text);
      const now = new Date().toISOString();
      const meta: TodoMeta = {
        todoId: todo.id,
        entryId: entry.id,
        entryDate: entry.date,
        type: heuristic ?? 'todo',
        expandedMd: null,
        expandedAt: null,
        model: null,
        classifierConfidence: heuristic ? 'heuristic' : null,
        classifierModel: null,
        userOverriddenType: false,
        createdAt: todo.createdAt ?? now,
        updatedAt: now,
      };
      await insertTodoMeta(meta);

      // Heuristic was uncertain → fire the LLM classifier (Phase B).
      // Skip done todos — no value categorizing what's already complete.
      if (!heuristic && !todo.done) {
        scheduleClassify(todo.id, todo.text);
      }
    }

    for (const meta of existing) {
      if (currentIds.has(meta.todoId)) continue;
      await deleteTodoMeta(meta.todoId);
    }
  } catch (err) {
    console.warn('[todo-meta reconcile] failed for', entry.id, err);
  }
}
