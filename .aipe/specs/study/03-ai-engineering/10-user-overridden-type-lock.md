# user_overridden_type — the manual lock

**Industry name(s):** — (project-specific override flag pattern: user_overridden_type)
**Type:** Project-specific

> A single boolean column on `todo_meta`. When the user manually picks a type from the picker, the column flips to `true`. From then on, every AI-driven path MUST read this flag and refuse to overwrite.

**See also:** → [09-async-classification](./09-async-classification.md) · → [11-failure-modes](./11-failure-modes.md)

---

## Why care

You corrected the AI's guess yesterday — flipped a category from "task" to "note" because the model got it wrong. Today you open the app and it's back to "task." The next batch run silently undid your correction, the model is wrong in the same way again, and you have to fix it a second time. Multiply by a month and the user concludes the AI doesn't listen. The right behaviour is for a human edit to outrank any future automated edit, forever, until the user explicitly clears it.

This is the "sticky override" pattern — a flag that marks a field as "manually set, hands off." It belongs to the family of "human-in-the-loop" and "authoritative source" patterns, alongside the way email clients respect a manual "not spam" forever, the way version control respects a manual merge resolution over automatic re-merges, and the way recommender systems mark a "don't recommend this" flag as permanent. You've already seen it any time a product gave you the option to "always trust this sender" or "lock this value." Every AI feature that writes back to a field a user can also write to needs some version of this rule. The next block walks the mechanics.

---

## How it works

The flag lives on `todo_meta` as a single boolean. It defaults to `false` on insert.

When the user picks a type from the manual picker (in `/todos` or the todo detail screen), the update sets both `type` AND `user_overridden_type=true` in the same write.

Every AI-driven update path consults the flag:
- `scheduleClassify`'s success handler reads the current meta before writing — if `user_overridden_type=true`, it skips.
- The catch-up classifier (the migration that fills `null` types on existing rows) reads the flag and skips locked rows.
- Any future "retroactive re-classify" feature must do the same. The diagram below contrasts the two shapes end-to-end.

---

## user_overridden_type — diagram

```
  Without lock:                            With lock:
  ─────────────                            ──────────

  classify  → type='idea'                  classify         → type='idea'
  user opens picker, picks 'todo'          user picks 'todo' → user_overridden_type=true
        │                                        │
  next reconcile fires...                  next reconcile / catch-up fires...
  fresh classify → type='idea' AGAIN ✗     classify still returns 'idea'
                                           BUT: write path checks user_overridden_type
                                                → SKIPS the update ✓
```

---

## Where to apply this pattern

Any AI-assigned attribute that the user can override. The same shape would work for AI-suggested clip order, AI-detected mood, AI-picked filter — none of which are currently overridable, but the column is the canonical pattern when they become so.

---

## In this codebase

**Type:**            `src/types/todoMeta.ts` (109 lines) — declares `user_overridden_type: boolean`
**Write path:**      `src/services/database.ts` → `updateTodoMeta()` accepts the flag (sets it atomically with `type` in the same write)
**UI surface:**      `src/components/todos/TypeChangePicker.tsx` (151 lines) — when the user picks a type, flips the flag to `true` in the same `updateTodoMeta` call
**Catch-up paths:**  `src/services/todos/migrateMeta.ts` — consults the lock at L71 and L111 (both backfill code paths skip locked rows). The async classify path in `src/services/todos/reconcileMeta.ts:scheduleClassify` L13–L46 also reads current meta before writing.

---

## Elaborate

### Where this pattern comes from
"User intent supersedes machine intent" is one of the oldest UX rules. Source control merge tools have it (manually-resolved conflicts stay resolved); spam filters have it (user-marked-not-spam stays not-spam); recommender systems have it (do-not-recommend lists).

### The deeper principle
**Make user override permanent until the user reverses it.** A user override that AI later silently reverts is worse than no override at all — it makes the user lose trust in the system.

