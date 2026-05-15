# Manual-touch deviation (Principle 11)

**Industry name(s):** — (project-specific exception to derived-from-prose invariant)
**Type:** Project-specific

> The only place the app writes a `thread_mentions` row whose `entry_id` and `todo_id` are both NULL. Marks "I touched this thread today" without any prose attribution.

**See also:** → [03-single-source-of-truth](./03-single-source-of-truth.md)

---

You've got a TypeScript codebase with `strict: true` and an ESLint rule that bans `any`. One file — `src/legacy-bridge.ts` — has a single `as any` cast on a single line, with a `// eslint-disable-next-line @typescript-eslint/no-explicit-any` comment above it plus a paragraph explaining why: a third-party library's types are wrong, the workaround is contained, the typed wrapper alternative would be 200 lines. The rule survives because the exception is *named, bounded, and visible* — anyone reading the file sees both the cast and the reason. The rule doesn't survive if a second `as any` slips into another file undocumented, and a third, because at that point the rule is just "sometimes typed."

The question that named-exception pattern answers is one every architecture with an invariant eventually has to answer: there will be one or two cases that don't fit the rule. Do you weaken the rule until it accommodates everything (no rule), or do you keep the rule and document each exception in the same place the rule lives? The answer is a *named carve-out*: keep the principle, enumerate the exception, scope it to one named function, and cap the budget at one.

