# Interview prep: study system design, DSA & AI

A book-style prep guide for defending **buffr** — a solo-built, Android-only daily-vlogging app combining a prose journal (with `[]` / `** food` / `#tag` markers driving derived state), an AI-assisted vlog editor (4-variant tonal captions), a Claude Sonnet + Haiku AI stack with Supabase Postgres cloud sync. Refreshed against the latest codebase as of 2026-05-05 (post-`a7d6044`: pin replacing reorder, swipe-to-delete, daily schedule grid, 4-variant captions, Notion sync layer fully removed).

Read in order. Each chapter builds on the previous. Practise the hard questions out loud — they're the ones an interviewer will ask if they want to push past the prepared answers.

## Table of contents

- [00 — Preface](00-preface.md) — the point buffr actually shows: a derived-state engine that hides behind a textbox; what to convey in the first 10 minutes.
- [01 — System architecture](01-system-architecture.md) — the four-part Shape/Rule/Failure/Contrast meta-section, then full request flow from keystroke to cloud, with the four load-bearing concepts (prose-canonical, DB-first autosave, two-pass scanner, cloud-as-mirror).
- [02 — Frontend engineering](02-frontend-engineering.md) — file-based routing, the dashboard's "props down, mutations up" pattern, the daily schedule grid, swipe-to-delete with explicit-height panels, why no global store.
- [03 — Backend and API design](03-backend-api.md) — why no Express layer, `database.ts` as the in-process API surface, the dirty-row push protocol, server-time RPC for clock-skew avoidance, AI provider switching.
- [04 — AI engineering](04-ai-engineering.md) — three single-purpose AI surfaces (summarize, generateCaption, classifyTodo), heuristic-before-LLM, defensive parsing over prompt engineering, the 4-variant single-call pattern.
- [05 — Data modelling](05-data-modelling.md) — JSON column for `todos_json`, real table for `todo_meta`, soft delete via `deleted_at`, composite `(user_id, id)` PKs, append-only Supabase migrations, why dead columns stay.
- [06 — Reliability and error handling](06-reliability.md) — stratified durability, optimistic UI with implicit rollback, self-healing reconciliation, async error isolation in AI calls, what's missing.
- [07 — Developer process](07-developer-process.md) — `.aipe/project/context.md` as durable AI context, spec-before-code, `docs/spec.md` as the canonical refresh target, `npx tsc --noEmit` as the only mandatory gate.
- [08 — Ownership and judgment](08-ownership-judgment.md) — the five hardest decisions (prose canonical, the manual-touch deviation, deferred vacuum, user-override lock, hardcoded user_id), and the hard reversal (Notion → Supabase).
- [09 — Data structures and algorithms](09-dsa.md) — three real problems with brute force + optimal + ASCII traces (two-pass scanner, cell-state derivation, dashboard pin-first sort) and a complexity cheat sheet across every major op.
- [10 — What I'd do differently](10-what-id-do-differently.md) — three changes immediately, three at scale, four to leave alone; the hard answer to "if you could fix one thing, what would it be?" (test suite).
- [11 — Defending AI-assisted work](11-defending-ai-work.md) — six talking points for the AI question, including a concrete walk-through of an AI-introduced bug I caught at review time and how to address "are you actually a senior engineer."
- [12 — Appendix: complexity cheat sheet](12-appendix-complexity.md) — every major operation in buffr with time + space + 10×-scale verdict; the lookup table to scan five minutes before the interview.

## How to use this guide

1. **First pass: read in order.** The chapters build. Don't jump to DSA before you've internalized the architecture; the DSA problems are grounded in the architecture's choices.
2. **Second pass: read the diagrams cold.** Each chapter has at least one ASCII diagram. If you can narrate the diagram out loud without reading the prose, you can answer a system-design question cold.
3. **Third pass: practise the hard questions out loud.** Each chapter ends with a question candidates dodge. The model answers are starting points; the interview answer needs to be in your own voice. Practise saying them — there's a difference between knowing an answer and being able to deliver it under pressure.
4. **Re-run after changes.** This guide is a snapshot of the codebase as of 2026-05-05. After significant changes (e.g., shipping the test suite, moving AI keys server-side, adding multi-user CRDT), regenerate via `/aipe:interview` so the chapters track reality.
