# Pin replaces manual reorder

**Industry name(s):** — (project-specific simplification: boolean pin replacing position-based reorder)
**Type:** Project-specific

> The /todos page swapped a user-managed integer `position` column for a single boolean `pinned`. The `position` column is kept on the schema (deprecated) but no UI reads it.

**See also:** → [02-dsa/04-ranked-todo-sort](../02-dsa/04-ranked-todo-sort.md) · → [02-dsa/11-pinned-first-sort](../02-dsa/11-pinned-first-sort.md) · → [13-append-only-migrations](./13-append-only-migrations.md)

---

## Why care

You once shipped a drag-to-reorder feature, watched users actually use it for a week, and then looked at the data: most people pinned one item to the top and let the rest fall wherever. The whole apparatus — drag handles, position integers, the bug where two items got the same rank — existed to support a flexibility nobody used. The right move is not to optimize the feature; it's to delete it and ship the simpler thing that captures the same intent.

Replacing manual ordering with a single boolean flag is a specific case of "downgrade the data model to match observed usage." It belongs to the family of "subtractive design" decisions, where the win comes from removing affordances instead of adding them. You've seen this in the way most apps quietly removed "folders" in favor of tags, the way email clients collapsed flagged/important/starred into one star, and the way a typed-language migration from a wide enum to a boolean simplifies every call site at once. The diagram below shows the shape it takes here.

---

## Pin vs reorder — diagram

```
  Before (deprecated, ~through 2026-05-04):
  ─────────────────────────────────────────
  todo_meta:
    position INT NULL          ← user drag-reorders set it
    stage    TEXT 'todo'/'next'/'done'  ← surfaced in /todos filters

  Sort:
    NULL position rows by createdAt DESC, then positioned rows by position ASC

  UI:
    drag handles, manual reorder, three-stage filter

  After (2026-05-05+):
  ────────────────────
  todo_meta:
    position INT NULL          ← deprecated; kept for cloud-sync round-trip
    stage    TEXT 'todo'       ← still on schema, no UI surface
    pinned   BOOLEAN           ← NEW (migration 0005)

  Sort:
    pinned rows first, then everything by createdAt DESC

  UI:
    pin icon (toggle), no drag, no stage filter, swipe-to-delete added
```

---

## How it works

The `pinned` column landed via migration `0005_todo_meta_pinned.sql` and a corresponding local schema bump. The /todos page reads `meta.pinned` per row and sorts:

```
  pinned: true rows first
  same-pin: createdAt DESC (newest at top)
```

The dashboard's `SmartTodoList` matches this exactly. New captures land at the top because they're newest by `createdAt`. Pin acts as a sticky modifier on top of recency.