**What depends on getting this right:** whether Principle 11 ("every prose-derived row points back at prose") stays a load-bearing contract that downstream readers can rely on, or whether it dissolves into "sometimes a row points at prose, sometimes not, check before you join." In this codebase the prose-derived rule says: every row in `thread_mentions` (and `todo_meta`, `nutrition`) has an `entry_id` or `todo_id` pointing back at the line in `entries.text` that produced it. The deviation is `toggleThreadTouchToday` — a 54-line file, one function — that writes a `thread_mentions` row with `thread_id` set, `entry_id = NULL`, `todo_id = NULL`. It exists because tapping a dashboard thread chip is a *soft commitment* with no natural prose representation (synthesising one would pollute the user's journal with content they didn't type). Downstream readers — `computeStaleness`, the 14-day activity strip — read these NULL-keyed rows as identical to prose-derived rows for the activity count; only the journal export distinguishes them (touch rows are excluded, because there's no prose to print).

Without naming the carve-out (a second deviation slips in unnoticed):
- Someone ships a "quick add nutrition" button that writes to `nutrition` without prose
- A reviewer says "the manual-touch pattern allows non-prose writes; this is similar"
- A third deviation follows for "quick add habit"
- Principle 11 now has 3+ uninstrumented exceptions; downstream code can no longer assume `entry_id` is populated
- The contract dissolves into per-call defensive checks

With the carve-out named and budgeted at one:
- The PR for "quick add nutrition" gets the reviewer question: "can the soft commitment be expressed as prose instead?"
- The answer is yes (`** food 200 kcal` is the existing marker), so the button generates prose, not a direct nutrition write
- Principle 11 remains "prose canonical with exactly one named exception"; the contract survives
- The 54 lines of `toggleThreadTouchToday` stay the only place in the codebase where the invariant doesn't hold, documented next to the principle in `docs/spec.md`

The carve-out is the one `as any` cast with a comment explaining why — named alongside the main rule, scoped to one file, capped at one exception.

---

## How it works

A TypeScript codebase with `strict: true` plus one annotated `// @ts-expect-error` line. Every value flows through the type system by default; the one annotated line is the documented escape hatch, visible in PRs, scoped to one expression. The rule "everything is typed" survives precisely because the exception is named, bounded, and visible. If you've ever shipped a feature flag rollout where the default is "off" but a few user IDs get "always on," the named-exception pattern is the same shape — and the discipline is enforcing that exactly one exception lives in the budget.

The rule + carve-out shape in one picture:

```
   Rule (Principle 11):
   every thread_mentions row points back at prose
   (entry_id IS NOT NULL  OR  todo_id IS NOT NULL)
                       │
                       ▼
   exactly ONE named exception in the whole codebase:
   ┌────────────────────────────────────────────────────┐
   │ toggleThreadTouchToday()                           │
   │   54-line file, one function                       │
   │   writes thread_mentions row with                  │
   │     entry_id = NULL                                │  ◄── deviation
   │     todo_id  = NULL                                │  ◄── deviation
   │   documented in docs/spec.md Principle 11          │
   │   budget = 1 (capped)                              │
   └────────────────────────────────────────────────────┘
                       │
                       ▼
   downstream readers (computeStaleness, activity strip)
   treat both shapes identically → math composes uniformly
```

One rule, one exception, one named function — and a published budget. The four sub-sections below trace each: the rule, the deviation's mechanics, why the downstream math stays uniform, and how the budget keeps the rule alive.

### The rule the deviation violates

Every prose-derived feature in the codebase has the same shape: a marker in `entries.text` (`[]`, `#tag`, `** food N kcal`) gets scanned out and a derived row is written to a typed table (`todo_meta`, `thread_mentions`, `nutrition`). The invariant — Principle 11 in `docs/spec.md` — is that every `thread_mentions` row's `entry_id` or `todo_id` points back at the prose that produced it. If you're coming from frontend, this is the same invariant a typed Redux store has: every state slice has a typed action that produced it, and you can trace any value back to the dispatch that wrote it. Concrete consequence: if you query `SELECT thread_id, count(*) FROM thread_mentions GROUP BY thread_id` and want to know *why* thread X has 7 mentions, the invariant means you can join back to `entries.id` or `todos_json` and see the 7 prose lines that produced them. Boundary: the invariant assumes every gesture that affects thread state has a prose representation to attach to.

The invariant in code form:

```
   for every row r in thread_mentions:
     r.entry_id IS NOT NULL  OR  r.todo_id IS NOT NULL

   (same for nutrition, todo_meta)

   prose source for #loopd in entries.text line 7
                       │
                       ▼  scanThreads / parseTags scan
                       ▼
   thread_mentions row:
   ┌──────────────┬─────────────┬──────────┬────────────┬─────────────┐
   │ thread_id    │ entry_id    │ todo_id  │ source_line│ tag_text     │
   ├──────────────┼─────────────┼──────────┼────────────┼─────────────┤
   │ loopd_id     │ e-1         │ NULL     │ 7          │ "loopd"      │
   └──────────────┴─────────────┴──────────┴────────────┴─────────────┘
                  └─────┬─────┘             └────┬─────┘
                  back-pointer to prose          line in entries.text
```

Every row's `entry_id` joins back to a real line in `entries.text` — that's what "prose canonical" means at the row level.

### The deviation — `toggleThreadTouchToday`

There's exactly one gesture that doesn't fit: the user taps a thread chip on the dashboard's daily-schedule grid for "today" — a soft commitment to the thread without typing anything. `toggleThreadTouchToday` writes a `thread_mentions` row with `thread_id` set, `entry_id = NULL`, `todo_id = NULL`, `source_line = 0`, `tag_text = ''`. The 54-line file is the entire exception — there's nothing else in the codebase that produces a NULL-keyed `thread_mentions` row. Think of it like a TypeScript `as any` cast that lives in one named file with a comment explaining why — the type system survives because the escape is in one place, the reviewer can see it, and the cast itself is documented in `docs/spec.md` Principle 11 alongside the rule it deviates from. Concrete consequence: tap the dashboard chip for thread `loopd` at 3pm. `toggleThreadTouchToday(loopd_id)` inserts `(thread_id=loopd_id, entry_id=NULL, todo_id=NULL, entry_date='2026-05-10', source_line=0, tag_text='')`. The 14-day activity strip for `loopd` now shows today as active. Tap the chip again — the row gets `deleted_at` stamped, the activity strip's today cell goes inactive. Boundary: the deviation is allowed because the soft commitment has no natural prose representation — you can't synthesize a prose line without polluting the user's journal with content they didn't type.

Walking the tap gesture to row insert:

```
   user taps dashboard chip for #loopd at 15:00
              │
              ▼
   toggleThreadTouchToday(loopd_id)
              │
              ▼
   INSERT INTO thread_mentions (
     thread_id   = loopd_id,
     entry_id    = NULL,        ◄── DEVIATION (no prose source)
     todo_id     = NULL,        ◄── DEVIATION (no prose source)
     source_line = 0,
     tag_text    = '',
     entry_date  = '2026-05-10'
   )
              │
              ▼
   14-day activity strip for #loopd now shows today active
              │
              ▼  tap again
              │
   UPDATE thread_mentions SET deleted_at = now()
   WHERE thread_id = loopd_id AND entry_id IS NULL
     AND entry_date = '2026-05-10'
              │
              ▼
   activity strip's today cell returns to inactive
```

54 lines, one function, one toggle behaviour. The cast-with-comment shape: the rule survives because the escape is contained.

### Why the staleness math still composes uniformly

Downstream readers — `computeStaleness`, `getThreadCards`, the 14-day activity strip — all read `thread_mentions` *the same way regardless of source*. The staleness label uses any non-deleted mention regardless of `entry_id`/`todo_id`; the 14-day strip queries the NULL-keyed rows specifically for the "touch" cell shape but treats them as identical to prose-derived mentions for the activity count. If you've worked with React Context, this is the same shape as a context value that's typed identically whether it came from a provider or a default — the consumer doesn't care about the origin. Concrete consequence: if a thread has 3 prose mentions and 2 manual touches in the last 14 days, `computeStaleness` returns "5 mentions, last 0 days ago" — the math is uniform. The activity strip shows 5 active cells, regardless of which were prose and which were touches. Boundary: the uniformity breaks the moment a reader wants to distinguish "prose-derived" from "touch-only" — e.g. the journal export, which by design *excludes* touch rows because they have no prose to print.

For thread #loopd over the last 14 days — what readers see vs what export filters:

```
   thread_mentions rows (after 14 days of usage):
   ┌────────────┬──────────┬───────────┬──────────┐
   │ entry_id   │ todo_id  │ tag_text  │ source   │
   ├────────────┼──────────┼───────────┼──────────┤
   │ e-3        │ NULL     │ "loopd"   │ prose    │
   │ e-7        │ NULL     │ "loopd"   │ prose    │
   │ NULL       │ NULL     │ ""        │ touch    │ ◄── deviation
   │ NULL       │ NULL     │ ""        │ touch    │ ◄── deviation
   │ e-12       │ NULL     │ "loopd"   │ prose    │
   └────────────┴──────────┴───────────┴──────────┘
              │
              ▼  computeStaleness / activity strip read ALL non-deleted rows
              │  (no filter on entry_id / todo_id)
              ▼
   result: "5 mentions, last 0 days ago"
           activity strip shows 5 active cells

   Journal export (the one consumer that DOES distinguish):
   ──────────────────────────────────────────────────────
     SELECT … WHERE entry_id IS NOT NULL OR todo_id IS NOT NULL
     touch rows excluded — no prose to print
```

Same shape, two consumers: most ignore the deviation; the one that has to distinguish it filters explicitly.

### The exception budget — one, capped

The carve-out is allowed because it's the *only* one. The discipline isn't refusing to add exceptions; it's making each exception named, documented in `docs/spec.md` Principle 11, scoped to one function, and capped at a budget. Adding a second deviation (say, a button that writes to `nutrition` without prose) would change the rule's shape from "prose canonical with one named exception" to "prose canonical with N exceptions" — at which point the rule is just "sometimes canonical" and the contract dissolves. If you're coming from frontend, think of it like having exactly one `useEffect` with an empty dep array per file — the rule's spirit survives one carve-out but not a forest of them. Concrete consequence: if a future PR wants to add a second NULL-keyed write site, the reviewer's job is to ask "can the soft commitment be expressed as prose instead?" before the budget gets spent. Boundary: a second deviation forces a rewrite of Principle 11 itself — at that point the architecture, not the rule, has shifted.

How the budget decision flow plays out on a PR proposing a second deviation:

```
   PR proposes: "quick add nutrition" button writes to nutrition
                directly, no prose involved
                       │
                       ▼
   reviewer asks:
   ┌──────────────────────────────────────────────────────────┐
   │ "Can the soft commitment be expressed as prose instead?"  │
   └──────────────────────────────────────────────────────────┘
                       │
              ┌────────┴────────┐
              │                 │
            YES                 NO
              │                 │
              ▼                 ▼
   write a marker            ESCALATE
   into prose                Principle 11 itself
   ('** food 200 kcal'),     needs revision;
   scanner picks it up,      the architecture has
   derived row is            shifted — this is no
   reachable via the         longer a "carve-out"
   normal path; no            decision, it's a rule
   deviation needed          rewrite
              │
              ▼
   Principle 11 stays:
   "prose canonical with ONE named exception"
```

Without the budget, the rule's shape becomes "prose canonical with N exceptions" — at which point the rule is just "sometimes canonical" and the contract dissolves.

This is what people mean by "principled exception." Every architecture rule will need a carve-out eventually; the discipline isn't refusing to carve, it's making the carve-out named, documented, bounded, and visible. One named exception plus a published rule beats five undocumented compromises every time — and the rule survives precisely because its limits are on the page next to it. The full picture is below.

---

## Manual-touch deviation — diagram

```
  Standard mention shape:                    Manual touch shape:
  ─────────────────────────                  ─────────────────────
  thread_mentions row:                       thread_mentions row:
    thread_id     = ...                        thread_id     = ...
    entry_id      = e123      ← from prose     entry_id      = NULL  ← deviation
    todo_id       = NULL                       todo_id       = NULL
    source_line   = 7                          source_line   = 0
    tag_text      = "loopd"                    tag_text      = ""
    entry_date    = 2026-05-07                 entry_date    = 2026-05-07
    deleted_at    = NULL                       deleted_at    = NULL
                                                          ▲
                                              dashboard tap on a thread
                                              row in the daily-schedule grid
```

---

## In this codebase

**The deviation:**     `src/services/threads/touch.ts` → `toggleThreadTouchToday()` (the entire 54-line file is the documented exception — writes a `thread_mentions` row with `entry_id = NULL AND todo_id = NULL`)
**14-day strip:**      `src/services/threads/getThreadCards.ts` L17–L131 — reads `WHERE entry_id IS NULL AND todo_id IS NULL` to build `activeDates` per thread
**UI surface:**        `src/components/home/DailyScheduleGrid.tsx` — the dashboard grid that taps into `toggleThreadTouchToday`
**Staleness math:**    `src/services/threads/staleness.ts` → `computeStaleness()` — consumes any non-deleted mention row regardless of shape (this is what makes the deviation compose)

---

## Elaborate

### Where this pattern comes from
Documented exceptions are common in codebases that hold otherwise-strict invariants. The pattern is to put the exception in code where it's most visible (a service file with a name that calls out the deviation) and to describe it in the spec under the principle it breaks.

### The deeper principle
**A documented exception beats an undocumented one — and beats a poorly-fit invariant.** The 12-principle list says "mentions are derived from prose," but the dashboard's daily-schedule grid genuinely needs a mention-shaped row that isn't from prose. Rather than weaken the principle ("mentions are mostly from prose"), loopd kept the principle strict and called out the one deviation by name.

### Where this breaks down
- Anyone adding a new consumer of `thread_mentions` must remember to handle the manual-touch shape. A consumer that assumes `entry_id IS NOT NULL` would silently exclude these rows.
- A future "delete the entry → cascade-delete its mentions" feature would orphan the manual-touch rows because they have no `entry_id`. (Today they're soft-deleted directly via `touch.ts`, so this isn't an issue yet.)

### What to explore next
- [Single-source-of-truth principle](./03-single-source-of-truth.md) → the principle this deviates from.
- `docs/spec.md` §11 → the canonical principle list and its noted exceptions.

---

## Tradeoffs

We traded principle-purity for honest user UX: the "mentions are derived from prose" invariant gets one documented carve-out so the dashboard can ship a "tap to mark touched" gesture without injecting synthetic prose the user didn't type.

### Comparison table — both costs in one frame

```
┌──────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Path taken (1 documented     │ Alternative (synthetic prose │
│                  │  exception)                  │  line on touch)              │
├──────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Principle stays  │ literally false in 1 path,   │ literally true everywhere    │
│ strict?          │ documented in spec §11        │ (but user reads "fake" prose)│
│ User UX impact   │ touch gesture leaves no      │ touch gesture appends a `[]` │
│                  │ trace in prose                │ or "touched #tag" line       │
│ Consumer audit   │ every reader of              │ no special-case at consumer; │
│ surface          │ thread_mentions must know    │ all rows are prose-derived   │
│                  │ entry_id can be NULL         │                              │
│ Code surface     │ +1 file (touch.ts, 54 LOC) + │ +scanner pattern handles all │
│                  │ +1 special query in          │ rows; no new file but        │
│                  │ getThreadCards.ts             │ scanThreads grows complexity │
│ Schema impact    │ entry_id/todo_id must be     │ no schema change             │
│                  │ NULL-able (already were)      │                              │
│ Reversibility    │ soft-delete the touch row    │ delete the synthetic line —  │
│                  │                              │ disturbs user's prose flow   │
│ Pollutes journal │ no                            │ yes — visible in export      │
│ on read-back?    │                               │ + the user's own re-reading  │
│ Onboarding cost  │ "manual-touch is the one      │ "scanner produces all rows,  │
│                  │ documented deviation" — read  │ even the touch ones" — but   │
│                  │ spec §11 (~5 min)             │ then journal is misleading   │
└──────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### What we gave up

`thread_mentions` is no longer "all rows derive from prose." Any consumer that queries it has to know about the entry-less shape — `getThreadCards.ts` L17–L131 explicitly checks `WHERE entry_id IS NULL AND todo_id IS NULL` to read these rows for the 14-day strip. A new consumer that filters `WHERE entry_id IS NOT NULL` would silently exclude manual-touch rows from its results, breaking staleness or activity views without any error.

The cleanup-on-delete story has a hole. Standard mentions get auto-soft-deleted when an entry is deleted (because `reconcileMentions` produces no match for an absent entry). Manual-touch rows have no `entry_id`, so they survive forever until the user untouches them explicitly. A future "delete all entries from date X" sweep would expect to clean up touch rows from that date and miss them — we'd need a `WHERE entry_date = ?` cleanup path that doesn't exist yet.

The exception's existence raises the onboarding cost for every contributor reading the threads code. The spec's Principle 11 paragraph is the only place this is fully explained; missing it costs ~30 minutes of code-reading to figure out what the entry-less rows are doing.

### What the alternative would have cost

If the touch gesture inserted a synthetic `[]` line (or `touched #tag` line) into the user's prose, the schema invariant would stay literally true — every mention derived from prose, scanner produces all rows. But the user would open their journal and see lines they didn't type, which is the worst kind of UX violation: the app contaminates the user's own writing with metadata it owns.

That hidden cost compounds at export. Journal exports include the prose verbatim — synthetic lines would appear in markdown exports, in any future sharing flow, in any backup. Removing them at export means a special-case filter in every export path, which is just relocating the deviation.

The codebase impact would have been ~30 LOC more in `scanThreads.ts` to recognize and pass through synthetic lines without creating duplicate mentions, plus a synthetic-line writer in `touch.ts` that mutates `entries.text`. The "no new file" saving is nominal because we've added complexity inside `scanThreads` and a permanent UX violation in the prose layer.

### The breakpoint

Fine until a second deviation becomes necessary. If a feature ships that needs another from-the-air `thread_mentions` shape — say, "promote a todo to a thread" without a prose mention — that's deviation #2, and the rule "mentions are derived from prose" is no longer strict. At that point the principle needs rewriting (probably to "mentions have a source: prose|gesture|promotion") rather than accumulating more exceptions. The discipline is one exception is the budget.

### What wasn't actually a tradeoff

Tracking touch state in a separate table (`thread_touches`) wasn't a real alternative. The staleness math (`computeStaleness`, the 14-day activity strip) consumes `thread_mentions` uniformly — it doesn't care about the row's source, only that it exists for the date. Splitting into two tables means every consumer becomes a UNION, every query a join, and the uniform consumer interface that made this deviation tolerable disappears. The deviation works precisely because the shape is preserved.

---

## Tech reference (industry pairing)

### expo-sqlite (WAL)

- **Codebase uses:** `expo-sqlite` against `loopd.db` — the `thread_mentions` table allows NULL on both `entry_id` and `todo_id` columns, and `toggleThreadTouchToday()` writes that NULL-keyed row directly.
- **Why it's here:** the deviation lives at the schema level — `thread_mentions` is the uniform feed and SQLite is what enforces its shape. If the schema forbade NULL on `entry_id` or `todo_id`, the deviation couldn't exist at all.
- **Leading today:** `expo-sqlite` — `adoption-leading`, 2026.
- **Why it leads:** ships with the Expo SDK; nullable columns are a 30-year-old SQL feature, not a library trick; the deviation is allowed by SQL semantics, not by any framework escape hatch.
- **Runner-up:** `op-sqlite` — `innovation-leading` JSI-direct binding with no bridge cost; the perf tier for bare React Native projects with the same nullable-column semantics.

### Hand-rolled CRUD service (no ORM)

- **Codebase uses:** `src/services/threads/touch.ts → toggleThreadTouchToday()` (54 LOC, the entire file). Raw SQL via the `database.ts` connection; no ORM layer, no validator, no model class.
- **Why it's here:** the deviation needs to write a row that violates the project's prose-derivation invariant — an ORM with strict typing or a schema-validator middleware would block it. The hand-rolled CRUD lets the carve-out exist *inside one named file* the reviewer can see and audit.
- **Leading today:** hand-written CRUD service modules — `adoption-leading` for narrow exception paths in small codebases, 2026.
- **Why it leads:** the deviation's discipline depends on visibility; one named TypeScript function is the most reviewable form of exception. An ORM would diffuse the exception across model + migration + validator files.
- **Runner-up:** `drizzle-orm` — `innovation-leading` typed SQL; the right choice when the codebase grows past ~10 carve-outs and the type-safety benefit outweighs the loss of single-file exception visibility.

---

## Summary

A documented exception is an explicit, narrow carve-out from an architectural invariant, recorded alongside the invariant itself rather than absorbed into a weaker rule. In this codebase the daily-schedule grid in `src/components/home/DailyScheduleGrid.tsx` taps into `toggleThreadTouchToday()` in `src/services/threads/touch.ts`, which writes a `thread_mentions` row with `(entry_id=NULL, todo_id=NULL, source_line=0, tag_text='')` — the only place in the app that produces that shape. The constraint was that the dashboard needs a "I touched this thread today" signal with no prose attribution, and the cleanest way to compose with the existing staleness math (`computeStaleness`, `getThreadCards`) was to keep `thread_mentions` as the uniform feed and carve out one exception. The cost is that every reader of `thread_mentions` must know the exception exists — Principle 11's "mentions are derived from prose" is no longer literally true, and a careless `WHERE entry_id IS NOT NULL` query would silently exclude these rows. The alternative (inserting a synthetic `[]` line into the user's prose) was rejected because the journal is the user's writing and the app does not write into it.

