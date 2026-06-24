# Single-source-of-truth principle

**Industry name(s):** Single source of truth (SSOT), canonical data store
**Type:** Industry standard · Language-agnostic

> The journal text in `entries.text` is the only writable surface for drops; everything else (`todos_json`, `todo_meta`, `nutrition`, `thread_mentions`) is derived state, rebuilt from prose at commit time.

**See also:** → [04-two-pass-matching](./04-two-pass-matching.md) · → [06-one-to-one-invariant](./06-one-to-one-invariant.md) · → [12-manual-touch-deviation](./12-manual-touch-deviation.md)

---

## Why care

Open a React app where the same value lives in two places — component state AND a Redux store, or `useState` AND URL params, or local state AND a server-side cache — held together by a comment promising they stay in sync. Inevitably someone updates one and forgets the other; a refresh shows different values from a click; the bug isn't that any single write went wrong, it's that the same fact was writable in multiple places. Every senior frontend engineer eventually learns the fix: pick one canonical source and derive every other view from it. Redux makes it explicit at the store layer; React Query makes it explicit at the cache layer; the database equivalent is naming one table the source of truth and treating everything else as a materialised view.

The question that pattern answers is the same one any system with derived data has to answer: which copy of a fact is allowed to change, and which copies are required to follow it? Not "do we have a database" — that's the storage question. The interesting answer is *single source of truth*: name one writable surface as canonical, treat every other representation as a cache that gets rebuilt from it.

**What depends on getting this right:** whether "the user edited the line and the row updates" is a universal property or a per-feature affordance you have to wire up by hand. In this codebase the canonical surface is `entries.text` — the journal prose, edited by the user. Every typed table downstream — `todo_meta`, `nutrition`, `thread_mentions` — is derived state, rebuilt by scanners (`scanTodosFromText`, `scanNutrition`, `parseTags`) at commit boundaries (focus blur, screen leave). If someone adds a UI button that writes directly to `todo_meta` without a corresponding prose edit, the next scanner pass sees a row whose `todoId` isn't in the prose's `todos_json` array and soft-deletes it on the spot — the derived row vanishes because the rule says only prose can spawn one.

Without the rule (any table is writable):
- A "quick edit" button updates `todo_meta.text` directly to fix a typo
- The user later edits the same line in prose; `scanTodos` produces an item whose text no longer matches the row
- Two-pass matching falls through to line-index; pass 2 happens to claim the right row but only because the user didn't reorder
- A week later they reorder; the typo-edited row binds to the wrong line; AI classifier results migrate to the wrong todo

With the rule (only prose is canonical):
- The user edits the line in prose; `entries.text` updates
- `scanTodos` re-runs at focus blur; the reconciler matches by id, leaves `todo_meta.type` and `expanded_md` alone
- Every derived row points back at exactly one prose line
- Bug-search shrinks to "which scanner produced this row?"

Prose is the Redux store; every typed table is a selector — derived on read, never written directly.

---

## How it works

Redux's single store with one root reducer is the same shape. The store is `entries.text` — every drop the user typed, in the order they typed it. The derived selectors are `todos_json`, `todo_meta`, `nutrition`, `thread_mentions` — typed views the UI reads to render lists, counts, and charts. The rule is that the store is the only writable surface, and the selectors recompute from it whenever the underlying text changes. React Query's `queryClient` as a derived cache over server state works the same way: one canonical fetch, many cached projections.

The store-and-selectors shape, applied to a journal entry:

```
        entries.text (canonical store)
                │
                │  scanners + reconcilers at commit boundary
                ▼
   ┌────────────┬────────────────┬──────────────┐
   ▼            ▼                ▼              ▼
 todos_json   thread_mentions  nutrition      (habits has NO
   │          rows             rows            scanner — it's a
   ▼                                           first-class entity)
 todo_meta
 (1:1 with each TodoItem)
```

Every typed table on the right is a *selector* in Redux terms — derived on commit, never written directly. The five sub-sections below trace each layer: the store, the scanner, the reconciler, when they run, and the two documented exceptions.

### The canonical surface — `entries.text`

