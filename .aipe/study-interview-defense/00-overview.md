# Interview defense — buffr

This is your defense book. Not a reference grid you grep under pressure — a book you read front-to-back once, skim the visual treatments on the second pass, and read only the one-page summaries the night before. It defends **buffr**: the local-first daily-vlogging journal you built solo, with SQLite as the canonical store, Supabase as an opt-in mirror, and five single-purpose AI chains doing the composition work.

The job of this book is to get you ready to defend buffr in a senior interview — to answer "walk me through a project" and survive every follow-up without bluffing. Where buffr has a weak spot, you'll own it on your terms instead of getting cornered into it. Where buffr made a sharp call, you'll have the one-sentence version ready.

## The system at a glance

```
┌─ buffr — local-first daily-vlogging journal (React Native + Expo, Android) ──┐
│                                                                              │
│  UI layer (app/, file-routed via expo-router)                               │
│    editor/[date]   journal/[date]   todos/[id]   threads/[id]   settings/   │
│         │                                                                    │
│         ▼  reads + writes (always local, synchronous, <5ms)                  │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │ Service layer (src/services/)                                       │    │
│  │                                                                     │    │
│  │   ai/        5 chains: summarize · caption · expand · classify ·    │    │
│  │              interpret  (Anthropic Sonnet/Haiku ⇄ OpenAI toggle)    │    │
│  │   todos/     scan → heuristic-classify → LLM fallback → reconcile   │    │
│  │   threads/   #tag graph: scan · crud · staleness · touch            │    │
│  │   sync/      push · pull · orchestrator · conflict (LWW) · bootstrap │    │
│  │   database.ts  every write bumps updated_at + schedulePush()        │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│         │                                                                    │
│         ▼                                                                    │
│  Storage layer                                                              │
│    SQLite (buffr.db, WAL) ── CANONICAL ─────────┐                           │
│         │                                        │  background sync          │
│         │  debounced push (5s) ── updated_at>synced_at ──▶                   │
│         ▼                                        ▼                           │
│    Supabase Postgres (buffr schema) ── MIRROR ── never on the read path     │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

The one thing to carry into the room: **the device is canonical, the cloud is a mirror that catches up.** Every architectural decision in buffr flows from that. If you can defend that sentence and its consequences, you can defend buffr.

## The 8 chapters

| # | Chapter | The questions it covers |
|---|---------|-------------------------|
| 01 | [The pitch](./01-the-pitch.md) | "Tell me about a project" — in 10s, 30s, 90s |
| 02 | [The architecture](./02-the-architecture.md) | "Walk me through the system" + where they interrupt |
| 03 | [The choices](./03-the-choices.md) | "Why SQLite-canonical? Why Expo? Why Anthropic?" |
| 04 | [The scale story](./04-the-scale-story.md) | "What breaks first at 10x / 100x?" |
| 05 | [The failure story](./05-the-failure-story.md) | "What happens when the LLM API is down? When sync fails?" |
| 06 | [The hard parts](./06-the-hard-parts.md) | "Hardest bug? Proudest part? Weakest spot?" |
| 07 | [The counterfactuals](./07-the-counterfactuals.md) | "What would you do differently?" |
| 08 | [The AI question](./08-the-ai-question.md) | "Did you use AI to build this?" |

## How to use this book

- **First read:** in order, 01 → 08. Each chapter builds on the last — the architecture (02) sets up the choices (03), which set up the scale (04) and failure (05) stories.
- **Review pass:** skim each chapter's chapter-opening diagram, the pull quotes (`┃` lines), and the one-page summary. That's ~70% of the value in ~20% of the time.
- **Night before:** read only the one-page summary at the end of each chapter. Eight summaries, ten minutes.
- **Mock interview:** have someone ask you the "What they're really asking" questions in random order. If you reach for a pull quote and it comes out clean, you're ready.

## The defenses are grounded in real code

Every claim in this book points at a real file, function, or migration in buffr — `src/services/sync/orchestrator.ts`, `supabase/migrations/0009_disable_rls_phase_a.sql`, `src/services/todos/heuristicClassify.ts`. If a defense names something, you can open it. That's the point: a defense you can't open is a defense you can't make.

## Where this book sits in the study system

This book is the **wide opener** — it covers the whole project at interview breadth. The **deep dives** live in the concept-level `## Interview defense` blocks inside the other two guides:

- `.aipe/study-system-design-dsa/` — per-pattern defenses (cloud-sync mirror, composite-PK auth boundary, two-pass matching, append-only migrations).
- `.aipe/study-ai-engineering/` — per-concept defenses (heuristic-before-LLM, structured outputs, provider abstraction, eval-driven iteration).

Read this book to get the shape of the whole interview. Drop into the concept files when an interviewer pushes you deep on one pattern.