Key points to remember:
- One row shape, one writer: `touch.ts:toggleThreadTouchToday` is the only code path that produces `(entry_id=NULL, todo_id=NULL)` in `thread_mentions`.
- The 14-day activity strip in `getThreadCards.ts` queries `WHERE entry_id IS NULL AND todo_id IS NULL` to read these rows specifically; the staleness math consumes them uniformly because it doesn't care about shape.
- Lives in step 1 (Data model) of the system-design checklist.
- One documented exception is the explicit budget — a second deviation would mean Principle 11 is wrong and needs rewriting, not patching.
- Manual-touch rows persist when an entry is deleted because they have no `entry_id` to cascade from; that's intentional but a future bulk-cleanup feature would need a `WHERE entry_date = ?` path.

---

## Interview defense

### What an interviewer is really asking
The interviewer is checking whether you can name your own architectural exceptions out loud. "Mentions are derived from prose" is a clean rule with one documented violation. They want to hear you describe why this specific deviation was the right call — and why one is the budget you allowed yourself.

### Likely questions

[mid] Q: What does the row inserted by `toggleThreadTouchToday` actually look like?

A: A `thread_mentions` row with `thread_id` set, `entry_id = NULL`, `todo_id = NULL`, `source_line = 0`, `tag_text = ''`, and `entry_date = today`. Standard `created_at`, `updated_at`, `deleted_at`. The shape is a normal mention row except for the two NULLs that no other code path can produce. The 14-day activity strip detects this shape with `WHERE entry_id IS NULL AND todo_id IS NULL`; the staleness math doesn't care about the shape and consumes it as just another mention.