### Where this breaks down
- Cases where the user actually wants to "let AI try again" — there's no UI affordance for that today. The only escape is to manually pick the type they want, which still flips the flag.
- Bulk operations that should reset all locks (e.g., "I've changed my classification taxonomy, re-classify everything"). Today this would require a SQL update.

### What to explore next
- [09-async-classification](./09-async-classification.md) → the classifier path that reads the flag.
- [11-failure-modes](./11-failure-modes.md) → other ways the AI surface protects user data.

---

## Tradeoffs

We traded a "let AI keep trying" flexibility for a permanent lock on every user-corrected field — one boolean per overridable attribute, defaulting off so the AI runs freely on new rows but never overrides a human edit.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (sticky boolean)    │ Alternative (provenance enum   │
│                  │                                │ or "let AI try again")         │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Trust            │ user override permanent —      │ user override can be silently  │
│                  │ next batch run never undoes    │ undone by next classifier run; │
│                  │ a human correction             │ user loses faith in the system │
│ Money            │ wasted LLM call when row is    │ no waste — but provenance      │
│ ($/call)         │ locked (~$0.0001 Haiku); ~50%  │ requires per-write semantics   │
│                  │ of catch-up calls skip writes  │ (vs simple skip-if-locked)     │
│ Cognitive load   │ "every AI write checks one    │ "every AI write checks         │
│                  │ boolean column" — uniform     │ provenance vs current state    │
│                  │ rule across all write paths    │ — what's the merge policy?"    │
│ Schema cost      │ +1 BOOL column per overridable │ +1 ENUM column or JSON         │
│                  │ attribute (at 4+ attrs:        │ "overrides" map; same cost at  │
│                  │ migrate to JSON `overrides`)   │ 1 attr, cheaper at 4+          │
│ Query semantics  │ trivial: WHERE                 │ enum is queryable; JSON map    │
│                  │ user_overridden_type=true      │ needs JSON1 extension queries  │
│ "Try again"      │ no affordance today — user    │ provenance enum: user can     │
│ affordance       │ must pick a different type or  │ explicitly request "try AI    │
│                  │ clear flag in dev mode         │ again on this row"             │
│ Failure mode     │ silent — wasted LLM call hits  │ silent in different way —     │
│                  │ skip handler; no user signal   │ AI could silently override if  │
│                  │ that override was respected    │ provenance policy is wrong     │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

We gave up the "let AI try again" affordance entirely. A user who picks `'todo'` manually, then six months later wonders if the classifier got better at their handwriting, has no UI flow to test that. The only escape is to manually pick a different type (which still flips the lock to `true` under the new value) or to clear the flag via SQL in dev mode. That's a real UX gap and I haven't filled it — no `clearOverride(todoId)` action, no long-press option on the type badge, no settings toggle.

We pay for a wasted LLM call on every catch-up run that hits a locked row. `scheduleClassify`'s success handler reads the current meta before writing — but it reads it *after* the LLM call completes, not before. So the cost is "call the LLM, get a guess, throw away the write because the row is locked." At ~$0.0001 per Haiku call and a small population of locked rows, this is trivial — but at higher volume or if the catch-up batch ran on the full archive (it doesn't today), the wasted cost would scale linearly with locked rows.

The schema cost is +1 boolean per overridable attribute. Today that's just `user_overridden_type`. If three more attributes become overridable (clip order, mood, filter preset), the columns multiply: `user_overridden_clip_order`, `user_overridden_mood`, `user_overridden_filter_preset`. The doc names the migration trigger: at 4+ overridable attributes, switch to a JSON `overrides` column. Below four, separate booleans stay explicit and queryable.

### What the alternative would have cost

A provenance-enum column (`'user' | 'classifier-v2' | 'classifier-v3'`) would have let me reason about *who* wrote the row, not just *whether* to write. That sounds flexible — "this row was written by classifier-v2, but classifier-v3 is more accurate, so it's safe to overwrite" — but the merge policy becomes a per-attribute product decision. Every AI write path would need to know "is my classifier version higher than what wrote this row last? if yes, overwrite; if no, skip; if the last writer was user, never overwrite." That's three states and a comparison, instead of one boolean and a skip.

