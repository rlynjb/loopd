# Curriculum overview — loopd as a practical study guide for system design, DSA, and AI

## Why this curriculum exists for THIS codebase

Most "system design + DSA + AI" study material is hypothetical: design Twitter, balance an AVL tree, prompt a fictional bot. Useful for whiteboards. Bad for memory.

**loopd is the opposite.** It is a real, shipping app that already encodes the same answers you'd give in an interview, but in concrete TypeScript you can read, run, and modify:

- It does **system design** — local-first SQLite as the source of truth, debounced cloud sync, conflict resolution by last-write-wins, soft deletes, idempotent migrations, ordered table dependencies, parallel transcode + in-order commit.
- It does **DSA in disguise** — two-pass matching is a degenerate sequence-alignment algorithm; the dashboard ranking is a multi-key comparator; the heatmap is a range-bucketed compute over a sliding 14-day window; the n_per_week streak counts completed weeks via set cardinality; the dashboard aggregator is a hash-join + group-by; manual reorder uses sparse-then-dense integer positions.
- It does **AI** — heuristic-before-LLM gating, two-stage classification (cheap classifier → expensive expander), per-type structured-output prompts with chain-of-thought preambles, malformed-JSON validate-and-retry, capped concurrency, context-window budgeting, second-pass tonal-continuity captioning.

Every chapter that follows takes one of those concepts, names it formally, points at the file and line where it lives in `/Users/rein/Public/loopd/`, and explains the general principle so you can carry it to the next codebase or interview.

## The codebase you're studying — three sentences

1. loopd is a solo-built native Android (Expo + React Native + TypeScript) daily-vlogging app: jot text, tick habits, capture clips throughout the day, then tap one button to auto-compose an MP4 vlog using AI.
2. The journal prose is **canonical** — `[]` lines become todos, `** food N kcal` becomes a nutrition row, `#tag` becomes a thread mention; everything else is *derived* by two-pass scanners that run only at commit time.
3. SQLite is the source of truth (writes go local first, every keystroke); Supabase is a 5s-debounced sync mirror; AI calls (Anthropic Sonnet/Haiku + OpenAI GPT) are gated behind a heuristic-first discipline so the cheap deterministic path always runs before any model is called.

## How to study this curriculum — the read → find → explain back loop

This is not a textbook. Read passively and you will retain almost nothing. The loop:

1. **Read the chapter section** for one concept — the four parts (What it is / Where it lives / Why it exists / General rule).
2. **Open the referenced file** at the exact line numbers given. Read 30–50 lines around the citation. Notice what is *not* in the explanation.
3. **Close the file.** Without looking, explain the concept back in your own words — out loud, on paper, or to a friend. If you stall, you don't know it yet. Re-read.
4. **Implement a tiny variation.** Change a regex, swap a comparator, flip a flag, break a test, watch what fails. The principle stops being abstract the moment a compiler error stares back at you.

One concept per session. 30 focused minutes beats three unfocused hours.

## Why the three-pillar framing (system design, DSA, AI)

This codebase is small enough to fit in your head and dense enough to teach all three pillars in their honest, messy form:

- **System design** lives mostly in chapters `02-systems-thinking.md` (data flow, idempotency, cloud sync) and `03-thinking-in-code.md` (provider abstraction, soft delete, debounced writes).
- **DSA** lives mostly in `03-thinking-in-code.md` (two-pass matching, multi-key sort, sparse-then-dense ordering, hash-join aggregation, sliding-window compute) and `05-language-agnostic.md` (transferable patterns).
- **AI** lives mostly in `01-agentic-ai.md` (classifier → expander pipeline, prompt chaining, structured output) and `04-ai-product-engineering.md` (cost vs capability, context budgeting, evaluation, spec-driven AI dev).

The chapters use the same five fixed categories the curriculum template names so you can compare apples-to-apples with future runs of `/aipe:curriculum`. The DSA + system-design + AI emphasis is in *what gets surfaced first within each chapter*, not in the chapter labels.

## Difficulty markers

Each concept is tagged:

- **foundational** — prerequisite for almost everything that follows. Read first.
- **intermediate** — assumes the foundationals; this is where it gets interesting.
- **advanced** — assumes both, plus you're ready to make architectural judgment calls of your own.

## Order of chapters

The chapter files are organized by **category of thinking**, not by reading order. The reading order — the actual learning path that respects prerequisites — lives in `06-curriculum-path.md`.

| File | Category | Pillar weight |
|---|---|---|
| `00-overview.md` | this file | — |
| `01-agentic-ai.md` | Agentic AI | AI |
| `02-systems-thinking.md` | Systems thinking | System design |
| `03-thinking-in-code.md` | Thinking in code | DSA + system design |
| `04-ai-product-engineering.md` | AI product engineering | AI + system design |
| `05-language-agnostic.md` | Language-agnostic patterns | All three (transferable) |
| `06-curriculum-path.md` | The ordered learning path | — |

Start with `06-curriculum-path.md` if you only have time for one file — it points at the four foundational concepts to anchor on first.