```
[manual-touch row shape]

  thread_mentions row written by toggleThreadTouchToday():

  ┌────────────────────────┬─────────────────────────────────┐
  │ field                  │ value                           │
  ├────────────────────────┼─────────────────────────────────┤
  │ thread_id              │ <the tapped thread>             │
  │ entry_id               │ NULL  ← deviation marker        │
  │ todo_id                │ NULL  ← deviation marker        │
  │ source_line            │ 0                               │
  │ tag_text               │ ""                              │
  │ entry_date             │ today                           │
  │ created_at, updated_at │ now                             │
  │ deleted_at             │ NULL (or stamped on un-touch)   │
  └────────────────────────┴─────────────────────────────────┘
```

[senior] Q: Why didn't you make the touch gesture insert a synthetic `[]` line in the user's prose? That would keep "mentions are derived from prose" intact.

A: I considered it for about an afternoon and rejected it. Inserting a synthetic prose line means the user opens their journal and sees a `[]` line they didn't type — that's a UX violation that's worse than an architectural violation. The journal is the user's writing; the app doesn't write into it. The deviation is the cleaner choice: the schema permits the entry-less mention shape, the staleness math is uniform, and the rule "the journal is the user's" stays absolute. The cost is that any new consumer of `thread_mentions` has to know the deviation exists, which I documented in the spec under Principle 11.