The user's keystrokes land in `entries.text`, a TEXT column on the `entries` table. Drops are encoded inline as markers: `[]` for todos, `** food N kcal` for nutrition, `#tag` for thread mentions. If you're coming from frontend, you're used to controlled inputs where state lives in `useState` and the rendered DOM mirrors that state — same idea here, except the React state is the SQLite column and the "DOM" is every derived row that exists downstream. If the user types `[] call mom` at t=0 and the autosave fires at t=1ms, the line is in `entries.text` immediately; nothing else has moved yet. The rule holds as long as there is exactly one writer for any given prose surface — multi-device editing of the same `entries.text` row would need CRDT semantics on the prose itself before the rest of the chain keeps working.

What the user wrote, sitting in one TEXT column with every drop encoded inline:

```
entries
┌────────┬───────────┬───────────────────────────────────────────┐
│ id     │ user_id   │ text                                       │
├────────┼───────────┼───────────────────────────────────────────┤
│ e-1    │ user-A    │ "Morning notes\n                          │
│        │           │  [] call mom\n                            │  ◄── todo marker
│        │           │  ** banana 90 kcal\n                      │  ◄── nutrition marker
│        │           │  thinking about #work-q4 reviews"          │  ◄── thread marker
└────────┴───────────┴───────────────────────────────────────────┘
```

One column, the user's keystrokes verbatim, with sparse markers embedded in the prose. No derived row exists yet — that work happens later.

### The scanner — one function per prose-derived feature

A scanner is a pure function over a prose string. `scanTodosFromText(text)` reads `entries.text`, walks every line, and returns an array of `TodoItem` objects. `parseTags(text)` does the same for `#tag`. `scanNutrition(text)` for `** food N kcal`. If you've ever written a custom parser for a React form field — extracting `@mentions` from a comment box, say — you've written this exact thing. The codebase has no parser-combinator library; the scanners are hand-written regex-plus-state-machine functions, ~100–200 lines each, because the marker grammar is sparse enough that a library would add weight without adding correctness. The concrete consequence: if a scanner has a bug, every wrong derived row points back at one named function — there's exactly one place to fix it.

A scanner is a pure `(text) => array` function — same shape as a `.map()` callback the reader has written a hundred times:

```
   scanTodosFromText("Morning notes\n[] call mom\n[] write spec\n[x] book dentist")
                                       │
                                       ▼  walk lines, regex-match '[]' / '[x]'
                                       │
   returns: [
     { id: "t-A", text: "call mom",     done: false, sourceLine: 1 },
     { id: "t-B", text: "write spec",   done: false, sourceLine: 2 },
     { id: "t-C", text: "book dentist", done: true,  sourceLine: 3 }
   ]
```

Pure function, no side effects, no DB writes — the scanner only *produces* the array. The reconciler in the next sub-section is what merges it into the DB.

### The reconciler — diff scanner output against existing DB state

A scanner produces an array; the reconciler takes that array and merges it into the DB. `reconcileTodoMetaForEntry(entry_id, items)` is the canonical example: it pulls the existing `todo_meta` rows for this entry, matches each scanner-produced item against them (via two-pass matching — see [04](./04-two-pass-matching.md)), inserts what's new, soft-deletes what's missing, and leaves matching rows alone. Think of it like React's reconciler diffing a new virtual DOM against the previous one to decide what to mount, update, and unmount — except here the "virtual DOM" is the scanner output and the "real DOM" is the SQLite rows. The concrete consequence: when a user deletes the line `[] call mom`, the scanner returns an array without that item, the reconciler diffs the ids, and the orphaned `todo_meta` row gets `deleted_at` stamped — no DELETE TODO code path, no button handler, no event listener. The todo went away because the prose did. Boundary: this fails if a contributor adds a write path that mutates `todo_meta` *without* a prior prose change — that would create a row the next scanner pass thinks is orphaned and soft-deletes immediately.

Walking the diff when the user deletes the `[] call mom` line:

```
   existing todo_meta rows for entry e-1 (in DB):
   ┌─────────┬────────────┬────────────────────┐
   │ todoId  │ type       │ expanded_md         │
   ├─────────┼────────────┼────────────────────┤
   │ t-A     │ personal   │ "Mom's birthday..." │
   │ t-B     │ work       │ "Spec for v2..."    │
   └─────────┴────────────┴────────────────────┘
                          │
                          ▼  reconcileTodoMetaForEntry
   today's scanner output (after user deleted "call mom" line):
   ┌─────────┐
   │ t-B     │   ◄── only t-B survives in the prose
   └─────────┘
                          │
                          ▼  reconciler diffs by todoId
   result:
     t-A → orphan        → stamp deleted_at (soft-delete)
     t-B → still present → leave row untouched (type, expanded_md preserved)
```

