# Interview prep: study system design, DSA, AI

A book-style prep guide for defending loopd — a solo-dev, native Android daily-vlogging app — in technical interviews focused on system design, data structures and algorithms, and AI engineering. Written from the perspective of a staff engineer asking the questions a real interviewer would ask, answered in first person, grounded in the actual files of this repository.

## Contents

- [00 — Preface](00-preface.md) — what this project is really about, beyond "another vlogging app": prose-canonical data with derived projections.
- [01 — System architecture](01-system-architecture.md) — opens with the four-part Shape/Rule/Failure/Contrast meta-section that every later chapter applies; then walks the keystroke-to-storage path.
- [02 — Frontend engineering](02-frontend-engineering.md) — the journal screen's keystroke contract, dashboard round-trip writes, autocomplete sibling layout.
- [03 — Backend and API design](03-backend-api.md) — why there is no Express server: SQLite-as-backend, Supabase as sync mirror, table-as-plugin via `SyncableTable`.
- [04 — AI engineering](04-ai-engineering.md) — heuristic-before-LLM, user-override-as-permanent-lock, caption-failure firewall, per-type expansion validation. One of the substantive chapters.
- [05 — Data modelling](05-data-modelling.md) — eleven SQLite tables, the 1:1 todos_json/todo_meta invariant, the manual-touch deviation in `thread_mentions`.
- [06 — Reliability and error handling](06-reliability.md) — DB-first autosave, focus cleanup safety, sync error isolation, backfill idempotency.
- [07 — Developer process](07-developer-process.md) — the `.aipe/` memory bank, spec-driven implementation, manual test discipline.
- [08 — Ownership and judgment](08-ownership-judgment.md) — the slug-rejected-on-pull rule, prebuilt `android/` decision, AI provider switchability. The most important chapter for showing senior-level thinking.
- [09 — Data structures and algorithms](09-dsa.md) — five real algorithms from the codebase with brute-force vs optimal traces. One of the substantive chapters.
- [10 — What I'd do differently](10-what-id-do-differently.md) — five things to change, five things to leave alone, with reasoning.
- [11 — Defending AI-assisted work](11-defending-ai-work.md) — talking points for "how much did the AI write" and the five other interviewer questions in this category.
- [12 — Appendix: Complexity cheat sheet](12-appendix-complexity.md) — every major data operation in the app with current complexity and 10× scale notes.

## How to use this guide

1. **Read in order on the first pass.** Chapters build: architecture → frontend → backend → AI → data → reliability → process → judgment → DSA → retrospective. The narrative is the prep, not just the Q&A at the end of each chapter.
2. **Study each diagram before reading its prose.** If you can explain the diagram cold, you can answer the system-design version of the question cold.
3. **Practise the hard question out loud.** Each chapter ends with the question candidates dodge. Practise saying those answers in your own words, not mine.
4. **Drill chapters 1, 4, and 9 hardest** — they're the ones aligned with the user's stated focus (system design, AI engineering, DSA). Chapter 8 (ownership and judgment) is the chapter that most differentiates senior signal from mid signal.

## What this guide is not

- Not a Q&A flash card set — read it as a book, the chapters reference each other.
- Not a comprehensive DSA textbook — chapter 9 covers only patterns that live in this codebase. For the broader set, see `docs/dsa-study-guide.md` in the repo root.
- Not a script — the model answers are written in first person to internalize, not to recite. Translate to your own voice.

## When to regenerate

After significant changes to the architecture (new principle, new sync table, new AI surface), re-run `/aipe:interview study system design, dsa, ai` to refresh. This guide is a snapshot of the codebase as of 2026-05-04.
