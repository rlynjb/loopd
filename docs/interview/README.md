# loopd — Interview prep

A book-style defense guide for the loopd codebase. Read in order the first time. Each chapter builds on the previous. After you've read it once, the chapter index doubles as a quick-lookup before specific interviews.

Written from the seat of a staff engineer who built this thing — first person, opinionated, specific. No hedging. Tradeoffs named. Where something's weak, the chapter says so plainly.

## Reading path

| # | Chapter | What it teaches you to defend |
|---|---|---|
| 01 | [Preface — what this project is really about](./01-preface.md) | The architectural pitch in 60 seconds |
| 02 | [System architecture](./02-system-architecture.md) | Request flow, layered design, scalability ceiling |
| 03 | [Frontend engineering](./03-frontend.md) | State strategy, ref vs state vs DB, perf reality check |
| 04 | [Backend and API design](./04-backend-api.md) | Supabase push/pull, soft delete, conflict resolution, bootstrap detection |
| 05 | [AI engineering](./05-ai-engineering.md) | Four LLM calls / three cost tiers, heuristic-first, JSON validation + retry, relatable-caption pass |
| 06 | [Data modelling](./06-data-modelling.md) | 12-table schema, 1:1 invariant, soft-delete columns, JSON-vs-normalized |
| 07 | [Reliability and error handling](./07-reliability.md) | DB-first writes, self-healing reconcile, idempotent backfills |
| 08 | [Developer process](./08-developer-process.md) | Spec-driven phased shipping, build/install loop, why no test suite |
| 09 | [Ownership and judgment](./09-ownership-judgment.md) | The decisions that weren't obvious — most important chapter |
| 10 | [Data structures and algorithms](./10-dsa.md) | Three coding problems derived from real loopd ops, with traces |
| 11 | [Defending AI-assisted work](./11-defending-ai-work.md) | The six questions, answered with ownership not deflection |
| 12 | [What I'd do differently](./12-what-id-do-differently.md) | Honest retrospective — what was a reasonable call I'd now change |
| 99 | [Appendix — complexity cheat sheet](./99-appendix-complexity.md) | Big-O for every significant operation, scale-judgment per row |

## How to use this

**The night before, read [01-preface](./01-preface.md), [02-system-architecture](./02-system-architecture.md), and [09-ownership-judgment](./09-ownership-judgment.md).** Those three chapters are the project's soul. If you internalize those, you can talk to anyone for an hour.

**For specific interviews:**

| Interview type | Chapters to focus |
|---|---|
| Frontend / UI | 03 + 09 + 11 |
| Backend / systems | 02 + 04 + 06 + 07 |
| AI engineering | 05 + 11 + relevant DSA in 10 |
| Architecture / staff | 02 + 06 + 09 + 12 |
| Coding round | 10 + 99 |
| Behavioral | 09 + 12 + 11 |

**Practice the hard questions out loud.** Each chapter ends with the question candidates dodge. Saying it aloud, in your own words — not reciting — is the difference between knowing an answer and being able to give it under pressure.

## Re-running this guide

The guide is only as accurate as the codebase it's written against. After any significant feature change — a CRDT layer, a new sync target, an auth + RLS rollout for Phase B — chapters 4, 6, and 7 will need updates. Each chapter is a separate file so the regen is focused: rewrite just chapter 6, leave the others intact. (The Notion-to-Supabase migration in 2026-05 was the most recent example — chapters 02, 04, 06, 07, 09, 12, 99 were refreshed; the others took surgical patches.)

The other docs in `docs/` serve different purposes and don't overlap:

- [docs/spec.md](../spec.md) — the canonical architecture reference (what loopd *is*).
- [docs/concepts.md](../concepts.md) — a self-study learning curriculum (concepts grounded in this codebase).
- [docs/dsa-study-guide.md](../dsa-study-guide.md) — six DSA problems for coding-round drill (this guide's chapter 10 covers three of them).

Start at [chapter 01](./01-preface.md).