The deeper cost is the trust contract. With a boolean lock, the user knows: "I picked this, it stays." With provenance, the user has to learn: "I picked this, but if the AI gets upgraded, it might re-decide." Even if I implemented the merge policy correctly to never override user-set rows, the *mental model* the user has to hold is more complex. Boolean lock is a contract; provenance is a negotiation.

A "let AI re-classify on demand" button would have added one more state to design: does it re-fire just this row? all rows? what about the lock for the next run? Each answer is a product decision masquerading as a feature. The current "user override permanent until user reverses it" sidesteps all of them by being binary.

### The breakpoint

The pattern flips at 4+ overridable attributes — that's when separate `user_overridden_*` boolean columns stop being readable. Today there's exactly one (`user_overridden_type`). If the codebase adds clip order, mood, and filter preset as overridable, that's 4 booleans on `todo_meta` / `ai_summaries` / `projects`, and the right shape is a JSON `overrides` map: `{ type: true, clipOrder: false, mood: true }`. Same semantics, one column, slightly worse query ergonomics (needs SQLite JSON1 extension). The doc explicitly names this as the migration target.

A secondary trigger: the day a user asks for "let AI try again on this row." Today no user has asked; the day someone does, I'd add a `clearOverride(todoId)` action surfaced as a long-press option on the type badge. The boolean stays — clearing is just `UPDATE todo_meta SET user_overridden_type = 0 WHERE id = ?`. Provenance wouldn't help here either.

A different breakpoint: multi-user shared content. If two users could edit the same todo (collaborative phase B), the lock would need to remember *which* user overrode it. That's where the boolean becomes inadequate — you'd need user_id in the lock state, which is a real provenance column. We don't have that today.

### What wasn't actually a tradeoff

Locking on every write vs locking on user-confirmed writes wasn't a real choice. The picker is the *only* path that flips the lock — there's no "save as draft" intermediate state. The boolean and the type write are atomic in the same `updateTodoMeta` call (see `database.ts` write path). Splitting them would have meant a race where the row could briefly have the new type but no lock, or the lock without the type. Same transaction, same write, no race.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk / Claude Haiku 4.5

- **Codebase uses:** `@anthropic-ai/sdk`; the lock pattern guards every AI-driven write from `scheduleClassify` and catch-up classifier paths.
- **Why it's here:** the LLM output (type guess) is what the lock is designed to override — user intent over model intent.
- **Leading today:** `@anthropic-ai/sdk` — `adoption-leading`, 2026.
- **Why it leads:** native SDK gives first-class access to prompt caching, JSON output, and tool calling that wrappers sometimes flatten or delay.
- **Runner-up:** Vercel AI SDK — `innovation-leading` multi-provider streaming with typed message structures and `useChat` hook.

---

## Summary

The `user_overridden_type` lock is the "sticky override" pattern — a single boolean on `todo_meta` that marks a field as manually set, so every AI-driven write path consults it and refuses to overwrite. In this codebase the column is declared in `src/types/todoMeta.ts`, flipped to `true` by `TypeChangePicker.tsx` in the same `updateTodoMeta` write that sets the new `type`, and read by `scheduleClassify`'s success handler plus the catch-up paths in `migrateMeta.ts` L71 and L111. The constraint that drove it is trust — the LLM is sometimes wrong, the user corrects, and without the lock the next batch run silently undoes the correction. The cost is no "try again" affordance: the user can't let the AI take another swing at the same field without manually picking a new type or clearing the flag in dev mode.

Key points to remember:
- One boolean per overridable attribute, default `false`, atomic with the `type` write.
- Every AI-driven write path must check the flag and skip locked rows — no exceptions.
- The lock suppresses the *write*, not the *call* — the model may still return a guess that gets thrown away.
- User intent supersedes machine intent, permanently, until the user reverses it.
- The day a fourth overridable attribute lands, migrate to a JSON `overrides` column; below four, booleans stay explicit.

