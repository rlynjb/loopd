# Prompt-driven prose-commit — the journal-as-source-of-truth experience
## Industry name(s): prose-first capture, extract-and-reconcile, source-of-truth invariant · Type: Architecture pattern

> The user writes prose. The system extracts structured shapes (todos, threads, nutrition) from the prose via LLM chains. Re-running extraction from the same prose must produce the same structured shapes. The prose is canonical; the structured tables are derived.

## Zoom out, then zoom in

```
  THE CONTRACT

  entries.text   ←── what the user writes (source of truth)
       │
       │  compose.ts (5 chains)
       ▼
  { summary, todos, threads, nutrition }
       │
       │  reconcileMeta.ts (deterministic; local SQLite txn)
       ▼
  todos_json + todo_meta + threads + thread_meta + nutrition + nutrition_meta
```

Zoom in: the meta tables are *derived state*. They exist for query performance and UI structure, not as independent truth. If a meta row diverges from `entries.text`, the prose wins. The invariant: re-running compose + reconcile on the same prose produces identical meta.

## Structure pass

```
  layers   ─ UI (typing) ─ entries.text ─ compose ─ reconcile ─ meta tables
  axes     ─ source-of-truth vs derived
             ─ idempotency of derivation
  seams    ─ entries.text ←→ compose : LLM extraction
             ─ compose ←→ reconcile  : pure orchestration
             ─ reconcile ←→ meta     : local SQLite txn
```

## How it works

### Move 1 — extraction is "what's in the prose right now"

```
  the LLM doesn't update meta. it reads prose and outputs a
  STRUCTURED view of what the prose contains.
  reconcileMeta then makes the meta tables match that view.
```

### Move 2 — reconcile is set-based, not log-based

```
  for each meta row that exists for this entry:
    if it's not in the new view → delete (soft delete)
    if it's in the new view → update (LWW on derived fields)
  for each item in the new view not yet in meta:
    insert
  
  no event log. no "user_added_todo" event.
  the prose is the log; meta is the projection.
```

### Move 3 — the principle: prose is the system's commit log

```
   ┌─────────────────────────────────────────────────┐
   │ the user's editing of prose IS the system's     │
   │ event log. there is no separate "added todo"    │
   │ event. structured shapes derive from prose;     │
   │ they never override it. this is the spec.md     │
   │ principle: re-running compose + reconcile from  │
   │ entries.text reproduces the meta state.         │
   └─────────────────────────────────────────────────┘
```

## Primary diagram

```
   the prose-commit flow

   user types entry.text
        │
        ▼
   ┌─────────────────────────────────┐
   │ compose.ts                       │
   │   summarize(text)                │
   │   for line in candidates:        │
   │     classify(line, ctx)          │ ◄── heuristic short-circuit
   │                                  │     (see pattern 05)
   │   for thread in impacted:        │
   │     interpret(thread)            │
   └─────────────────────────────────┘
        │  { summary, todos, threads, nutrition }
        ▼
   ┌─────────────────────────────────┐
   │ reconcileMeta.ts (one SQLite txn)│
   │   diff existing meta vs view     │
   │   delete missing rows (soft)     │
   │   update changed rows            │
   │   insert new rows                │
   │   commit                          │
   └─────────────────────────────────┘
        │
        ▼  meta tables now match prose
```

## Implementation in codebase

```ts
// pattern; src/services/prose/reconcileMeta.ts
export async function reconcileMeta(
  entry: Entry,
  composed: Composed,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await reconcileTodos(tx, entry, composed.todos, userId);
    await reconcileThreads(tx, entry, composed.threads, userId);
    await reconcileNutrition(tx, entry, composed.nutrition, userId);
    await tx.exec(
      `INSERT OR REPLACE INTO ai_summaries
       (user_id, id, entry_id, chain, result, updated_at)
       VALUES (?, ?, ?, 'summarize', ?, ?)`,
      [userId, summaryId(entry), entry.id, composed.summary, Date.now()],
    );
  });
}
```

