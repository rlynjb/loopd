# 05 — Language-agnostic patterns

The patterns in this chapter aren't about TypeScript, React Native, SQLite, or any other choice loopd happens to make. They're patterns of **engineering judgment** — the ones you'd recognize in a Go service, a Rust CLI, a Python ML pipeline, or a Ruby web app. The names change, the syntax changes, but the shape stays the same.

These are the most portable concepts in the curriculum. Learn them here, and you'll see them everywhere.

---

## 5.1 Document architectural principles, then cite them in code

**Difficulty:** foundational

**What it is.** A discipline where the **why** of architecture is captured in a numbered list of principles, and the code references the principles by number when implementing decisions that derive from them.

**Where it lives.** `docs/spec.md` §10 has 12 numbered architectural principles. Search the codebase for "Principle N":
- `src/services/threads/touch.ts:7-10` — *"That bends principle 11 ('mentions are derived from prose') because the row isn't produced by the scanner — it's a direct toggle."*
- `src/services/database.ts` — every write to a synced table reflects Principle 12.
- `.aipe/project/rules.md` lines 20–32 enumerate the principles.

The principles aren't abstract — each one traces back to a specific data-loss bug or product decision (per the spec: *"Treat them as non-negotiable — each one traces back to a data-loss bug or a deliberate-cost decision."*).

**Why it exists.** Six months from now, when the developer (or an agent, or a contributor) is about to write code that violates a principle, the citation in nearby code prevents the violation. The principle's *number* is a stable identifier; the principle's *text* is a stable explanation. Together they form a load-bearing reference everyone can point at.

**General rule.** Write down your invariants. Number them. Cite the numbers in code at decision points. The discipline costs almost nothing and pays back every time someone (including you) is about to do something the system can't actually support.

---

## 5.2 Document the deviations explicitly

**Difficulty:** intermediate

**What it is.** When you deliberately break a principle, **say so** in the code, with the reason. Don't pretend the deviation isn't a deviation — name it as the exception that proves the rule.

**Where it lives.** The clearest example is `src/services/threads/touch.ts:7-16`:

```ts
// Implementation note: this writes a manual `thread_mentions` row with
// (entry_id = NULL, todo_id = NULL, entry_date = today). That bends
// principle 11 ("mentions are derived from prose") because the row isn't
// produced by the scanner — it's a direct toggle. Justified because:
//   - DB schema already permits NULL for both entry_id and todo_id (the
//     constraint was app-level, not a CHECK).
//   - The 14-day strip + staleness math both consume thread_mentions
//     uniformly, so touched-today rows compose with prose-derived ones.
//   - Toggling off deletes only the manual row; prose-derived mentions
//     for today (if any) are untouched.
```

Spec §10 also names this as the *single* documented deviation from Principle 11.

**Why it exists.** Without the documented deviation, future-you (reading the code in 6 months) sees a manual mention row, assumes it's a bug, "fixes" it by removing the path. Now the dashboard tracker stops working. The comment is the **fence** that keeps that fix from happening.

**General rule.** When you violate your own principle, document the violation. Include: (a) which principle, (b) why it was the right call here, (c) what would break if someone "fixed" it. The cost of writing this is 60 seconds; the cost of not writing it is a future bug.

---

## 5.3 Make invariants explicit (in code, in CHECKs, in types)

**Difficulty:** intermediate

**What it is.** A discipline of stating the rules your data must obey at multiple layers: as a type constraint where possible, as a runtime CHECK where possible, as a code comment where neither is. The goal: the invariant cannot quietly be broken.

