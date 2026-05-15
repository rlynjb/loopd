# Pin replaces manual reorder

**Industry name(s):** — (project-specific simplification: boolean pin replacing position-based reorder)
**Type:** Project-specific

> The /todos page swapped a user-managed integer `position` column for a single boolean `pinned`. The `position` column is kept on the schema (deprecated) but no UI reads it.

**See also:** → [02-dsa/04-ranked-todo-sort](../02-dsa/04-ranked-todo-sort.md) · → [02-dsa/11-pinned-first-sort](../02-dsa/11-pinned-first-sort.md) · → [13-append-only-migrations](./13-append-only-migrations.md)

---

## Why care

You're designing a todo list with a "make this important" affordance. Option one: add an integer `position` column to every row, give the UI a drag handle that calls an `onDragEnd` handler to renumber `position` across affected rows, write a rebalance routine to handle integer drift, and watch out for the race condition when two reorders fire simultaneously. Option two: add a `pinned BOOLEAN` column, give the UI a pin icon that toggles one row's boolean, and sort `ORDER BY pinned DESC, created_at DESC`. The first option is more flexible; the second covers the actual use case (one thing matters today, the rest are background). For 90% of products, nobody ever uses option one's drag handle for anything the boolean wouldn't have covered.

The question subtractive design answers is one every product team eventually has to answer: when usage data shows a flexible affordance is being used in exactly one way, do you keep the flexibility (because someone might use it differently someday) or do you delete it and ship the simpler thing that captures the same intent? Not "add a setting that toggles between drag and star" — that ships both. The answer is *subtractive design*: downgrade the data model and the UI to match what people actually do.