```
                  Path taken (entry-less mention row)   Suggested (synthetic prose line)
                  ──────────────────────────────        ──────────────────────────────────
"prose is canon"  literally false here, documented      literally true; but prose contains
 invariant                                                lines the user didn't type
user UX           clean — journal is untouched          user reads "[]" or "touched #tag"
                                                          they never wrote → confusing
journal export    clean — exports = user's writing      exports include synthetic lines
new consumer cost must read spec §11 to learn about     none at consumer; all rows shaped
                  NULL entry_id rows                    the same
scanThreads cost  unchanged                             +30 LOC to recognize synthetic
                                                          lines without duplicating mentions
where the lie     in the schema (entry_id NULLable)    in the user's own prose
 lives
which lie scales? schema readers can be educated       prose violations compound at every
                                                          export, every share, every backup
right call?       yes — schema lie is honest, prose    no — prose contamination is permanent
                  lie would have been UX-fatal
```

[arch] Q: What happens to manual-touch rows when an entry is deleted, and is that consistent with your other cascades?

A: Manual-touch rows are unaffected by entry deletion because they have no `entry_id` to cascade from. Standard mentions with `entry_id = e123` get soft-deleted when the entry is deleted (because `reconcileMentions` re-runs against an absent entry and finds no matching mentions). Manual-touch rows persist until the user explicitly untouches them via the same dashboard tap. That's the right behavior — the user's "I touched this thread today" intent isn't tied to a journal entry, so it shouldn't disappear when one does. The risk is that a future "delete all entries from a date" sweep would expect to clean up manual-touch rows for that date and miss them; I'd add a `WHERE entry_date = ?` cleanup path if that feature ever ships.