**Where it lives.** The 1:1 relationship between `entries.todos_json` items and `todo_meta` rows (Architectural non-negotiable #1 in `.aipe/project/rules.md`):

- **Type level:** `TodoItem` has an `id: string`; `TodoMeta` has a `todoId: string` PK. The names imply the relationship.
- **Runtime level:** `reconcileTodoMetaForEntry()` in `src/services/todos/reconcileMeta.ts:48-91` enforces it on every commit — INSERT meta for new TodoItems, DELETE meta for vanished ones.
- **Spec level:** explicitly named as a non-negotiable in `.aipe/project/rules.md:34`.

The DB CHECK constraints on `todo_meta` (CHECK enforces enums on `type`, `stage`, `classifier_confidence`) are a different invariant, enforced at the storage layer where it can't be bypassed.

The `user_overridden_type` lock (Architectural Principle 9) is enforced in code (`src/services/todos/reconcileMeta.ts` skips overridden rows) — there's no way to express "lock this attribute" in the type system or the schema, so it lives as a code-level invariant with a CLAUDE.md citation.

**Why it exists.** Invariants that aren't enforced get violated. The closer to the data the enforcement lives, the harder it is to bypass. CHECK constraints are the strongest because they survive bugs in any layer above. Type constraints are the second-strongest because they catch at compile time. Code-level enforcement is the weakest but sometimes the only option.

**General rule.** For every invariant your data must obey, ask: *what's the strongest layer that can enforce this?* Push it down as far as it'll go. If it has to live in code, name it explicitly (a comment, a function name, a documented principle), so future-you knows it's load-bearing.

---

## 5.4 Lazy initialization with a sentinel value

**Difficulty:** foundational

**What it is.** A pattern where a value is set on first access (not at creation), with a `null` (or equivalent) sentinel meaning "not yet set." Subsequent accesses return the same value.

**Where it lives.** Two clear examples:

- `src/services/database.ts:8-16` — module-level `let db: SQLite.SQLiteDatabase | null = null`. The first call to `getDatabase()` opens it; later calls return the cached one.
- `src/services/sync/schedulePush.ts:11` — `let timer: ReturnType<typeof setTimeout> | null = null`. Used as both "no timer pending" sentinel and the handle for `clearTimeout`.

The `position` field on `todo_meta` is a database-level version of this pattern: NULL means "no manual order yet," and the system uses `createdAt`-DESC sort. Once any reorder happens, every row gets a dense integer and the sort flips to `position`-ASC.

**Why it exists.** Lazy init defers cost (DB open is cheap but not zero), avoids initialization-order bugs (don't open the DB before the FS is ready), and makes the "default" state cheap to represent (a single null pointer). The sentinel is the bridge between "this thing might exist" and "I need to use it" — without losing the ability to ask "does it exist yet?"

**General rule.** For any expensive resource you only use sometimes, lazy-init with a sentinel. The pattern is small, race-safe within a single thread, and leaves a clear "is it ready?" check available. Use it for DB connections, HTTP clients, ML models, expensive caches, file handles.

---

## 5.5 Eventual consistency over strong consistency

**Difficulty:** advanced

**What it is.** A design choice where derived state (cloud copy, classifier output, expansion) is allowed to lag behind canonical state (local DB), and the system has a mechanism to **converge** rather than block.

**Where it lives.** Three layers of eventual consistency in loopd:

1. **Cloud sync.** Local writes don't wait for cloud. `schedulePush()` defers the push 5 seconds; the user's edit is durable in SQLite immediately and the cloud catches up later.
2. **Classifier.** `reconcileTodoMetaForEntry` writes the new meta row with heuristic-only output; the LLM classifier runs fire-and-forget and updates the row when it lands.
3. **Boot-time catch-up.** `classifyAmbiguousMeta()` walks unclassified rows and reruns classification. Anything that didn't get classified yesterday (no key, network down) gets picked up on next boot.

In all three: **the canonical state is correct immediately**; the derived state catches up. The system has explicit convergence points (next push, next boot, next user revisit) that drive the lag toward zero.

**Why it exists.** Strong consistency (everything updates atomically) is slow, expensive, and brittle. A 200ms cloud round-trip on every keystroke is infeasible; a classifier blocking every save would feel terrible; an expansion blocking commit would make the journal unusable. Eventual consistency lets the user's interaction be **fast**, while the supporting state catches up in the background. The convergence guarantees keep the lag bounded.

**General rule.** Any time strong consistency would be expensive, ask: "what's the smallest eventual-consistency model that still works?" Often the answer is "lag the derived state by seconds" — and that's enough to make the foreground feel instant. Just be sure you have an explicit convergence path and a way to detect drift.

---

## 5.6 Idempotent backfills with a one-time gate flag

**Difficulty:** intermediate

**What it is.** A migration that walks existing data and updates it to a new shape, gated by a flag so it only ever runs once per install. The migration is also idempotent (safe to re-run if the flag check fails).

**Where it lives.** Architectural Principle 8 in `docs/spec.md` §10. Five backfills, all SecureStore-gated:

- `drops_backfill_v1_done` — scans pre-existing entries for `[]` markers
- `nutrition_backfill_v1_done` — scans for `** food N kcal` lines
- `todo_meta_backfill_v1_done` — creates paired `todo_meta` rows for every existing todo (heuristic-only)
- `habits_cadence_backfill_v1_done` — derives `slug` from `label` for pre-cadence habits
- `thread_mentions_backfill_v1_done` — scans every entry + todo for `#tag` matches

Each runs in `app/_layout.tsx` on boot; each checks SecureStore first; each marks the flag on success.

The threads backfill has an extra wrinkle: it short-circuits when zero threads exist locally, because there's nothing to match against. It re-checks on every subsequent boot until the user creates the first thread, then runs and marks done.

**Why it exists.** When you ship a new prose-derived feature, existing entries don't have the new derived rows. A backfill catches them up. The flag prevents the backfill from running every boot (slow, wasteful). The idempotency requirement (the backfill must produce the same end state regardless of starting state) is what lets you safely retry if the flag check itself fails.

**General rule.** When you add a new feature that derives state from existing data, write a backfill. Gate it with a flag in persistent storage. Make it idempotent (so it survives interrupted runs). Run it on boot, before any user-visible UI uses the new feature.

---

## 5.7 The `null` vs. `undefined` distinction (semantic optionality)

**Difficulty:** intermediate

**What it is.** A discipline of reserving `null` for "the value is explicitly absent" and `undefined` for "the value isn't in scope." In TypeScript-flavored code, the distinction is load-bearing. In other languages, the equivalent is "optional with a tombstone vs. simply not present."

**Where it lives.**
- **`scanTodos.ts:107` vs `scanTodos.ts:118-122`** — a fresh-from-prose todo gets `completedAt: match.isDone ? now : null`. A carryover todo gets `sourceLine: undefined`. The `null` says "explicitly not completed"; the `undefined` says "no source line because it's no longer in prose."
- **DB column nullability** — `entries.text TEXT` is nullable; `entries.created_at TEXT NOT NULL` isn't. The schema enforces semantic optionality.
- **`thread_mentions` invariant** — at least one of `entry_id` / `todo_id` is set, EXCEPT for manual touches where both are NULL. The NULL is meaningful (it's the deviation marker).

**Why it exists.** Conflating "absent" and "explicitly null" loses information. If `completedAt: undefined` could mean both "never been completed" and "we lost the value," you can't tell when there's a bug. Reserving `null` for *explicit absence* lets you spot the difference: `undefined` is suspicious; `null` is normal.

**General rule.** In any language with an optional/nullable distinction, use it semantically: explicit absence vs. unmodeled. In languages without one (Python, Ruby), use a sentinel value or a separate boolean. The point isn't the syntax — it's having two distinct states for "no value" so you can tell when something's wrong.

---

## 5.8 Compose pure functions with thin effectful glue

**Difficulty:** foundational

**What it is.** A code-shape discipline where the meat of the logic is in pure functions (no I/O, no state), and the parts that *do* I/O are tiny shims that call the pure functions and write the results.

**Where it lives.** Look at the entry commit flow:

1. **Pure:** `scanTodosFromText(text, existing)` returns the new todos array.
2. **Glue:** `useEntries.editEntry` writes the new todos array to SQLite.

3. **Pure:** `heuristicClassify(text)` returns `'todo' | null`.
4. **Glue:** `reconcileTodoMetaForEntry()` calls the heuristic, then INSERTs/UPDATEs the meta row.

5. **Pure:** `chooseWinner(local, cloud)` returns the winning side as a tag.
6. **Glue:** `pullTable()` calls `chooseWinner`, then upserts.

The pattern repeats: **the interesting decision is pure; the side effect is dumb.** That makes the decisions testable and the side effects reviewable.

**Why it exists.** A pure function can be reasoned about in isolation. An effectful function can't — it has to be considered in the context of *when* it runs, *what state* exists when it runs, and *what other effects* are happening concurrently. Keeping decisions pure reduces the surface area you have to reason about.

**General rule.** Default to writing pure functions. Effects should be **small**, **named**, and **at the edges** of your code. If a function is more than 30 lines and contains both decisions and effects, refactor: pull the decision out as a pure helper, leave the effect at the call site.

---

## 5.9 Heuristic-before-LLM as a general "deterministic-before-probabilistic" rule

**Difficulty:** foundational

**What it is.** The pattern in §1.2 generalizes beyond AI: **always try the cheap deterministic mechanism first, fall back to the expensive probabilistic one only when needed.** Whether the "expensive thing" is an LLM, a fuzzy search, an external API, or a Monte Carlo simulation — the structure is the same.

**Where it lives.** Beyond the classifier:

- **Two-pass matching** (§2.3) is heuristic-before-fuzzy: Pass 1 is exact text match (deterministic, cheap). Pass 2 is line-index fallback (positional, less specific). Anything still unmatched is genuinely new or genuinely deleted.
- **JSON parse + retry** (§1.7) is the same shape: parse the response cheaply; on failure retry with a stricter prompt; on second failure surface a typed error.
- **Cache-or-generate** (§4.6) is heuristic-before-LLM at the request layer: cache hit is the deterministic answer; cache miss is the expensive call.

**Why it exists.** Probabilistic systems are powerful but slow, expensive, and uncertain. Deterministic systems are fast, cheap, and predictable but limited. The combination — cheap-deterministic for the easy cases, expensive-probabilistic for the hard ones — gets the best of both. You spend your probabilistic budget where it actually moves the needle.

**General rule.** For any classification, matching, or routing problem, ask: "what's the simplest deterministic test that would handle 60–70% of the input?" Write that test first. Reserve the expensive call for the 30% the deterministic test couldn't handle.

---

## 5.10 The "lock on user override" pattern

**Difficulty:** intermediate

**What it is.** When an automated system makes a decision (classify a todo's type) and the user disagrees, the user's correction **locks** that decision — the automation is forbidden from re-deciding it. The lock is permanent (or at least sticky enough that the automation can't quietly undo the user's intent).

**Where it lives.** Architectural Principle 9 in `docs/spec.md` §10:

> "Classifier output is editable; user override is permanent. Any AI-assigned attribute on a derived row must be overridable by the user, and the override must lock that attribute from future AI mutation. The `user_overridden_type` flag pattern is the template."

In code:
- `todo_meta.user_overridden_type` column. Set to `1` when the user picks a type via the picker.
- `reconcileTodoMetaForEntry()` and `classifyAmbiguousMeta()` skip rows where this flag is set.
- The picker writes both the new type AND the flag.

**Why it exists.** Without the lock, this is a real failure mode: user corrects the classifier from `idea` to `todo`. Five seconds later, the boot-time catch-up runs and re-classifies it back to `idea`, undoing the user's correction silently. The user re-corrects. The system re-overrides. The user gives up and the feature feels broken.

The lock makes the user's authority **structural** — they're not just suggesting; they're committing.

**General rule.** Any system where automation suggests and the user can correct, you need the lock. The lock can be a flag on the row (loopd's choice), a separate "user decisions" table, or an event-sourced "this was overridden" record. The shape doesn't matter; the structural guarantee does.

---

## 5.11 Separate "the thing" from "metadata about the thing"

**Difficulty:** intermediate

**What it is.** A pattern where a domain entity has a primary table that stores its identity and stable attributes, and a separate table for **per-occurrence**, **derived**, or **AI-generated** metadata that joins by foreign key.

**Where it lives.**
- `entries.todos_json` (the user's actual todos as JSON) vs. `todo_meta` (per-todo type, stage, expansion, classifier confidence).
- `entries` (the canonical prose) vs. `nutrition` (derived rows, one per `** food N kcal` line).
- `threads` (the persistent project metadata) vs. `thread_mentions` (per-occurrence join rows).

In each pair, the first table is **stable** (the user owns it); the second is **derived** or **augmenting** (the system maintains it). They join by ID.

This is also Architectural Principle 11: *"Mentions are derived; metadata is stored."*

**Why it exists.** Storing metadata on the same row as the canonical data couples them in unhelpful ways. If `todos_json` had a `type` field, the scanner would have to be careful to preserve that field across edits — and any new AI-derived attribute would require a JSON-shape migration. With a sidecar `todo_meta` table, the scanner just writes todos; the metadata layer is reconciled separately, can grow new columns, and can be deleted-and-rebuilt without touching the canonical data.

**General rule.** Separate canonical data from augmenting data. Use foreign keys to join. The augmenting table can grow, be rebuilt, or be regenerated without touching the canonical side. This is the schema-level equivalent of "derived state vs. canonical state."

---

## 5.12 Self-healing systems (fix on next encounter)

**Difficulty:** advanced

**What it is.** A pattern where the system doesn't aggressively repair drift the moment it's detected — instead, it includes the repair logic in a routine that runs anyway, so drift is fixed the next time the affected data is touched.

**Where it lives.**
- **`reconcileTodoMetaForEntry`** at `src/services/todos/reconcileMeta.ts:48-91`: if a previous run failed and left orphan/missing rows, the next commit's diff catches the gap and patches it. The function comment names this: *"Self-healing: a failed reconcile leaves orphaned/missing meta rows; the next commit sees the gap via the same diff and patches it. Best-effort from the journal's perspective — never throws."*
- **`classifyAmbiguousMeta`** boot-time catch-up — any row with NULL `classifier_confidence` and not-done gets re-tried.
- **`repairBareClipUris`** at `src/services/database.ts:21-51` — runs on every DB open, fixes a known historical corruption pattern.
- **The lazy threads backfill** that re-checks every boot until the user has at least one thread.

**Why it exists.** Drift is inevitable. A network failure mid-classify; a crashed reconcile; a corrupted JSON column from a long-fixed bug. Aggressive repair (background daemons, per-edit checks) is expensive and racy. Lazy repair embedded in routines that already run is cheap and converges naturally — the system tends toward correct as it operates.

**General rule.** Detect drift opportunistically; repair drift opportunistically. Don't write a separate "fix bad data" job if you can fold the fix into a function that already touches the data. The repair runs only when needed, costs nothing when it's not, and converges over time.

---

## 5.13 Pattern recognition across the chapters

These are some of the patterns that show up in **every** part of the codebase, in different guises:

| Pattern | Code in §1 | Code in §2 | Code in §3 | Code in §4 |
|---|---|---|---|---|
| Cheap-before-expensive | heuristic before LLM | exact match before fallback | type check before runtime check | cache hit before generate |
| Idempotent re-run | catch-up loop | reconcile-on-commit | DB migration `IF NOT EXISTS` | regenerate is opt-in |
| Typed result discriminator | `ExpandResult` | `BootstrapDecision` | `CreateResult` | `caption: \| null` |
| Bounded scope | per-call max_tokens | sync batch_size = 50 | rank.includeDoneOlderThanMs | context cap 1000ch |
| User-controlled override | `user_overridden_type` lock | manual touch deviation | StageChangePicker | regenerate button |

When you start to see the same shape repeating, you've internalized the pattern. The shape is what transfers across stacks; the syntax is incidental.