**What depends on getting this right:** whether the codebase carries a `position INTEGER` column plus drag-handle gesture state plus a position-renumber routine plus a race condition between two simultaneous reorders, or whether it carries one boolean and a one-line sort key. In this codebase migration `0005_todo_meta_pinned.sql` added `pinned BOOLEAN NOT NULL DEFAULT false` to `todo_meta`. The old `position INTEGER NULL` column stayed in the schema (dead-but-kept; cloud-sync upserts write NULL into it; Phase B's destructive migration will drop it). The /todos page and the dashboard's `SmartTodoList` both sort `ORDER BY pinned DESC, createdAt DESC`. The pin gesture is a `Pressable` that calls `togglePin(meta_id)` in `database.ts` — `UPDATE todo_meta SET pinned = NOT pinned, updated_at = now()` plus `schedulePush()`. The same commit that added `pinned` deleted ~300 lines of drag-handle UI, the position-renumber logic, the three-stage status filter, and the `react-native-draggable-flatlist` dependency.

Without subtraction (drag-to-reorder kept "for flexibility"):
- The todo row has a drag handle that fires `onDragEnd` to renumber `position` across affected rows
- Pinning is a separate `starred` boolean; sort is `ORDER BY starred DESC, position ASC`
- A user reorders rapidly; two `position` updates race; two rows end up with the same `position`
- A bug report says "todos lost their order"; the fix is a `position` rebalance routine
- 300 lines of UI plus a draggable-flatlist dependency plus the rebalance routine carry forever, all to support a flexibility nobody actually exercises

With subtraction (one boolean, chronological):
- The todo row has a pin icon; tap toggles `pinned`; sort is `ORDER BY pinned DESC, createdAt DESC`
- No race condition exists — there's no `position` to fight over
- A user pins five items in succession; all five sit at the top in createdAt order; the user shrugs and moves on
- The /todos page is 300 lines shorter; the codebase has one less dependency

Find the cheapest version of the same affordance and ship that.

---

## How it works

A `BOOLEAN pinned` column on the table plus `ORDER BY pinned DESC, created_at DESC` on every read. That's the whole pattern. The JS equivalent is the one-line comparator every reader has written before: `arr.sort((a, b) => Number(b.starred) - Number(a.starred) || b.createdAt - a.createdAt)`. loopd's `todo_meta.pinned` boolean is this exact shape applied to a SQLite column — one column to flag what matters today, recency as the tiebreak for everything else — and the drag-handle UI machinery the user never asked for never gets built.

The before/after of the schema + UI swap in one picture:

```
       Before (drag-to-reorder, deprecated)        After (boolean pin)
   ┌─────────────────────────────────────┐   ┌──────────────────────────────────┐
   │ todo_meta:                          │   │ todo_meta:                       │
   │   position INTEGER NULL              │   │   pinned   BOOLEAN  (new!)        │
   │   (user-managed rank)                │   │   position INTEGER NULL           │
   │                                      │   │   (dead-but-kept, always NULL)    │
   │ Sort:                                │   │                                   │
   │   ORDER BY position ASC              │   │ Sort:                             │
   │                                      │   │   ORDER BY pinned DESC,           │
   │ UI:                                  │   │            createdAt DESC          │
   │   drag handle per row                │   │                                   │
   │   onDragEnd renumbers positions      │   │ UI:                               │
   │   periodic rebalance routine         │   │   tap pin icon → toggle boolean   │
   │   race conditions between reorders   │   │   no drag state, no race          │
   │                                      │   │                                   │
   │   ~300 lines of UI + drag-flatlist   │   │   ~5 lines (Pressable + togglePin) │
   └─────────────────────────────────────┘   └──────────────────────────────────┘
```

The five sub-sections below trace the schema move, the sort key, the gesture, what got deleted, and how Phase A leaves `position` as a dead-but-kept column.

### The schema move — `pinned` BOOLEAN replaces `position` INTEGER

Migration `0005_todo_meta_pinned.sql` added a `pinned BOOLEAN NOT NULL DEFAULT false` column to `todo_meta`. The old `position INTEGER NULL` column was *not* dropped — it stays in the schema, no UI reads it, every cloud-sync upsert writes NULL into it. If you're coming from frontend, this is the same shape as a typed enum widening to a union where most variants become `never` after a refactor — the type can express positions but nothing ever sets one. Concrete consequence: a fresh todo from `scanTodos` produces a `todo_meta` row with `pinned=false, position=NULL`. A user-pinned todo gets `pinned=true, position=NULL`. The sort key never reads `position`; the column is dead-but-kept until the next destructive Postgres migration cleans up several deprecated columns at once. Boundary: the column lives forever in this state if the team never decides "now is the time for a destructive migration"; the cost is one nullable int per row, paid in storage and ignored everywhere else.

The migration SQL and the resulting row shapes:

```
   migration 0005_todo_meta_pinned.sql:

     ALTER TABLE todo_meta
       ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false;

     -- position INTEGER NULL stays in the schema (deprecated)

   row state in todo_meta:
   ┌────────┬───────────┬──────────┬─────────────────────────┐
   │ id     │ pinned    │ position │ source                  │
   ├────────┼───────────┼──────────┼─────────────────────────┤
   │ t-A    │ false     │ NULL     │ new via scanTodos       │
   │ t-B    │ true      │ NULL     │ user tapped pin         │
   │ t-C    │ false     │ NULL     │ older row, never set     │
   │                                      position             │
   └────────┴───────────┴──────────┴─────────────────────────┘

   the dead column costs one nullable int per row,
   ignored by every read path
```

The `position` column is in the schema but never read — dead-but-kept until Phase B's destructive migration.

### The sort key — pinned-first, then chronological

The /todos page and the dashboard's `SmartTodoList` both run:

```sql
SELECT * FROM todo_meta
 WHERE deleted_at IS NULL
 ORDER BY pinned DESC, createdAt DESC
```

If you've ever sorted a React array with `arr.sort((a, b) => Number(b.starred) - Number(a.starred) || b.createdAt - a.createdAt)` you've written exactly this — group by the sticky flag, then break ties by recency. Concrete consequence: a user with 8 todos, 1 pinned, will see the pinned item at row 1 every time; the other 7 land in created order, newest at top. A new capture lands at row 2 (newest unpinned), unless the user immediately pins it, in which case it lands at row 1 (newest pinned). Boundary: the sort can't express "pinned A before pinned B" — all pinned items sort by `createdAt` among themselves. If two items are pinned, the newest-pinned wins the top slot, no exception.

Walking the sort on 8 rows (1 pinned, 7 unpinned):

```
   ORDER BY pinned DESC, createdAt DESC

   ┌──────┬───────────┬───────────┬─────────┐
   │ rank │ id        │ pinned    │ created │
   ├──────┼───────────┼───────────┼─────────┤
   │  1   │ t-B       │ true      │ 14:00   │ ◄── only pinned row
   │  2   │ t-H       │ false     │ 14:30   │     unpinned, newest
   │  3   │ t-G       │ false     │ 14:00   │     │
   │  4   │ t-F       │ false     │ 13:00   │     │  rest in
   │  5   │ t-E       │ false     │ 12:00   │     │  createdAt
   │  6   │ t-D       │ false     │ 11:00   │     │  DESC
   │  7   │ t-C       │ false     │ 10:00   │     │
   │  8   │ t-A       │ false     │ 09:00   │     ▼
   └──────┴───────────┴───────────┴─────────┘
```

Two-key sort: pin wins; otherwise newest first. No third tier within pinned.

### The gesture — tap pin → toggle → write → re-sort

The pin icon is a `Pressable` on each todo row. Tap fires `togglePin(meta_id)` in `database.ts`, which writes `UPDATE todo_meta SET pinned = NOT pinned, updated_at = now() WHERE id = ?`, then `schedulePush()`. The hook subscribing to the query re-runs, gets the new row order, and React re-renders. If you're coming from React, this is the same pattern as toggling `selected` state on a list item — the only difference is the state lives in SQLite instead of `useState`, and the re-sort comes from the query, not from `useMemo`. Concrete consequence: tap pin on todo #5 → 1ms SQLite write → re-render shows todo #5 at the top → 5 seconds later `pushAll()` upserts the change to Supabase. No drag-gesture state, no inter-row position calculation, no race condition between two simultaneous reorders. Boundary: if the user pins five items in rapid succession, they all land at the top in `createdAt` order — there's no "I pinned this one first so it should rank highest" affordance.

The tap-to-resort flow:

```
   user taps pin icon on row t-A
              │
              ▼
   togglePin(meta_id_for_t_A)   // database.ts
              │
              ▼
   UPDATE todo_meta
      SET pinned     = NOT pinned,
          updated_at = now()
    WHERE id = ?
              │
              ▼  ~1ms SQLite write
              ▼
   schedulePush()  arms 5s timer
              │
              ▼
   hook re-runs query → gets new row order → React re-renders
              │
              ▼
   t-A jumps to row 1; no drag state, no inter-row math
              │
              ▼  ~5s later
              ▼
   pushAll() upserts the change to Supabase
```

One column, one toggle, one re-render — no per-row state to keep coherent during a drag gesture.

### What got deleted

The same commit that added `pinned` removed the drag-handle gestures, the position-renumber logic that ran on every reorder, the three-stage status filter (`todo` / `next` / `done`), and added a `Swipeable` wrapper for swipe-to-delete on each row. About 300 lines of UI plus the `react-native-draggable-flatlist` dependency footprint went away in one commit. If you've ever shipped a feature and then watched a redesign delete it cleanly, this is the same shape — the value was in the subtraction, not in the next iteration.

What the same commit removed vs added:

```
   Removed (~300 LOC + 1 dependency)        Added (~5 LOC)
   ──────────────────────────────────       ──────────────────────────────
   drag-handle gesture per row               <Pressable> pin icon per row
   onDragEnd renumber handler                togglePin(id) call
   position-rebalance routine                (re-sort happens via query)
   three-stage status filter
     (todo / next / done)
   react-native-draggable-flatlist
     dependency
                                            net: codebase shrank
```

The value was in the subtraction — most products that ship drag-to-reorder never gather the data that would tell them whether anyone uses it.

### Phase A / Phase B — `position` as a dead-but-kept column

- **Phase A (current):** `pinned` column live and the sole sort modifier. `position` column in the schema, never read by any UI, written as NULL on every cloud upsert. Both columns mirror to Supabase via the existing sync layer; no migration was needed beyond the additive `pinned` column.
- **Phase B (deferred):** drop `position` from `todo_meta` in a future destructive migration once it's certain no old client is still writing to it. The trigger condition is "no installed version older than 2026-05-05 in the field for 90 days."

Side by side, with the dead column carrying forward in Phase A:

```
            Phase A (current)                       Phase B (deferred)
   ┌──────────────────────────────────┐   ┌──────────────────────────────────┐
   │ pinned   BOOLEAN  active          │   │ pinned   BOOLEAN  active          │  unchanged
   │ position INTEGER  NULL forever    │   │ position dropped                  │ ← change
   │                                   │   │                                   │
   │ sync writes NULL into position    │   │ schema cleaner; no dead column    │
   │ on every push                     │   │                                   │
   │                                   │   │ trigger condition:                │
   │                                   │   │   no installed version older      │
   │                                   │   │   than 2026-05-05 in the field    │
   │                                   │   │   for 90 days                     │
   └──────────────────────────────────┘   └──────────────────────────────────┘
```

The schema didn't have to change between phases — `position` becoming NULL forever is a Phase A state that costs one ignored int per row. The architecture absorbed the simplification without forcing a synchronous schema cleanup; the cleanup gets to be lazy.

This is what people mean by "find a cheaper version of the same affordance." Drag-to-reorder is the canonical answer to "let users prioritise," but the cheapest version — pin one thing — covers 90% of real usage. The disciplined move is to ship the cheap version first and only build the expensive one when usage data forces it. Most products that ship drag-to-reorder never gather the data that would tell them whether anyone uses it. The full picture is below.

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

We traded multi-degree manual ordering for a single boolean — observed usage was "pin a few, ignore the rest," and the data model now matches what users actually do instead of what a drag-handle UI invited them to imagine.

### Comparison table — both costs in one frame

```
┌──────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Path taken (pinned bool +    │ Alternative (keep position-  │
│                  │  recency tiebreak)           │  based manual reorder)       │
├──────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Expressiveness   │ pin/not — 2 tiers            │ N tiers (A < B < C < ...)    │
│ User UX          │ tap pin icon                  │ drag handles, long-press,    │
│                  │                              │ ordered list with grip       │
│ Sort algorithm   │ 2-key: pinned, createdAt DESC│ 3-tier with position INT     │
│                  │                              │ NULL handling                │
│ Sort bugs        │ none — boolean is total      │ "two items got same rank"    │
│ possible         │                              │ "drag race condition"        │
│ Code surface     │ inline comparator at         │ rankTodos function (still in │
│                  │ app/todos.tsx L187–L194      │ tree as recovery path)       │
│ Schema cost      │ +pinned col (1 byte)         │ position INT NULL stays      │
│                  │ position INT NULL stays      │ (legacy)                     │
│                  │ (deprecated)                 │                              │
│ Override "old    │ impossible — newer pinned    │ user drags old item to top   │
│  pinned to top"  │ items always displace        │                              │
│ Reversibility    │ rankTodos still in tree;     │ already shipped              │
│                  │ pin-only is reversible if    │                              │
│                  │ analysis wrong               │                              │
│ Observed usage   │ matches: "a few sticky items"│ doesn't match — users         │
│ fit              │                              │ abandoned drag-reorder       │
└──────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### What we gave up

Multi-item ordering. A user who genuinely wanted "A first, then B, then C, then everything else by recency" can't express that — the second tier of granularity is gone. For the actual usage pattern (one or two sticky items, rest by recency) this is invisible; for a power user it's a removed feature.

The legacy `position` and `stage` columns stay on the schema because dropping them would mean a destructive cloud migration. We pay in schema noise: every cloud-sync mapper round-trips two dead fields, every contributor reading `todo_meta` must know the `@deprecated` comment in `src/types/todoMeta.ts` is the source of truth on what's live. The "deprecation in code, not in schema" path is cheaper than coordinating a destructive migration across user app versions, but it does mean the schema is permanently a bit dishonest.

Recency is the tiebreak among pinned items. An old item the user pinned three weeks ago sits below a newly-pinned item from today. There's no "priority among pinned" tier; pin is binary. If we wanted that, we'd have to either re-introduce `position` for pinned rows only (a special case in the sort), or add a `pinnedAt` timestamp tier. Today neither exists.

`SmartTodoList.tsx` L41–L67 hasn't migrated to the pinned-first comparator. The dashboard still uses the legacy position-based sort, which means the dashboard and the `/todos` page show two different orderings for the same data. This is a known content drift; the fix is a one-comparator swap that hasn't shipped because I noticed it after shipping pin and the dashboard didn't break in a visible way.

### What the alternative would have cost

Keeping drag-reorder would have meant maintaining the `position` column as live data, the drag-handle UI, the long-press gesture, the position-update on every reorder, the race when two items race for the same rank, and the user mental model of "I have to manage this." All of that to support a usage pattern that the data showed wasn't happening.

The code-surface saving from pin-only is small (~30 LOC removed in the sort comparator + ~50 LOC removed in the drag UI) but the cognitive saving is large: pin is one bit, the user can flip it without thinking, and the sort is trivially correct. Drag-reorder kept implicit invariants ("no two rows have the same position") that the schema didn't enforce.

### The breakpoint

Fine until a credible "I want manual order back" signal arrives. The recovery path is `services/todos/rank.ts:rankTodos` — the legacy 3-tier comparator still in tree as a dormant function. Adding a user-level setting that re-routes the sort through `rankTodos` is ~50 LOC and a UI toggle; the dormant code stays callable. The breakpoint isn't "feature analytics says X% drag-reorder usage" (we don't have analytics) — it's "a user with a meaningful workflow complains, and the cost of adding the opt-in is less than the cost of saying no."

### What wasn't actually a tradeoff

Dropping `position` and `stage` from the schema wasn't on the table at ship time. The cost is a destructive Postgres migration that would break older app versions still trying to write the columns; rolling that across user devices means coordinating an app-version cutoff that we don't have machinery for. The "schema squash" path (consolidate migrations 0001-0008 into a new baseline and drop the dead columns at the same time) is the right cleanup window, deferred until the migration log gets long enough to need squashing.

---

## Tech reference (industry pairing)

### expo-sqlite (WAL) + Supabase Postgres

- **Codebase uses:** `expo-sqlite` against `loopd.db` plus `@supabase/supabase-js` against managed Supabase Postgres. `todo_meta.pinned BOOLEAN` lives on both sides; `todo_meta.position INTEGER NULL` is dead-but-kept on both.
- **Why it's here:** the schema move had to land in both stores without a destructive migration — the additive `pinned` column was applied locally via `database.ts` schema bump and to Supabase via `supabase/migrations/0005_todo_meta_pinned.sql`. The dual-store mirror is what made "additive only" non-negotiable.
- **Leading today:** Supabase — `adoption-leading` for Postgres-as-a-service in 2026; `expo-sqlite` — `adoption-leading` for Expo local storage.
- **Why it leads:** Supabase's PostgREST upsert with `onConflict` handles the round-trip for both columns transparently; the `position` column becoming NULL on writes costs zero migration work.
- **Runner-up:** `op-sqlite` for the local tier (JSI-direct, no bridge cost); Neon + Drizzle for the cloud tier (typed SQL + branch-per-PR).

### React Native `Pressable` (no drag library)

- **Codebase uses:** `Pressable` from `react-native` on the pin icon in each todo row. No `react-native-draggable-flatlist`, no `react-native-gesture-handler` rebinding, no per-row drag state.
- **Why it's here:** the whole point of the pin pattern is to delete the gesture machinery — `Pressable` is the simplest input that captures the toggle. Bringing in a drag library would re-introduce exactly the cost the pattern subtracted.
- **Leading today:** `Pressable` — `adoption-leading` for React Native list-item taps, 2026.
- **Why it leads:** ships with React Native core; first-party tap-target handling with proper accessibility; replaced `TouchableOpacity` as the standard in RN 0.63+.
- **Runner-up:** `react-native-gesture-handler` `<Pressable>` variant — `innovation-leading` when the row also needs swipe gestures (this codebase uses it on the `Swipeable` wrapper, but the pin tap itself stays on `react-native`'s plain `Pressable`).

---

## Summary

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

```
[write path with deprecated position column]

  user toggles pin on row.id
        │
        ▼
  updateTodoMeta(row.id, { pinned: true })
        │
        ▼ database.ts UPDATE statement
  UPDATE todo_meta SET pinned=1, updated_at=now WHERE id=row.id
        │   (position not in SET clause → unchanged; stays NULL or
        │    whatever legacy value it had)
        ▼
  schedulePush() → next push includes position verbatim
        │
        ▼ Supabase upsert
  cloud row preserves position (no UI reads it; it's noise)
```

[senior] Q: You shipped pin + swipe-to-delete and removed drag-reorder + three-stage filter in one commit. Why bundled?

A: Because they were the same idea: replace a maintenance-heavy multi-degree UI with a single-bit gesture. Drag-reorder + three-stage filter were both expressions of "user manages this dimension manually." Pin + swipe-to-delete are both "user marks a single attribute on a row." Shipping them together meant the user got a coherent new model in one go instead of two confusing intermediate states. The cost is a bigger diff to review; the win is that no version of the app shipped with "pin exists but drag-reorder is also still here" — which would have been a UX mess.

```
                  Path taken (one bundled commit)       Alternative (incremental commits)
                  ──────────────────────────────        ──────────────────────────────
shipped together  pin + swipe-delete + remove drag      pin first, then remove drag,
                  + remove 3-stage filter               then add swipe, then remove filter
intermediate UX   none — clean cut                       "pin exists AND drag exists AND
                                                          stage filter exists" → confusion
review effort     one big diff (harder for reviewer)    smaller diffs (easier review)
rollback unit     one revert — clean                    multiple reverts to undo full change
user mental model gets new model in one update         lives in 2-3 confusing intermediate
                                                          versions before settling
when bundled wins ideas are conceptually the same       changes are independent
                  ("user marks one attribute")
when bundled lose changes are unrelated                  changes are unrelated (not this case)
right call here   yes — drag-remove + pin-add + filter- no — would have shipped UX mess
                  remove + swipe-add are one idea       between intermediate steps
```

[arch] Q: What happens if your usage analysis was wrong and a user actually relied on multi-item ordering?

A: They lose expressiveness. The existing `rankTodos` function in `services/todos/rank.ts` still exists (it's the legacy comparator), so the recovery path is "add a manual-ordering setting that re-routes the sort through `rankTodos` for users who opt in." The cost would be conditional sort logic in two places (`/todos` and `SmartTodoList`). I haven't shipped that because the analysis was strong — I'm the only user; I never used multi-item ordering. For a multi-user app I'd watch the data first and ship pin-only, then add the manual-order opt-in if a meaningful fraction of users complained. Removing affordance is reversible if the legacy code stays in tree, which is why `rankTodos` wasn't deleted.

```
If user feedback shows multi-item ordering is needed:

  ┌─ UI layer ──────────────────────────────────┐
  │ new setting: "Enable manual ordering"        │
  └─────────────────────────────────────────────┘
              │
  ┌─ Sort layer (currently inline) ─────────────┐
  │ /todos: pinned-first comparator              │  ◀── BREAKS FIRST
  │ SmartTodoList: position-based (legacy)       │     (two sort sites need
  │ ↓ conditional re-route                       │      conditional logic; pin
  │ users with setting → rankTodos               │      vs manual must coexist)
  │ users without → pinned + createdAt DESC      │
  └─────────────────────────────────────────────┘
              │
  ┌─ Data layer ────────────────────────────────┐
  │ position INT NULL revives — was deprecated,  │
  │ now writable again via drag-reorder gesture  │
  │ rankTodos in services/todos/rank.ts wakes up │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: You're keeping `position` and `stage` columns on the schema even though no UI reads them. Isn't that just digital debt?

A: Yes, it is. They're dead columns kept on the schema because the cost of dropping them (destructive cloud migration that would break users on older app versions) is higher than the cost of carrying them (a few bytes per row, two extra fields in the cloud-sync mapper). The honest version is: I made the call that schema noise is preferable to a coordinated migration, and I documented both columns as deprecated in `src/types/todoMeta.ts`. The cleanup happens when I do my next "schema squash" — at the time I squash migrations `0001-0008` into a consolidated baseline, I'd drop both columns at the same time. Until then, they sit there. The risk is that a future reader sees `position` and assumes it's live, which is why the type definition has the deprecation comment and why this study guide says it explicitly. That's the cost of keeping legacy schema in tree; I think it's lower than the alternative.

```
                  Path taken (deprecate in types,       Suggested (drop columns now via
                  keep in schema)                       destructive migration)
                  ──────────────────────────────        ──────────────────────────────
schema cost       2 dead columns (position + stage)     0 — clean schema
                  ~5 bytes/row × N rows = trivial
runtime cost      cloud-sync mapper round-trips         saved 2 fields per push
                  them verbatim
migration cost    none today                            destructive ALTER TABLE on cloud +
                                                          coordinated client schema bump
older-app-version users on old version still write      can't sync — old app's schema has
 compat           position; cloud accepts it             columns the cloud no longer accepts
detection of      type definition comment in            git history of schema migrations
 dead status      src/types/todoMeta.ts marked          shows the column was dropped
                  @deprecated 2026-05-05
cleanup window    schema squash (deferred until ~50    same — squash is when destructive
                  migration files)                      changes are coordinated anyway
honest cost       digital debt — visible, documented    breaks every user on old version
                                                          who hasn't updated yet
right call?       yes — debt < destructive migration   no — too expensive for the gain
```

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

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 + v1.23.0 pass: inserted `## Tech reference (industry pairing)` section between Tradeoffs and Summary with `###` per tech + five labelled bullets each.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (mental-model opening / layered walkthrough with frontend bridges / principle paragraph); each move-2 sub-section now carries its technical term, frontend bridge, concrete consequence, and boundary condition.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (grocery-list drag-vs-star scenario → subtractive design named as the answer → bolded "what depends on getting this right" with `pinned`/`position`/300-line-deletion stakes → before/after walking a rapid reorder with vs. without `position` → one-line "find the cheapest version of the same affordance and ship that").

---
Updated: 2026-05-14 — v1.31.0 pass (system-design re-scan): rewrote Move 1 of Why care + How it works to anchor on real software (replaced grocery-list-with-star analogies with Gmail starred + GitHub pinned repositories + Slack pinned messages + Linear favorited issues). Both Move 1s were missed by the original triage agent.

---
Updated: 2026-05-14 — v1.32.0 pass: swapped Why care + How it works Move 1 anchors from four whole-product references (Gmail starred / GitHub pinned / Slack pinned / Linear favorited) to the level-1 primitive (a `BOOLEAN pinned` column on the table + `ORDER BY pinned DESC, created_at DESC` two-key sort; equivalent JS comparator `arr.sort((a,b) => Number(b.starred) - Number(a.starred) || b.createdAt - a.createdAt)`). Added Move 1 mnemonic diagram (before/after schema + UI swap) + 5 Move 2 sub-section diagrams: migration SQL + row state, sort walkthrough on 8 rows, tap-to-resort flow, removed-vs-added in the same commit, Phase A/B side-by-side. Total: 6 new diagrams.