---

## Interview defense

### What an interviewer is really asking
The user-override question tests whether I understand that AI annotation is *advisory*, not authoritative. The trap is the candidate who designs an AI feature where the model overwrites the user's correction on the next batch run. The interviewer wants to hear that I built a permanent lock and that every AI write path consults it — and that I picked "permanent" deliberately, not "until next run".

### Likely questions

[mid] Q: Trace what happens when a user opens `TypeChangePicker` and changes a todo from 'idea' to 'todo'.
      A: The picker calls `updateTodoMeta` with both `type='todo'` and `user_overridden_type=true` in the same write — same transaction, atomic. From that point, every AI-driven write path consults the flag: `scheduleClassify`'s success handler reads the current meta before writing and skips if the lock is set; the catch-up classifier (the migration that fills `null` types on existing rows) reads the flag and skips locked rows. The LLM may still return 'idea' on some future call — the lock means the *write* is suppressed, not the *call*. The user's correction stands until they reverse it.

```
[user-picks-type flow]

  TypeChangePicker.tsx — user selects 'todo'
        │
        ▼  updateTodoMeta(id, { type: 'todo', user_overridden_type: true })
  one transaction in database.ts — both fields atomic
        │
        ▼  later: classify runs (next save / catch-up batch)
  classifyTodo → returns 'idea'
        │
        ▼  scheduleClassify success handler reads meta
  meta.user_overridden_type === true
        │
        ├─ yes → SKIP write, drop LLM result silently
        └─ no  → updateTodoMeta(type, confidence, ...)

  outcome: row stays at type='todo', lock=true
```

[senior] Q: Why a boolean lock instead of, say, a per-field "last-edited-by" column?
         A: A "last-edited-by" column would let me reason about provenance ('user' vs 'classifier-v2' vs 'classifier-v3'), which sounds more flexible. I picked the boolean because the only decision the write paths need to make is "skip or write", and the boolean answers that in one column with one default. Adding provenance would be premature — none of today's features need it, and the day they do, I can migrate from boolean to enum without changing the core "skip if locked" logic. Simple now, extensible later.

```
                  Path taken (boolean lock)            Alternative (provenance enum)
                  ────────────────────────             ─────────────────────────────
write-path        "is locked? skip or write"           "is current writer rank > last
decision          (binary)                             writer's? if yes write, else
                                                       skip" — 3-state comparison
states tracked    1: user_overridden_type bool         N: 'user' | 'classifier-v2' |
                                                       'classifier-v3' | ...
schema cost       1 BOOL column                        1 ENUM column + migration on
                                                       every classifier upgrade
trust contract    "I picked this, it stays" — clear    "I picked this, but version 3
                                                       might re-decide if smarter" —
                                                       fuzzy
extensibility     migrate to enum later if needed —    locked into provenance from
                  no code change in "skip if locked"   day one; migrations harder
when to switch    never with current feature set       day "let AI try again" lands
honest framing    YAGNI is the right answer for       solves a problem I don't have
                  one overridable attribute            yet
```

[arch] Q: How would this pattern scale to other AI-assigned attributes — clip order, mood, filter preset?
       A: The shape generalises: one boolean per attribute the user can override. So `user_overridden_clip_order`, `user_overridden_mood`, etc. The cost is N booleans for N overridable attributes. An alternative at scale is a single JSON column `overrides` storing `{ type: true, mood: true }` — fewer migrations, one column, slightly worse query semantics. I'd pick the JSON variant the day a fourth overridable attribute lands; below four, separate booleans are explicit and queryable. The doc already names this generalisation.