No "delete todo" handler exists in the codebase — the row vanished because the prose did.

### The commit boundary — when scanners run

Scanners do not run on every keystroke. They run at *commit boundaries* — focus blur on the journal text input, screen leave (navigating away from `journal/[date]`), and a few explicit save events. In React terms, this is like deferring an expensive `useMemo` until a `useEffect` cleanup fires; the cheap path (keystroke → DB) stays cheap, and the expensive path (parse + diff + write) batches up the work. Concrete consequence: while the user is mid-burst typing, `todos_json` is stale by a few hundred milliseconds — but no UI surface reads `todos_json` during keystroke entry; the user is looking at the prose, not at the derived view. When they tab away or close the screen, the catch-up happens in one pass. The boundary breaks down if any UI surface starts reading derived state during the typing burst — at that point either the scanner runs more often or the UI reads from a different source.

Walking what fires when, on a typing-then-blur timeline:

```
 Time      User action                          Scanner runs?
   │         │                                     │
   0ms       types '['                              ✗ keystroke autosave only
   100ms     types '] call mom'                     ✗ still typing
   500ms     types '[] write spec'                  ✗
   1.5s      pauses (still focused on textarea)     ✗ focus not lost
   2.0s      taps a different field (focus blur)    ✓ scanTodos fires
   2.5s      taps back into journal, edits          ✗ resumed typing
   5.0s      navigates away (screen leave)          ✓ scanTodos fires again
```

Scanners fire on the transitions where typing *stops* — never on the keystrokes themselves. That's how the keystroke path stays single-digit-millisecond cheap.

### The principled exceptions

Two carve-outs are documented in the spec:

- **Habits are first-class.** There's no `scanHabits`. The user creates and edits habits in the `more/habits` screen with explicit form fields for cadence type, days-of-week, and time-of-day bucket. The reason: cadence metadata (e.g. "Tuesdays + Thursdays at 7am") doesn't fit inline in prose. Forcing it would either expand the marker grammar or pollute the journal with structured strings the user didn't type. The cost of the exception is that habits don't appear in journal exports unless the user mentions them.
- **The manual-touch deviation** (see [12](./12-manual-touch-deviation.md)) — `toggleThreadTouchToday` writes a `thread_mentions` row with NULL `entry_id` AND NULL `todo_id`. This is the one published exception to "every derived row points back at prose," scoped to a single function, capped at a budget of 1. The discipline isn't refusing to carve; it's making the carve named, bounded, and visible.

If you're coming from frontend, both exceptions are familiar — they're the same shape as React's escape hatches (`useRef` for non-rendering state, `flushSync` for breaking the batching contract). The framework's discipline survives because each escape is in a named file, the reviewer can see it, and the carve-out itself is documented in `docs/spec.md` alongside the rule.

Mapping every feature back to its source surface — the rule and the exceptions in one view:

```
   Feature              Source surface                     Prose canonical?
   ──────────────       ──────────────────────────         ────────────────
   todos                entries.text '[]' markers          ✓
   nutrition            entries.text '** food N kcal'      ✓
   thread_mentions      entries.text '#tag' markers        ✓  (with one carve-out below)
   habits               user form fields in more/habits    ✗  first-class by design
   thread touch         tap gesture on dashboard           ✗  documented deviation (1 of 1)
```

Two carve-outs in five features. Both are named, bounded, and visible in the spec — the rule survives because the exceptions don't hide.

This is what people mean by "one writable surface, every other representation is a cache." Once you accept that constraint, the cost of every new derived feature is fixed — one scanner plus one reconciler — and "edit the line, the row updates" becomes a universal rule rather than a per-feature affordance you have to wire up by hand. The full picture is below.

---

## Single-source-of-truth — diagram