```
At "delete all entries from date X" bulk sweep (future feature):

  ┌─ UI layer ──────────────────────────────────┐
  │ user selects "delete all on 2026-05-07"      │
  └─────────────────────────────────────────────┘
              │
  ┌─ Service layer (entries delete) ────────────┐
  │ for each entry e on date X: delete(e.id)    │
  │ reconcileMentions runs per entry → cascades │
  │ standard mentions soft-delete fine          │
  └─────────────────────────────────────────────┘
              │
  ┌─ thread_mentions cleanup ───────────────────┐
  │ manual-touch rows on date X SURVIVE         │  ◀── BREAKS FIRST
  │ (no entry_id to cascade from; reconciler   │     (need new path:
  │ never sees them)                            │      WHERE entry_id IS NULL
  │                                             │           AND entry_date = X)
  └─────────────────────────────────────────────┘
              │
  ┌─ User-observed result ──────────────────────┐
  │ "I deleted everything from May 7 but the    │
  │ thread strip still shows green dots there"  │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: You allow one documented exception. What stops the codebase from accumulating five more "small" exceptions over time?

A: Discipline, mostly — and a docs surface that calls out the exception by name. The spec lists 12 principles and explicitly enumerates the deviations. When I considered shipping a second deviation (a "promote a todo to a thread" gesture that would also need a from-the-air mention), I rejected it precisely because adding a second exception erodes the strictness of the rule. The discipline I hold myself to is: if a feature needs a second deviation, the principle is wrong and needs rewriting, not patching with another exception. So far the only deviation is manual-touch, and the principle hasn't required a rewrite. The honest answer is the budget could erode if I stopped paying attention; the docs are the tripwire that makes erosion visible. The day a code review proposes deviation #2, I either fix it or I refactor the principle.

```
                  Path taken (1 exception budget)       Drift case (accept exceptions ad hoc)
                  ──────────────────────────────        ──────────────────────────────────
