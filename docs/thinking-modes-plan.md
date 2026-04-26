# Thinking Modes — Implementation Plan (Proposal, awaiting approval)

Reviewed spec: [loopd-thinking-modes-spec.md](../loopd-thinking-modes-spec.md). Implemented against the loopd stack as described in [docs/spec.md](./spec.md). **Plan only — do not execute until approved.**

The spec is unusually thorough — most architecture is already decided, with a clear 20-step build order in §14. This plan covers (a) the few places I'd push back, (b) recommended phasing so we ship value before we've spent 50 hours, (c) my recommendations on the §16 open questions, and (d) gotchas the spec doesn't fully address.

---

## 1. Overall read

The shape is sound. I'd build essentially as specified with a handful of changes:

**Strong points to preserve:**
- Heuristic-first classification with LLM fallback (§5) — exactly the right cost discipline.
- Single marker, single page, single list (§1) — earlier revisions tried `>>` markers and category-grouped accordions; the flat-list-with-category-filter shape lands well.
- `user_overridden_type` lock (§5.5) — fixes the "AI keeps re-categorizing my override" problem cleanly.
- New CLAUDE.md principles in §13 ("Heuristic before LLM", "User override is permanent") — both worth promoting.
- Two-pass scanner stays unchanged; type is preserved across both passes.

**Things I'd push back on:** §3 below.

---

## 2. Recommended phasing (instead of one 33-50h build)

The spec is one big monolith. I'd cut it into four shippable phases so the bulk of the UX value lands before we touch any LLM. Phase 1 is fully usable on its own.

### Phase A — plumbing + heuristic + manual override (≈ 12-15h)

Ship the foundation without touching any LLM. After this, every todo has a type, the user can manually correct it, and the page UI works.

- SQLite migration: `todo_meta` table + CHECK + indexes
- Types: `todoMeta.ts` (TodoMeta only — not the six expansion shapes yet)
- `typeMeta.ts` — icons, labels, colors, ordering
- `heuristicClassify.ts` + unit tests
- `scanTodos.ts` change: insert paired `todo_meta` row in same transaction; type from heuristic, default `'todo'` when null
- `migrateMeta.ts` backfill — heuristic-only, no LLM yet (gated `todo_meta_backfill_v1_done`)
- `/todos` page restructure: flat chronological list + status filter row + horizontal-scroll category filter
- Per-row category badge with confidence "?" mark (no expand button yet — type='todo' is the only category that exists post-Phase-A for ambiguous lines)
- Manual type-change picker (tap badge OR long-press text)
- Dashboard `SmartTodoList` switches to chronological top 5 with category badges (see §3 below — flagged as biggest risk)

After Phase A, every existing and new todo has a category, the user can correct it, the list view is the new flat shape. **No LLM cost incurred.** This is shippable on its own.

### Phase B — classifier LLM (≈ 7-10h)

Adds AI classification of the heuristic's `null` outputs. After this, ambiguous lines get auto-categorized.

- `classify.ts` — cheapest-model selection logic + tests
- Wire classifier into `scanTodos.ts` (already inserting meta rows after Phase A)
- Extend `migrateMeta.ts` with batched re-classification of existing `null`-confidence rows
- Banner UX in `/todos` for "AI not configured" + "classifying N todos…" progress

### Phase C — expansion modal (≈ 10-15h)

The "tap to expand" affordance with the six per-type prompts.

- Six expansion shape types in `todoMeta.ts`
- `expandPrompts.ts` with all six system prompts + reasoning preambles
- `expandSerialize.ts` per-type templates
- `expand.ts` orchestrator — context loader (recent entries, sibling todos, AI summary), LLM call, JSON parse, markdown serialize, write back
- Side-panel expansion modal: layout, loading state, re-expand, change type, dismissal
- Loading/error states, in-flight cap (3), JSON-malformed retry
- Expanded indicator on rows

### Phase D — Notion sync extension (≈ 5-8h)

Pushes the new fields to the user's Notion Todos DB and pulls back changes.

- `notion/todosMapper.ts` extension for new properties (missing-property tolerance per §11.7)
- `syncAllTodos` extension per §11.3 — pull merge, push union, new-from-Notion handling
- Update notion-guide for new Todos DB properties + "don't edit Title in Notion" note

Each phase is self-contained. If you change your mind about expansion mid-build, Phase A + B is a complete useful feature.

---

## 3. Pushbacks on the spec

### 3.1 Don't flatten the dashboard (§9)

The spec's §9 itself flags this: "this is a big behavior change for your daily flow." I'd commit harder to *not* flattening.

The dashboard answers **"what should I attend to right now?"** — that question wants ranking. The page answers **"what's been captured over time?"** — that question wants chronology. Same data, different presentations. Two surfaces, two sort policies is fine; in fact it's correct.

