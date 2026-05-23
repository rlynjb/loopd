# Chapter 04 — DSA

DSA refactors are the narrowest category. They only matter for code that actually runs often or on data that's grown. Cold code with the "wrong" data structure is not a bug; it's a non-issue. Speculative perf refactors add code without removing real cost.

## Map of the territory

- **Collapse Traversals** — BRIEF. Three scanners (`scanTodos`, `scanNutrition`, `scanThreads`) each walk `entries.text` separately at commit time. If all three drops are present in an entry, the text gets parsed three times.
- **Memoize at a Stable Boundary** — BRIEF. `DailyScheduleGrid` recomputes per-habit-per-day cell state on every render; the underlying inputs only change when habits or entries do.
- **Change Data Structure** — NOT FOUND. No array-as-set or array-as-map of consequence at this scale.
- **Replace Quadratic with Linear** — NOT FOUND. `clipMigration` is O(N) over clip count (~183 today, bounded). `repairBareClipUris` is O(N) over entries with clips. Both are at-cold-start, not at-frame.
- **Replace Recursion with Iteration** — NOT FOUND. No recursion of consequence.
- **Lazy Evaluation** — NOT FOUND. AI summary auto-generates only when missing (cache hit short-circuits); sync pulls only what's new since `last_pull_at`. Lazy where it matters.
- **Batch / Debounce / Throttle** — NOT FOUND as refactor opportunities; the codebase already uses them where it should (`schedulePush()` debounced 5s, push batches of 50, pull pages of 200, ffmpeg concurrency capped at 2).

This chapter is short on purpose. The architectural principle that scanners run only at commit (not per-keystroke), that sync paginates by 200, that push batches by 50, that ffmpeg caps concurrency at 2, kept the DSA surface tiny. There's no DEEP section in this chapter and that's the honest answer — this codebase doesn't have a DSA problem at single-user scale.

---

### Collapse Traversals — commit-time scanners over `entries.text`

**Where it shows up** (neutral)

When an entry's text is committed (focus blur or screen leave from `app/journal/[date].tsx`), three scanners independently parse the prose:

- `src/services/todos/scanTodos.ts` → `scanTodosFromText()` parses `[]` checkbox-drop lines and produces a `TodoItem[]`.
- `src/services/nutrition/scanNutrition.ts` → `scanNutritionFromText()` parses `** food N kcal` lines and produces `NutritionEntry[]`.
- `src/services/threads/scanThreads.ts` → `parseTags()` parses `#tag` mentions and produces `ThreadMention[]`.

Each scanner does its own line-by-line walk over the same text. Per the project's "two-pass matching" principle, each also does an exact-match then line-index-fallback pass against the existing derived rows for reconciliation.

**Take + verdict**

The right shape if you cared would be one walk: `parseEntryDrops(text)` returns `{ todos, nutrition, threads }` in a single pass that recognises all three drop syntaxes line-by-line. The cost saved is parsing `entries.text` twice per commit (not three times — the existing code parses once per drop type). At single-user scale with entry texts that top out at a few KB and commits that fire on focus blur (not per-keystroke), the saved work is microseconds — well below the threshold where it matters. *Not worth doing today.* If buffr ever gains an "import a year of journals from another app" backfill that parses every entry through all three scanners, the saved cost becomes minutes vs hours and the refactor pays for itself in that PR — that's the breakpoint. Until then, the locality cost (each scanner owns its drop type cleanly; merging them couples three domains in one parser) outweighs the perf cost.

---

### Memoize at a Stable Boundary — `DailyScheduleGrid` cell state

**Where it shows up** (neutral)

`src/components/home/DailyScheduleGrid.tsx` renders a weekly grid of habits × days. For each cell, `src/components/home/cellState.ts:computeCellState()` derives a typed state (`due`, `done`, `off`, `future`, `past-missed`) from the habit's cadence + the entry's habit-log JSON + the off-day toggle. Computation is pure; inputs are `(habit, date, entry, isOffDay)`.

**Take + verdict**

`computeCellState` is called per render for every habit × every day in the week — roughly 5 habits × 7 days = 35 calls per render, more if the user has more habits. The function is pure and cheap (constant time per call), so the saved work from `useMemo`-ing it is small. The win would be at scale — 20 habits × 7 days = 140 cells per render, which is still well under a millisecond. *Not worth doing today*; if the grid ever expands to a month view (4-5 weeks × N habits), revisit. The pattern note worth taking is "pure derivation functions in render are fine until the cell count crosses ~500 and you can measure the cost in a Profiler trace." Buffr is two orders of magnitude under that.

---

## Chapter close

**Take:** buffr has no DSA problem. This is by design — the architectural rules (scanners at commit not per-keystroke; sync paginates and batches; ffmpeg capped at 2 concurrent sessions; AI summaries cached per date) all push back on the patterns that produce DSA debt in growing apps. The two BRIEF items above are worth knowing exist and not worth acting on. The pattern this suggests is: the most reliable way to avoid DSA refactors later is to write architectural rules that prevent the cheap-feeling code (per-keystroke scanners, per-render computes, unbatched I/O) at the front. Buffr did this and is benefiting from it. The flip side worth being honest about: this discipline doesn't scale to multi-user. The day Phase B ships and there are 100 concurrent users, the single-Postgres-instance + pooled-quota model from the audit's Section 7 will be the bottleneck, not anything in this chapter.