exception count   1, named, documented in spec §11      grows unbounded as features ship
discipline        "second one → rewrite principle"      "small exception, just this one"
                                                          repeated N times
principle 11      "mentions derived from prose, with    "mentions usually derived from
 wording          one named exception" — strong          prose" — vague, no force
docs surface      catalog of deviations, visible at     no central list; deviations live
                  one place                             in their own files, easy to miss
detectability     PR adds a deviation #2 → spec also    PR adds a deviation #2 → no signal,
                  needs editing → reviewer notices      ships without anyone noticing
when violated     refactor principle, not schema        accumulate workarounds in scattered
                                                          files
typical 6-month   exceptions: 1, principle intact       exceptions: 5+, principle a fiction
 trajectory
honest cost       discipline (which fades)              correctness (which erodes silently)
```

### One-line anchors
- "One documented exception beats two undocumented ones, and beats a poorly-fit invariant."
- "The journal is the user's writing — the app does not write `[]` lines into prose to satisfy an architectural rule."
- "The staleness math composes uniformly because the deviation respects the *shape* of a mention row, only the source differs."
- "If a second deviation became necessary, the principle would be wrong — not the schema."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the manual-touch deviation to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/threads/touch.ts:toggleThreadTouchToday`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A new feature ships: "delete all mentions for an entry when the entry is soft-deleted." Today, `reconcileMentions` re-runs against an absent entry and produces no matches → mentions auto-soft-delete. Now: what happens to the manual-touch rows for that day? Should they be deleted or preserved, and where in the codebase would the answer be enforced? Why does the current schema permit either interpretation, and which one would you ship?