Rec: keep [rank.ts](../src/services/todos/rank.ts) alive for the dashboard's `SmartTodoList`, but extend it to read `todo_meta.type` so it can include category badges in the ranked output. Carryover-from-yesterday + category badge on the dashboard is the best of both worlds. The `/todos` flat-list-with-filters is still the new behavior.

(Spec §16 already names this as the open question — landing on "keep dashboard ranked".)

### 3.2 Drop the duplicated `notionPageId` field

Spec §11.1 has both `TodoItem.notionPageId` and `TodoMeta.notionPageId` referencing the same Notion page, with a footnote that they "always reference the same id." That's a bug-magnet — two fields claiming to be in lockstep is a recipe for drift.

Rec: keep `TodoItem.notionPageId` (existing), drop `TodoMeta.notionPageId`. Sync code joins TodoItem + TodoMeta and uses the single id. The new `notion_page_id` index on `todo_meta` (§4) can go too — joins use the entries table for that.

Tradeoff: if you ever want to query meta-only without joining the entry, you'd add an index. Acceptable.

### 3.3 No badge on plain `'todo'` rows

Spec §8.3 keeps the `☐ todo` badge on every plain-todo row "for visual consistency." §16 questions whether plain todos should be badge-less since they'll be 60%+ of the list.

Rec: no badge on plain `'todo'` rows. The absence of a badge IS the signal — "this is a normal todo." Adding visual weight to the most common case adds noise without adding info. The category filter chip row at the top still shows the count next to ☐ todo, so users know how many plain todos exist.

### 3.4 Heuristic should over-fire on `'todo'`, not on `null`

Spec §5.2 says the heuristic "intentionally over-fires on `null`" — false positives go to the classifier (one cheap LLM call). Defended on accuracy grounds.

I'd flip it: false positives (idea mis-classified as todo) cost the user **one tap to correct**. False negatives (an obvious todo gets sent to the LLM) cost real money over thousands of captures. A solo personal-use app where the user logs maybe 30-50 todos a week might log ~1500-2500 ambiguous lines a year going to the classifier. At ~$0.0003 per Haiku call that's ~$0.50/year. Negligible.

So: spec is fine, but it's a deliberate accuracy-over-cost call worth knowing. **No change to my plan** — just naming the choice.

### 3.5 Lock-on-override might be too strict (§5.4)

Spec says once `user_overridden_type = 1`, never re-classify. Forever. Even if the text is later edited to something completely different.

Edge case: user writes `[] noticed the bug in auth` → AI classifies as `bug`. User overrides to `idea` because they want to brainstorm. Six months later they edit the same line to `[] fix the auth login redirect`. It still says `idea` because the override locked it.

Rec: keep the override lock for **consecutive edits**, but consider a "significant text change" trigger (e.g. >70% of the words changed) that re-prompts the user with a banner: "This todo's text changed significantly — re-classify as bug?". User taps yes/no. Doesn't auto-mutate.

That said, this is a v1.1 polish. Phase A behavior matches spec.

---

## 4. §16 open questions — recommendations