The `position` column stays on the schema because dropping it would require a destructive Postgres migration and the cloud round-trip still includes it (it's just always `null` on writes now). The `stage` column is in the same boat — kept on the schema with a single-value default, no UI surface.

The same commit that introduced `pinned` removed the drag-reorder gestures and the three-stage status filter, and added the `Swipeable` wrapper for swipe-to-delete on each todo row.

---

## In this codebase

**Migration:**         `supabase/migrations/0005_todo_meta_pinned.sql` — adds the `pinned` column on the cloud side
**Types:**             `src/types/todoMeta.ts` (109 lines) — declares `pinned: boolean`, `position: number | null` (marked deprecated 2026-05-05), `stage: TodoStage`
**Live sort:**         `app/todos.tsx` — inline `out.sort(...)` at L187–L194 implements `pinned` first, then `createdAt DESC`. Swipe-to-delete via `react-native-gesture-handler`'s `Swipeable`.
**Pin toggle:**        `src/services/database.ts` → `updateTodoMeta(row.id, { pinned: !row.meta.pinned })`

> ⚠ **Content drift flagged 2026-05-07**: this concept file's "How it works" section claims `SmartTodoList` "matches this exactly", but `src/components/home/SmartTodoList.tsx` L41–L67 still uses the **legacy position-based sort** (`metas?.get(a.id)?.position ?? null`). The dashboard's `SmartTodoList` has not yet been migrated to the pinned-first comparator that ships in `app/todos.tsx`. The fix is a one-comparator swap. See [02-dsa/11-pinned-first-sort](../02-dsa/11-pinned-first-sort.md) for the full divergence note.

---

## Elaborate

### Where this pattern comes from
The shift from "user manages an order" to "user marks priority" is older than software — the in-tray vs the "VIP" stamp is the same insight. Most modern todo apps default to recency-or-priority sorts because manual order is a maintenance burden the user almost always abandons.

### The deeper principle
**Match the data model to what users actually do, not what they say they want.** A drag-reorder UI feels powerful but the usage pattern was "a few sticky items." A boolean captures the actual intent in one bit instead of an integer per row. Removing affordance is often the right move.

### Where this breaks down
- Power users who genuinely curate a multi-item order. They lose expressiveness.
- Cases where pin-without-recency is needed (an old item you want at top forever, but newer pinned items keep displacing it). Today there's no priority-among-pinned tier.

### What to explore next
- [02-dsa/04-ranked-todo-sort](../02-dsa/04-ranked-todo-sort.md) → the legacy `rankTodos` function (still in the repo, currently unused).
- [02-dsa/11-pinned-first-sort](../02-dsa/11-pinned-first-sort.md) → the live sort algorithm.
- [13-append-only-migrations](./13-append-only-migrations.md) → why `position` and `stage` couldn't just be dropped.

---

## Tradeoffs

- **Boolean replaces int** — gives: trivial mental model, one less drag UI to maintain. Costs: can't express "A before B before C."
- **Deprecated columns kept** — gives: no destructive schema change. Costs: schema noise; future readers must know which columns are live.
- **Recency tiebreak** — gives: new captures bubble naturally. Costs: an old pinned item is below a newer pinned item — no way to override.

---

## Quick summary

Replacing manual ordering with a single boolean flag is a specific case of downgrading the data model to match observed usage — a subtractive design move where the win comes from removing an affordance instead of adding one. In this codebase, as of 2026-05-05 the `/todos` page sorts by `meta.pinned` first then `createdAt DESC` via an inline comparator at `app/todos.tsx` L187–L194; migration `0005_todo_meta_pinned.sql` added the `pinned` column; and the pin toggle is `updateTodoMeta(row.id, { pinned: !row.meta.pinned })` in `src/services/database.ts`. The constraint was that in practice users pinned a handful of items and ignored the rest of the order, so a single bit captures the actual intent and the drag-reorder UI was deleted along with the three-stage filter. The cost is that a user who genuinely wants "A before B before C" can't express that anymore — and the legacy `position` and `stage` columns stay on the schema (deprecated) because dropping them would require a destructive cloud migration. `SmartTodoList.tsx` L41–L67 still uses the legacy position-based sort and is a known content drift waiting on a one-comparator swap.

Key points to remember:
- The live sort is two-key: `pinned` first (boolean), then `createdAt DESC` — pin acts as a sticky modifier on top of recency.
- `position` and `stage` columns are kept on the schema for cloud round-trip compatibility but no UI reads them; the deprecation is in `src/types/todoMeta.ts`.
- Lives in step 1 (Data model) of the system-design checklist.
- Removing affordance is reversible while `services/todos/rank.ts:rankTodos` stays in tree — that's the recovery path if observed usage was wrong.
- `SmartTodoList.tsx` L41–L67 has not yet migrated to the pinned-first comparator and is the documented content drift between the dashboard and `/todos`.

---

## Interview defense

### What an interviewer is really asking
Replacing a feature is harder than building one. The interviewer wants to know whether you observed actual usage before ripping out the old UI, and whether you held the line on schema discipline (didn't drop the column even though it was tempting).

### Likely questions

[mid] Q: The `position` column still exists in `todo_meta`. Walk me through what happens when a row is written today.

A: Inserts and updates from the app set `position = NULL` (or omit it; the column is nullable). The cloud-sync mappers in `sync/tables/todoMeta.ts` round-trip the column verbatim — if a legacy row in cloud still has a position integer, it pulls back into SQLite intact. No code reads `position` for sort or filter; it's effectively a dead column on the schema. The reason it's still there is that dropping it would require a destructive Postgres migration and a coordinated client-side schema bump, which would block users on older app versions from syncing. Append-only migration discipline says: leave it.

[senior] Q: You shipped pin + swipe-to-delete and removed drag-reorder + three-stage filter in one commit. Why bundled?

A: Because they were the same idea: replace a maintenance-heavy multi-degree UI with a single-bit gesture. Drag-reorder + three-stage filter were both expressions of "user manages this dimension manually." Pin + swipe-to-delete are both "user marks a single attribute on a row." Shipping them together meant the user got a coherent new model in one go instead of two confusing intermediate states. The cost is a bigger diff to review; the win is that no version of the app shipped with "pin exists but drag-reorder is also still here" — which would have been a UX mess.

[arch] Q: What happens if your usage analysis was wrong and a user actually relied on multi-item ordering?

A: They lose expressiveness. The existing `rankTodos` function in `services/todos/rank.ts` still exists (it's the legacy comparator), so the recovery path is "add a manual-ordering setting that re-routes the sort through `rankTodos` for users who opt in." The cost would be conditional sort logic in two places (`/todos` and `SmartTodoList`). I haven't shipped that because the analysis was strong — I'm the only user; I never used multi-item ordering. For a multi-user app I'd watch the data first and ship pin-only, then add the manual-order opt-in if a meaningful fraction of users complained. Removing affordance is reversible if the legacy code stays in tree, which is why `rankTodos` wasn't deleted.

### The question candidates always dodge
Q: You're keeping `position` and `stage` columns on the schema even though no UI reads them. Isn't that just digital debt?

A: Yes, it is. They're dead columns kept on the schema because the cost of dropping them (destructive cloud migration that would break users on older app versions) is higher than the cost of carrying them (a few bytes per row, two extra fields in the cloud-sync mapper). The honest version is: I made the call that schema noise is preferable to a coordinated migration, and I documented both columns as deprecated in `src/types/todoMeta.ts`. The cleanup happens when I do my next "schema squash" — at the time I squash migrations `0001-0005` into a consolidated baseline, I'd drop both columns at the same time. Until then, they sit there. The risk is that a future reader sees `position` and assumes it's live, which is why the type definition has the deprecation comment and why this study guide says it explicitly. That's the cost of keeping legacy schema in tree; I think it's lower than the alternative.

### One-line anchors
- "Drag-reorder was an affordance the user never used; pin captures the actual intent in one bit."
- "Boolean replaces int — the data model now matches what users do, not what they say they want."
- "`position` and `stage` are kept on the schema because dropping them would mean a destructive cloud migration; deprecation in code is the cheaper path."
- "Removing affordance is reversible while the legacy code stays in tree — `rankTodos` is the recovery path."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain "pin replaces manual reorder" to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `app/todos.tsx` L187–L194 + `supabase/migrations/0005_todo_meta_pinned.sql`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user updates from the pre-2026-05-05 version of the app to the post-pin version. Their existing `todo_meta` rows have non-null integer `position` values from before. After the update, what does the `/todos` sort look like — does the old `position` data influence ordering at all? What about a row whose cloud-side write hasn't pulled yet so its local copy still has the old `position`? Why doesn't dropping `position` from the schema help here?

Write your answer. 3–5 sentences minimum. Then open `app/todos.tsx` L187–L194 and `src/types/todoMeta.ts` to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `app/todos.tsx` L187–L194 (the live two-key comparator) to support what exists
→ Point to `src/services/todos/rank.ts:rankTodos` (the dormant 3-tier comparator that's still in tree as a recovery path) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0). Flagged content drift: `SmartTodoList.tsx` still uses legacy position-based sort.
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