```
              prose in entries.text                ←── canonical
                       │
                       │ scanners run at commit (focus blur, screen leave)
                       │
        ┌──────────────┼──────────────────┬─────────────────┐
        ▼              ▼                  ▼                 ▼
  scanTodos      scanThreads         scanNutrition       (no scanner —
        │              │                  │             habits are first-class)
        ▼              ▼                  ▼
  todos_json   thread_mentions       nutrition rows
        │
        ▼
  reconcileMeta
        │
        ▼
  todo_meta (1:1 with each TodoItem in todos_json)
```

---

## In this codebase

This principle is cross-cutting; the four scanner+reconciler pairs that enforce it are:

**Todos scan:**       `src/services/todos/scanTodos.ts` → `scanTodosFromText()` L53–L138 — extracts `[]` lines from prose
**Todos reconcile:**  `src/services/todos/reconcileMeta.ts` → `reconcileTodoMetaForEntry()` L48–L92 — keeps `todo_meta` 1:1 with `todos_json`
**Threads scan:**     `src/services/threads/scanThreads.ts` → `parseTags()` L37–L64 + `reconcileMentions()` L169–L230 — extracts `#tag` mentions
**Nutrition scan:**   `src/services/nutrition/scan.ts` — extracts `** food N kcal` lines

The principle's anchor is the call site that fires all of these on every prose commit (focus blur, screen leave). Habits are the deliberate non-derived first-class entity (no `scanHabits`).

---

## Elaborate

### Where this pattern comes from
The "single source of truth" idea is older than databases — it's a normalisation principle. The interesting move buffr makes is choosing *prose* as the source rather than a structured form. That's borrowed from tools like Roam, Logseq, and Obsidian, where you write naturally and the structure is parsed out behind you.

### The deeper principle
**Pick one surface as canonical, even if it costs you.** A second writable surface means you'll spend forever syncing them. Buffr would have been simpler in the short term with a "add todo" button writing directly to `todos_json`, but the long-term cost is that "delete the line, todo disappears" stops working — and the data drifts every time the two surfaces disagree.

### Where this breaks down
- Operations that have no natural prose representation (the manual-touch deviation is exactly this — see [12](./12-manual-touch-deviation.md)).
- Bulk imports where typing prose for hundreds of rows is impractical.
- Multi-author content where the prose is owned by one person and the metadata by another.

### What to explore next
- [Two-pass matching](./04-two-pass-matching.md) → how identity survives prose edits.
- [The 1:1 invariant](./06-one-to-one-invariant.md) → the reconciler that enforces this principle for `todo_meta`.
- [Manual-touch deviation](./12-manual-touch-deviation.md) → the documented exception.

---

## Tradeoffs

We traded per-feature plumbing for a universal data-flow rule: every prose-derived feature pays for one scanner plus one reconciler, in exchange for "edit the line, the row updates" working without per-feature glue code.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (prose canonical)   │ Alternative (button writes JSON) │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Complexity       │ +1 scanner +1 reconciler per   │ +1 direct write path per       │
│                  │ feature (~150 LOC each, 4 in   │ feature + sync logic between   │
│                  │ tree: todos/threads/nutrition/ │ prose and structured surfaces  │
│                  │ reconcileMeta)                 │                                │
│ Latency          │ scanners deferred to commit    │ direct insert ~5ms; but        │
│                  │ boundary (focus blur / leave); │ "delete line" path still needs │
│                  │ keystroke autosave stays cheap │ a scan to clean up derived row │
│ Cognitive load   │ "prose canonical, rest derived"│ contributor must remember to   │
│                  │ — one rule across 4 features   │ write BOTH surfaces every time │
│ Drift risk       │ zero — single writable surface │ real — surfaces drift the first│
│                  │                                │ time someone forgets to mirror │
│ Failure blast    │ scanner bug → derived state    │ surface-sync bug → derived     │
│                  │ wrong, prose intact (recover by│ state diverges silently from   │
│                  │ rerunning the scanner)         │ prose; no recovery path        │
│ Hire-ability     │ pattern is novel — onboarding  │ pattern is conventional — but  │
│                  │ adds half a day to learn       │ the drift bugs cost weeks     │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