| # | Question | Recommendation |
|---|---|---|
| 1 | Heuristic verb list | Build during Phase A from a real export of the user's `[]` lines (we can dump them with one SQLite query). Don't pick verbs blind. |
| 2 | Classifier model fallback | (b) Skip classification with banner. Don't burn primary-model tokens on classification when it's already a fallback path. |
| 3 | Backfill batch size | 5 per call. Safer JSON parsing, less to retry on a failure. |
| 4 | Notion `text` edit behavior | Silent overwrite on next push (spec §11.2). Add a one-time toast on first detected conflict: "Notion edits to a todo's title are ignored — edit in the journal instead." |
| 5 | Notion-originated todo target entry | Today's entry. Simpler, matches existing todos sync behavior. |
| 6 | Dashboard flatten | **Don't.** See §3.1 above. |
| 7 | Done items sort | Strikethrough in chronological place (spec's chosen behavior). Don't sink. |
| 8 | Badge on plain `'todo'` rows | **No badge.** See §3.3 above. |

---

## 5. Gotchas not in the spec

### 5.1 Lifecycle invariant must be transactional

Spec §4 says every `TodoItem` has exactly one `todo_meta` row, enforced by the scanner inserting both in the same transaction. Critical to actually wrap in `db.withTransactionAsync()` — not just sequence two `runAsync` calls. If the meta insert fails (CHECK violation, disk full mid-write, anything), the todo insert must roll back too. Otherwise we get orphans the spec promises won't exist.

Same for delete: scanner must delete both atomically.

### 5.2 Scanner runs on entry commit; classifier is async

Spec §5.4 says classifier runs on first scan. But scanners are called synchronously from `useEntries.editEntry` — if the classifier LLM call blocks, the journal save blocks. Options:

- **Async fire-and-forget**: scanner inserts meta row with `type='todo'` placeholder, then queues a classifier call that updates the row when it returns. Same pattern as the nutrition scanner.
- **Synchronous wait**: journal save blocks ~1-2s on the LLM call. Bad UX.

Rec: async fire-and-forget. Existing `scheduleNutritionScan` pattern in `useEntries.ts` is the template. Add `scheduleClassify(todoId, text)`. Heuristic still runs sync (it's free and fast).

### 5.3 Backfill batch prompt design

Spec §6 says batched classifier calls (5-10 per batch) but doesn't define the batch prompt. The classifier's single-pass prompt (§5.3) takes one text, returns one JSON. For batches you'd want:

```
Input: array of {id, text}
Output: array of {id, type, confidence}
```

This needs careful prompt engineering — LLMs are notoriously inconsistent at array-in/array-out shapes vs. one-at-a-time. Worth prototyping with 5-row batches first; if accuracy drops vs. single-pass, fall back to sequential calls (still cheap, just slower).

### 5.4 Confidence is not visible enough

Spec §8.3 puts a "?" mark inside the badge for medium/low confidence. With 60%+ plain todos showing no badge (per my §3.3), the "?" mark only appears on non-todo rows — which already stand out. That's fine.

But: the spec doesn't say what happens visually when the user taps "?". Just opens the type picker. Suggestion: when picker opens from "?" tap, pre-highlight the AI's pick AND show the next-most-likely alternative. Might require returning top-2 from the classifier. v1.1 polish, not blocker.

### 5.5 Re-classify path is missing from the spec

Spec §5.4 lists when classification runs, all the places it doesn't. There's no "re-classify everything" entry point — useful if the user improves the heuristic verb list, or wants to redo classification after configuring AI. Add a button in `/settings/ai`: "Re-classify all todos" — clears `classifier_confidence` on non-overridden rows and re-runs the backfill batch path. Out of Phase A scope; consider for Phase B.

### 5.6 Expand modal context size

Spec §7.5's `ExpansionContext` includes `recentEntries` (last 3 days, full text + AI summary) + `siblingTodos` (max 5). For a heavy journaling day the recent-entries text alone could be 5-10k tokens. With the system prompt + reasoning preamble, an expansion call could approach 15k input tokens. Fine on Sonnet 4.6 ($0.003/1k in = ~$0.045 per expansion). Worth flagging because at 50 expansions/month that's ~$2.25/month from this feature alone. Not a blocker, just visible cost.

Rec: cap recentEntries text at 1000 chars per entry, with truncation tag. Keeps cost predictable.

### 5.7 Notion mapper backwards compatibility test

§11.1 / §11.7 promise the new sync code works against existing Todos DBs that lack the new properties. Critical to actually test this — easy regression to ship a sync that crashes on a missing property. Add a unit test fixture for "Todos DB schema with no Type/Expanded/Model/Confidence columns" and verify push + pull both succeed.

---

## 6. Phase A concrete scope

Files to create:

- `src/types/todoMeta.ts` (~30 LOC — TodoMeta only, not expansion shapes yet)
- `src/services/todos/typeMeta.ts` (~80 LOC — icon/label/color/ordering map)
- `src/services/todos/heuristicClassify.ts` (~150 LOC including verb list, plus tests)
- `src/services/todos/migrateMeta.ts` (~80 LOC — heuristic-only backfill, no LLM)

Files to edit:

- `src/services/database.ts` — `todo_meta` migration + CRUD (~120 LOC added)
- `src/services/todos/scanTodos.ts` — insert paired meta row in transaction; run heuristic (~80 LOC added)
- `src/services/todos/crud.ts` — cascade Notion id, cascade delete (~30 LOC added)
- `app/_layout.tsx` — wire backfill (~20 LOC added)
- `app/todos.tsx` — full restructure: flat list, status + category filter rows, badges, type-change picker (~250 LOC, mostly rewrite)
- `app/index.tsx` / `src/components/home/SmartTodoList.tsx` — add category badges; **keep ranked sort** per §3.1 (~30 LOC)

Roughly ~870 LOC across 4 new files + 6 edits. Two focused sessions.

---

## 7. Decisions I need from you before Phase A starts

1. **Dashboard ranking** — confirm "keep dashboard ranked, only flatten /todos" (my §3.1) vs. spec's "flatten both."
2. **Plain `'todo'` badge** — confirm "no badge on plain todos" (my §3.3) vs. spec's "badge on every row."
3. **`notionPageId` duplication** — confirm "single field on TodoItem only, drop from TodoMeta" (my §3.2) vs. spec's "duplicate, keep in lockstep."
4. **Phasing** — Phase A (heuristic + UI restructure, no LLM yet) is shippable on its own. Confirm we ship phased, or insist on the full feature in one drop.
5. **Heuristic verb list source** — OK to dump all your existing `[]` lines first via SQLite query and build the verb list from real data, vs. starting from the spec's illustrative list?

Once decided, Phase A starts.

---

*End of plan. Awaiting your decisions.*