```
At 4+ overridable attributes (type + clipOrder + mood + filter):

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged — each picker flips its flag      │
  └─────────────────────────────────────────────┘
              │
  ┌─ Today: separate BOOL columns ──────────────┐
  │ user_overridden_type        BOOL            │  ◀── READABILITY BREAKS FIRST
  │ user_overridden_clip_order  BOOL (NEW)      │     (4 columns become noisy,
  │ user_overridden_mood        BOOL (NEW)      │      every AI write checks N
  │ user_overridden_filter      BOOL (NEW)      │      separate fields)
  │ + 4 migrations, 4 mapper updates            │
  └─────────────────────────────────────────────┘
              │ needs replacement
              ▼
  ┌─ Migration: single JSON `overrides` column ─┐
  │ overrides TEXT NOT NULL DEFAULT '{}'        │
  │ stored as: '{"type":true,"mood":true}'      │
  │ AI writes: JSON_EXTRACT(overrides, "$.type")│
  │ + SQLite JSON1 extension; one migration     │
  │   from boolean → JSON map                    │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: A user who's curious "let me see what AI thinks now" has no way to test that without permanently flipping the lock back. You've made the user a permanent gatekeeper of their own classification. Is that user-friendly?

A: Honestly, no — there's no "try again" affordance and that's a real UX gap. If a user picks 'todo' manually, then six months later wonders if the classifier got better, the only escape today is to manually pick a different type (which still flips the lock to true under the new value) or to clear the flag via SQL in dev mode. Neither is a real user flow. The reason I shipped it this way is that the alternative — a "let AI re-classify" button — adds a state I have to design (does it re-fire just this row? all rows? what about the lock for the next run?) and a UI affordance I don't have a place for. The principle "user override permanent until user reverses it" wins on trust at the cost of flexibility. The day someone asks for "let AI try again", I'd add a `clearOverride(todoId)` action, surfaced as a long-press option on the type badge, and then `scheduleClassify` would treat the cleared flag as a normal classify candidate. Today, no one's asked.

```
                  Path taken (permanent lock)          Suggested ("try again" affordance)
                  ───────────────────────              ──────────────────────────────────
"AI re-try"       no flow — pick different type        new long-press → clearOverride()
flow              (which locks to that) OR             → flag becomes false → next
                  edit SQL in dev mode                 reconcile re-fires classify
trust contract    "I picked this, it stays" — clear    "lock until I unlock" —          
                                                       still permanent but explicit
new code          0 LOC                                clearOverride() in database.ts +
                                                       long-press handler in
                                                       TypeChangePicker.tsx + AI re-fire
                                                       trigger in reconcileMeta
new product       0 — single flow                      what does clearOverride do for
states                                                 already-classified rows? does it
                                                       re-fire immediately or wait?
user-asked-for?   no — no user has requested it       hypothetical — based on dev
                                                       intuition, not data
when this flips   day a user actually asks            ship the affordance, gate behind
                                                       a settings toggle
honest framing    YAGNI for unrequested affordance    real UX gap; ship when needed
```

### One-line anchors
- "User intent supersedes machine intent — permanently, until the user reverses it."
- "One boolean per attribute. Simple now, extensible later."
- "The lock means the *write* is suppressed, not the *call*."
- "No 'try again' affordance today. That's a real UX gap I haven't filled."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the user_overridden_type lock to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/types/todoMeta.ts:user_overridden_type` + `src/components/todos/TypeChangePicker.tsx`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user pinned a todo and manually picked its type as `'idea'` last week. The classifier was upgraded yesterday and the new model is 95% confident the same todo is actually `'todo'`. The reconcile path fires today and `scheduleClassify` runs. What field on `todo_meta` does the new classifier output try to write? What does `meta.classifier_confidence` end up at? What does `meta.type` end up at? Why?

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/migrateMeta.ts` L71 and L111 (catch-up paths) to verify the lock check.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/types/todoMeta.ts:user_overridden_type` (the boolean lock) to support what exists
→ Point to where a "let AI try again" affordance would land (a new `clearOverride(todoId)` action in `src/services/database.ts` plus a long-press option in `src/components/todos/TypeChangePicker.tsx`) if you chose the alternative

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
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block.
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @anthropic-ai/sdk.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.