```ts
// pattern; reconcileTodos
async function reconcileTodos(
  tx: Tx, entry: Entry, todos: Todo[], userId: string,
) {
  const existing = await tx.queryAll<TodoMeta>(
    `SELECT * FROM todo_meta WHERE user_id = ? AND entry_id = ?`,
    [userId, entry.id],
  );
  const existingByKey = new Map(existing.map(t => [t.lineKey, t]));
  const seen = new Set<string>();
  for (const todo of todos) {
    seen.add(todo.lineKey);
    if (existingByKey.has(todo.lineKey)) {
      // update
    } else {
      // insert
    }
  }
  // soft-delete the ones not seen
  for (const e of existing) {
    if (!seen.has(e.lineKey)) {
      await tx.exec(`UPDATE todo_meta SET deleted = 1, updated_at = ? WHERE id = ?`,
                     [Date.now(), e.id]);
    }
  }
}
```

**Line-by-line read:**

- `db.transaction(...)` — the whole reconcile is one local SQLite txn. Either every meta change lands, or none does. This is the local atomicity boundary buffr depends on.
- `lineKey` is the stable identity of a todo across re-runs. Without a stable key, every reconcile would soft-delete and re-insert every todo — losing user-modifiable metadata like "completed."
- The pattern is set-based: build the new set, diff against existing, apply. Standard, robust, deterministic.

## Elaborate

The "prose is the commit log" pattern is the architectural commitment that makes the whole experience cohere. Alternative: events ("user added todo X"). Cost of events: race conditions between events and edits, hard to undo, divergence over time. Cost of prose-as-log: requires LLM to extract structure reliably (chains pay this); requires reconcile to be idempotent (it is).

The key invariant — **re-running compose + reconcile on the same entries.text reproduces the meta state** — is documented in `docs/spec.md`. It's the contract that lets buffr's other systems (sync, search, future analytics) trust that meta tables are authoritative *only as projections* of prose.

The pattern's weakness: prose drift mid-day. If the user is mid-write and reconcile fires, the meta reflects half-finished prose. Buffr mitigates this with the debounce — reconcile fires on idle, not on every keystroke. The window is still real but small.

## Interview defense

**Q [mid]:** What's the source of truth for a todo?

**A:** `entries.text`. The user's prose for that day. The `todo_meta` row is a projection of the prose; if the user removes the todo from prose, reconcile soft-deletes the meta row on the next prose-commit.

**Q [senior]:** What if the LLM extraction is wrong?

**A:** It happens — classification flips, summary drifts. The mitigation is that the user can edit the prose, and reconcile re-runs cleanly. The structured tables converge to the prose's truth. The user never has to edit meta directly.

**Q [arch]:** Why not an event-sourced log of user actions?

**A:** Events are powerful but expensive. Each event is a row; replaying events to reconstruct state is heavy; race conditions between event ingestion and edit-in-place are hard. For a single-user single-stream journal, "prose is the log" is dramatically simpler. The cost is reliance on the LLM extraction, which is testable in isolation.

## Validate

### Level 1 — sketch the prose → compose → reconcile → meta flow.

### Level 2 — explain why prose is source-of-truth and meta is derived.

### Level 3 — apply: a feature wants user-editable meta (e.g., manually mark a todo as "important"). How? Add a column to meta that's preserved across reconcile (`important` is *not* derived from prose). reconcile preserves any user-set columns.

### Level 4 — defend: "Just let the user edit todos directly; skip the LLM." Cost: now meta and prose can diverge; the system has two sources of truth; UX has to handle conflict. The prose-driven design is what makes buffr feel like "the journal IS the data."

## See also

- [`03-chain-composition-with-cache-shortcircuit.md`](./03-chain-composition-with-cache-shortcircuit.md) — how compose's chains work.
- [`audit.md`](./audit.md) — Pass 1's lens 3 (state ownership).
- `../study-data-modeling/00-overview.md` — the meta-table schemas.
- `../study-database-systems/05-transactions-isolation-and-anomalies.md` — the txn boundary reconcile depends on.