Write your answer. 3–5 sentences minimum. Then open `src/services/threads/touch.ts` and `src/services/threads/getThreadCards.ts` to check current consumer assumptions.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/threads/touch.ts` (the deviation) to support what exists
→ Point to where a synthetic-prose-line alternative would land (`src/services/threads/scanThreads.ts` rewriting the `entries.text` body) if you chose the alternative

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
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet + corrected "11-principle list" → "12-principle list".

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
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (house front-door + service entrance on the floor plan scenario → named carve-out pattern as the answer → bolded "what depends on getting this right" with Principle-11 contract stakes around `toggleThreadTouchToday` → before/after walking a "quick add nutrition" PR → one-line "drawn on the floor plan in the same colour as the front door").

---
Updated: 2026-05-14 — v1.31.0 pass (system-design re-scan): rewrote Move 1 of Why care + How it works to anchor on real software (replaced house-with-front-door-and-service-entrance analogies with GitHub CODEOWNERS + dependabot auto-merge as a named documented exception to the all-PRs-require-review rule). Both Move 1s were missed by the original triage agent.

---
Updated: 2026-05-14 — v1.32.0 pass: swapped Why care + How it works Move 1 anchors from whole-product references (GitHub CODEOWNERS + dependabot auto-merge) to level-1 TypeScript primitives (`as any` cast with `// eslint-disable-next-line` comment in one named file; `// @ts-expect-error` line as the named escape hatch under `strict: true`). Same swap on Why care Move 5 summary. Added Move 1 mnemonic diagram (rule + one-named-exception shape) + 4 Move 2 sub-section diagrams: invariant in code+row form, tap-to-insert mechanics, prose-vs-touch row table + export filter, budget decision flow on PR proposing a second deviation. Total: 5 new diagrams.
