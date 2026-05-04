# Curriculum overview — learning loopd

## What this curriculum is

This is a structured learning path through the **loopd** codebase — a solo-built native Android daily-vlogging app written in React Native + Expo + TypeScript, backed by on-device SQLite with optional Supabase cloud sync, and threaded with two AI providers (Anthropic Claude + OpenAI GPT) for classification, expansion, summarization, and caption generation.

You are not here to read a textbook. You are here to read **a real, shipping codebase** through the lens of the formal concepts hiding inside it. Every concept in this curriculum is grounded in a specific file, function, or pattern in `/Users/rein/Public/loopd/`. When the chapter says "this lives in `src/services/sync/push.ts:9-67`," it does. Open the file. Read the lines. Then close the file and re-explain it.

## The codebase you're studying

Three sentences:

1. loopd lets you jot text + capture clips + tick habits all day in a single journal screen, then taps a "vlog" button at end-of-day to auto-compose a video using AI.
2. The journal prose is the **canonical source of truth** — `[]` lines become todos, `** food N kcal` lines become nutrition entries, `#tag` mentions become thread references. Everything derived is rebuilt from prose by two-pass scanners that run only at commit time, never on keystroke.
3. The whole thing is local-first: SQLite is canonical, Supabase is a sync mirror, and AI calls are configured per-user with a heuristic-before-LLM discipline so the cheap path always runs first.

## How to study this curriculum

The fastest way to actually learn is the **read → find → explain back** loop:

1. **Read the chapter section** for one concept — the four-part explanation (What it is / Where it lives / Why it exists / General rule).
2. **Open the referenced file** at the exact line numbers given. Read 30–50 lines around the cited location. Notice what's *not* in the explanation.
3. **Close the file.** Without looking, explain the concept back in your own words — out loud, or in writing. If you can't, you don't know it yet. Re-read.
4. **Implement a tiny variation.** Change something. Break it. Watch how the system responds. The principle stops being abstract the moment you have to defend it against a compiler error.

That loop will teach you more in 30 minutes than reading the whole curriculum end-to-end in 3 hours. Pick **one concept per session**.

## Difficulty markers

Each concept is tagged:

- **foundational** — you need this before anything else makes sense. Read first.
- **intermediate** — assumes you have the foundationals. The "this is where it gets interesting" tier.
- **advanced** — assumes both, plus you're starting to make architectural judgment calls of your own.

## Order of chapters

The chapters are organized by **category of thinking**, not by reading order. The reading order lives in `06-curriculum-path.md` — it walks across categories, prerequisites first.

| File | Category | What it teaches |
|---|---|---|
| `01-agentic-ai.md` | Agentic AI | How LLMs are used as classifiers, expanders, and chained-pass generators in a real app |
| `02-systems-thinking.md` | Systems thinking | Single source of truth, derived state, sync orchestration, idempotency, race-safety |
| `03-thinking-in-code.md` | Thinking in code | Type-driven design, schema-first migrations, discriminated unions, debouncing, validation |
| `04-ai-product-engineering.md` | AI product engineering | Context window management, prompt chaining, response caching, cost vs capability tradeoffs |
| `05-language-agnostic.md` | Language-agnostic | Patterns that transfer to any stack: invariants, locks, principle docs, soft delete |
| `06-curriculum-path.md` | — | The ordered learning path with prerequisites and difficulty marks |

## What this curriculum is *not*

- **Not a tutorial.** You won't be told to install anything or run anything (those instructions live in the project README).
- **Not API documentation.** It explains *why* things are shaped the way they are, not the full surface area.
- **Not a defense of every choice.** Some things in loopd are pragmatic shortcuts (single hardcoded `user_id` in Phase A, hardcoded model IDs, no test suite). The curriculum will name those honestly. Pragmatic shortcuts are part of how real systems get built; pretending otherwise would teach you the wrong lesson.

## A note on the "missing" parts

The curriculum will sometimes say *"this concept is partially implemented — completing it would deepen your understanding."* Treat those as **exercises**. The most expensive part of learning systems is the gap between reading about a pattern and recognizing when you need it. Implementing a partial pattern in a real, opinionated codebase is the cheapest way to close that gap.