Every prose-derived feature pays a fixed structural cost: a scanner that extracts the marker from `entries.text`, plus a reconciler that diffs the scanner's output against what's already in the DB. Today that's `scanTodos.ts` + `reconcileMeta.ts` (~190 LOC), `scanThreads.ts` + `reconcileMentions` (~230 LOC), and `nutrition/scan.ts` (~120 LOC). The fifth feature — habits — broke the rule on purpose because cadence metadata wouldn't fit inline; the cost of that exception is that habits don't appear in journal exports unless the user mentions them.

The keystroke path stays cheap because scanners run only at commit boundaries (focus blur, screen leave) — but that means during typing the derived state is stale by up to a few hundred ms. We accepted this because no UI surface reads `todos_json` during keystroke entry; the user is in the prose, not in the derived view.

The pattern is genuinely novel — a new contributor reads `reconcileMeta.ts` and asks "why isn't there a foreign key?" The answer (SQLite can't FK to a JSON-array element; the application reconciler is the enforcement mechanism) takes a paragraph in the spec to explain. That's onboarding cost we pay every hire.

### What the alternative would have cost

If we had given the dashboard a "+ todo" button that wrote directly to `todos_json`, the up-front complexity would have dropped by ~150 LOC (no scanner needed for the button path). But the moment two surfaces can write the same data, "delete the line in prose, the todo disappears" stops being a universal rule. We would have had to either (a) also append a `[]` line to prose on every button press (which is what the dashboard quick-add actually does — preserving the rule), or (b) accept that some todos exist only in `todos_json` with no prose representation. Option (b) is where drift bugs live: the user deletes the prose line and the todo persists, looking like a sync bug. We'd ship that bug at least once per quarter.

The hidden cost is debugging. With prose canonical, every wrong derived row points back at a wrong scanner — one place to fix. With two surfaces, a wrong derived row could be a scanner bug, a button-handler bug, a sync-between-surfaces bug, or a race. Three new failure modes for the one feature we shaved 150 LOC off.

### The breakpoint

Fine until the app becomes multi-author or supports concurrent prose edits across devices. At that point "prose is canonical" assumes a single writer; two writers produce different `todos_json` arrays from different prose versions, and the LWW conflict resolver picks one and silently discards the other. The fix isn't on the scanners — it's on the prose itself, which would need CRDT semantics (Y.js, Automerge). The pattern survives that change; the canonical *layer* changes from "raw text" to "CRDT-text."

### What wasn't actually a tradeoff

Auto-deriving rows from text via an ORM-style schema mapper wasn't on the table. The canonical surface is free-form prose with sparse markers (`[]`, `** food N kcal`, `#tag`) — not a typed structured form an ORM can consume. The hand-written scanners do the work an ORM can't.

---

## Tech reference (industry pairing)

### expo-sqlite (WAL)

- **Codebase uses:** `expo-sqlite` in WAL mode against `buffr.db`, opened only from `src/services/database.ts`. The `entries.text` TEXT column is the canonical surface.
- **Why it's here:** the synchronous TEXT column that makes "keystroke → autosave → read-back at next render" possible — if prose lived anywhere asynchronous, the canonical-surface rule collapses on every typing burst.
- **Leading today:** `expo-sqlite` — `adoption-leading`, 2026.
- **Why it leads:** ships with the Expo SDK; WAL mode gives readers a stable snapshot while writers commit; mirrors the SQLite C API with zero bridge cost.
- **Runner-up:** `op-sqlite` — `innovation-leading` JSI-direct binding with no bridge cost; the perf-tier choice for bare React Native projects.

### Hand-written scanners (no parser library)

- **Codebase uses:** `src/services/todos/scanTodos.ts → scanTodosFromText()`, `src/services/threads/scanThreads.ts → parseTags()`, `src/services/nutrition/scanNutrition.ts`. Each is a regex-plus-state-machine TS function, ~100–200 LOC, no parser-combinator dependency.
- **Why it's here:** each scanner extracts one marker class (`[]` / `#tag` / `** food N kcal`) from a prose string and returns a typed array — that array is what the reconciler diffs against the DB.
- **Leading today:** hand-written matchers — `adoption-leading` for sparse-marker text formats, 2026.
- **Why it leads:** the marker grammar is intentionally sparse; a parser combinator would add weight (typed grammar, error recovery) without adding correctness for ~150-line scanners.
- **Runner-up:** `chevrotain` / `nearley` — `innovation-leading` parser combinators with typed grammars; the right move once the marker grammar grows beyond ~5 markers or starts needing recovery on malformed input.

---

## Summary

Single source of truth is the discipline of designating exactly one writable origin for each fact, with every other representation derived from it deterministically — pick one surface as canonical, treat everything else as a cache you can throw away. In this codebase the prose in `entries.text` is canonical; markers like `[]`, `** food N kcal`, and `#tag` are the source, and `scanTodosFromText`, `parseTags` + `reconcileMentions`, and `src/services/nutrition/scan.ts` rebuild `todos_json`, `thread_mentions`, and nutrition rows at every commit boundary (focus blur, screen leave). The constraint was a single editable place — two writable surfaces would drift, and "delete the line, the row disappears" stops working the moment a button writes directly to `todos_json`. The cost is that every prose-derived feature needs its own scanner plus reconciler, and operations with no natural prose representation (the documented manual-touch deviation) become exceptions. Habits are first-class entities by design because cadence metadata won't fit inline; that's the principled exception, not a regression.

Key points to remember:
- Prose in `entries.text` is canonical; `todos_json`, `todo_meta`, `thread_mentions`, and nutrition rows are rebuilt from prose by scanners.
- Scanners run at commit boundaries (focus blur, screen leave), not on every keystroke — the keystroke path stays cheap.
- Lives in step 1 (Data model) of the system-design checklist.
- The dashboard's quick-add path preserves the invariant by appending a `[]` line to prose, not by writing directly to `todos_json`.
- Habits have no `scanHabits` because they're first-class user-managed entities; the manual-touch deviation is the documented one-off exception.

---

## Interview defense

### What an interviewer is really asking
The interviewer wants to know whether you understand the cost of declaring a single source of truth — most engineers say "single source of truth" as a slogan and then build two writable surfaces anyway. The probe is: did you actually live by it, and what did you give up to live by it?

### Likely questions

[mid] Q: A user types `[] call mom` then deletes the line. Walk me through what happens to the corresponding `todo_meta` row.

A: The keystroke autosaves prose to `entries.text` in SQLite. At the next commit boundary (focus blur, screen leave), `scanTodosFromText` runs — the deleted line produces no match, so the corresponding `TodoItem` is dropped from `todos_json`. Then `reconcileTodoMetaForEntry` diffs the new `todos_json` ids against the existing `todo_meta` rows and soft-deletes the orphan. There's no "delete todo" code path; the todo went away because the prose did.

```
[delete-the-line flow]

  user deletes "[] call mom"
        │
        ▼  autosave on keystroke
  entries.text in SQLite (canonical, "call mom" line gone)
        │
        ▼  at commit boundary (focus blur / screen leave)
  scanTodosFromText reruns
        │   "call mom" matches nothing → dropped from todos_json
        ▼
  reconcileTodoMetaForEntry diffs ids
        │   row whose id isn't in todos_json → soft-delete
        ▼
  todo_meta row stamped deleted_at, removed from UI
```

[senior] Q: Why didn't you give the dashboard a "+ todo" button that writes directly to `todos_json`? It would be one less round-trip.

A: Because the moment two surfaces can write the same data, they drift. If I add a todo via a button, I either have to also add a `[]` line to the prose (so the canonical surface stays correct), or I accept that "delete the line, todo disappears" stops being a universal rule. The dashboard's quick-add path takes the first option — it appends a `[]` line to the day's entry text, then re-runs the scanner. It's a few more lines of code, but it preserves the invariant that the prose is the only writable surface for drops.

```
                  Path taken (append-to-prose)        Alternative (direct todos_json write)
                  ──────────────────────────────      ──────────────────────────────────
write surfaces    1 (prose only)                      2 (prose + button)
round-trips       1 (button → append text → scan)    1 (button → insert JSON)
"delete the line  works universally                   breaks for button-created todos
 deletes the row"
drift             impossible — single source          eventual — surfaces disagree
debugging         wrong row → wrong scanner           wrong row → could be 4 causes
                  (one place to look)                 (scanner, button, race, sync)
extra LOC         ~20 (append + invoke scanner)       ~5 (direct insert)
```

[arch] Q: How does this principle scale to a multi-author or collaborative version of the app?

A: Badly without changes. "Prose is canonical" assumes one writer. With two writers, you get the same problem as collaborative document editing — concurrent edits to the same prose line can both produce or both destroy a derived row, and neither writer is wrong. The fix would be to keep prose canonical but apply CRDT semantics on the prose itself (Y.js, Automerge), letting the scanners run after every converged state. The scanner pattern stays; the canonical layer changes from "raw text" to "CRDT-text".

```
At 2 writers (multi-device) editing the same day's prose:

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged — both devices show their state   │
  └─────────────────────────────────────────────┘
              │
  ┌─ Scanners (todos / threads / nutrition) ────┐
  │ unchanged shape, but assume single-writer    │  ◀── BREAKS FIRST
  │ Device A produces todos_json_A               │     (concurrent prose →
  │ Device B produces todos_json_B               │     conflicting derived state →
  │ LWW conflict resolver picks one, drops other │     silent identity loss)
  └─────────────────────────────────────────────┘
              │
  ┌─ Canonical layer (raw entries.text) ────────┐
  │ would need to become CRDT-text (Y.js /      │  ◀── needs replacement
  │ Automerge) so concurrent edits converge     │
  │ deterministically before scanners run        │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: The manual-touch deviation breaks your "prose is canonical" rule. Why is that one exception OK and not others?

A: It's not really OK — it's the smallest exception I could justify, and I documented it loudly in the spec (Principle 11). The dashboard's "tap a thread to mark it touched today" gesture writes a `thread_mentions` row with NULL `entry_id` AND NULL `todo_id` because there's no prose line to attach it to. I considered making the touch gesture insert a synthetic prose line, but that pollutes the journal with rows the user didn't type. The exception is permitted because the staleness math composes uniformly — the touch row counts the same as a prose-derived row when computing "did this thread happen today?". The rule the deviation respects is that the *derived shape* (a row in `thread_mentions`) is canonical-equivalent to a prose-derived row; only the source differs. If I needed a second exception, I'd revisit the architecture; one is the budget.

```
                  Path taken (one documented deviation)   Suggested (synthetic prose insert)
                  ────────────────────────────────────    ────────────────────────────────────
write source      gesture → thread_mentions row           gesture → append "touched #tag" line
                  (NULL entry_id, NULL todo_id)           to prose, scanner derives the row
journal export    touch rows excluded by design           journal pollutes with rows the user
                                                          didn't type — confusing on read-back
prose integrity   prose stays user-typed only             prose mixes user text + UI artifacts
staleness math    uniform — touch counts the same         uniform — same outcome via prose
exception budget  1 documented, capped                    0 — rule preserved nominally, but
                                                          the rule is now "prose canonical
                                                          OR app-generated prose" — a softer
                                                          rule that invites more exceptions
contributor       reads the deviation, asks why, learns   reads synthetic prose, can't tell
 onboarding       the rule has one published exception    user from app — no rule visible
```

### One-line anchors
- "Prose is canonical — the cost is a scanner per feature, the win is that 'edit the line, the row updates' works without per-feature plumbing."
- "Two writable surfaces always drift; one writable surface plus derivers is the discipline."
- "The scanners run at commit boundaries, not on every keystroke — the keystroke path stays cheap."
- "Habits are first-class because cadence metadata won't fit inline; that's the principled exception, not a regression."
- "The manual-touch deviation is the documented one-off; one exception is the budget I gave myself."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain "prose is canonical for drops" to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/todos/scanTodos.ts:scanTodosFromText` (and its sibling reconciler)
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user goes into the dashboard's quick-add and types "remember to call mom" — adds it as a todo via the button (not via prose). What does the system do to keep "prose is canonical" intact? Then: the same user opens the journal entry that the quick-add wrote into and deletes the line. What happens to the todo, the `todo_meta`, the `thread_mentions` (if any), the `expanded_md`?

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/scanTodos.ts` and `src/services/todos/reconcileMeta.ts` to check.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/scanTodos.ts` (the scanner pattern) to support what exists
→ Point to `src/services/threads/touch.ts` (the documented manual-touch deviation) if you chose the alternative — show what a *second* deviation would actually cost

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.
