# 01 — Preface: what this project is really about

> **Read first.** This chapter exists to frame what an interviewer should take away from buffr before they ask a single question.

If you describe buffr as "a journaling app with a built-in todo tracker and a vlog editor," you've already lost. That's the surface. The interesting thing about buffr is that it's three architectural experiments hiding behind a journaling UI, and any one of those experiments is enough to talk for an hour.

Here are the three. Memorize them. They are the project, in priority order.

**The first experiment is prose-canonical drops.** Most apps that combine free-form writing with structured records — todos, calorie counts, tags — make the user mode-switch. They put up a separate todo input, or a special tag-entry surface, or a slash-command palette. buffr doesn't. The user types `[] call mom` in a normal journal entry. The app scans the prose at commit time and *derives* a structured todo from that line. The text stays the canonical source. Edit the line, the todo updates. Delete the line, the todo archives. Toggle the todo's done state from the dashboard, and the prose rewrites from `[]` to `[x]` to keep prose authoritative. This is the structural decision the rest of the codebase orbits.

**The second experiment is heuristic-first cost-tiered AI.** Every `[]` line is classified into one of seven thinking modes (todo, idea, bug, question, decision, knowledge, content). A free deterministic classifier — about 50 imperative verbs and modal phrases — handles the obvious 70-80%. Only the genuinely ambiguous 20% goes to a cheap LLM (Haiku or GPT-4o-mini, ~$0.0001 per call). When the user explicitly taps "expand" on a non-todo, a primary-tier LLM (Sonnet 4.6 or GPT-4o, ~$0.04 per call) produces a structured per-type analysis. Three cost tiers, three jobs, deliberately different model selections. The architectural principle is simple: AI is expensive and slow; build the cheap deterministic path first; use the LLM only where the heuristic abstains.

**The third experiment is local-first SQLite with Supabase Postgres as a sync mirror.** The local database is canonical for everything — entries, todos, nutrition, AI summaries, expansion outputs, threads, mentions. Cloud is the safety net you opt into; reads always hit local; writes always commit local first; the cloud lags by 5 seconds via a debounced push (Architectural Principle 12). The previous version of this app synced to Notion as the cloud target — that whole layer was deleted in commit `dc8483a` once the Supabase migration stabilized, removing ~2,200 lines of mappers/rate-limiter/outbox-queue code. The migration shipped across 7 milestones with Notion staying live alongside Supabase from M2 through M6 as a safety net, then deleted in one satisfying commit. The sync layer does real work: incremental push/pull paginated by `updated_at`, server-clock-anchored cursors via a `get_server_time()` Postgres RPC, soft delete via `deleted_at` columns that propagate as normal sync events, and last-write-wins conflict resolution. None of this is template code.

```
                       What buffr actually is

  ┌─────────────────────────────────────────────────────────────┐
  │                                                             │
  │   1. Prose-canonical drops                                  │
  │      "[] call mom" in journal text                          │
  │              │                                              │
  │              ▼                                              │
  │      Two-pass scanner extracts structured todos             │
  │              │                                              │
  │              ▼                                              │
  │      Dashboard mutations round-trip back to prose           │
  │                                                             │
  ├─────────────────────────────────────────────────────────────┤
  │                                                             │
  │   2. Heuristic-first cost-tiered AI                         │
  │      ┌─────────────┐                                        │
  │      │ heuristic   │  free, ~0.1ms — handles 70-80%         │
  │      └──────┬──────┘                                        │
  │             │ null (ambiguous)                              │
  │             ▼                                               │
  │      ┌─────────────┐                                        │
  │      │ classifier  │  Haiku / 4o-mini, ~$0.0001 per call    │
  │      └──────┬──────┘                                        │
  │             │ user-tapped expand                            │
  │             ▼                                               │
  │      ┌─────────────┐                                        │
  │      │  expander   │  Sonnet / 4o, ~$0.04 per call          │
  │      └─────────────┘                                        │
  │                                                             │
  ├─────────────────────────────────────────────────────────────┤
  │                                                             │
  │   3. Local-first SQLite, Supabase as sync mirror            │
  │                                                             │
  │      SQLite (canonical)                                     │
  │             │   debounced push ───► Supabase Postgres       │
  │             │   (5s after every write + on boot)            │
  │             ▲                                       │       │
  │             └─── incremental pull (updated_at ASC) ─┘       │
  │             chooseWinner = LWW by updated_at                │
  │                                                             │
  │      If cloud breaks: app keeps working offline-first       │
  │      If SQLite breaks: cloud restores via firstPullAll      │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

What this project shows about me as an engineer is that I can hold all three of these decisions in my head simultaneously and explain why each one was the right call given the constraints. The code is the artifact; the thinking is the point.

A few stats so the rough scope is grounded:

- ~12k lines of TypeScript (after the cloud-sync migration deleted ~2,200 of Notion-era code)
- 12 SQLite tables — 11 entity tables plus `sync_meta` (local-only ledger). The `todo_meta` table holds a 1:1 invariant with each TodoItem in `entries.todos_json`, enforced by application logic since SQLite can't FK to a JSON-array element.
- 7-milestone ship plan for the most recent major migration (Notion → Supabase Postgres), each milestone independently revertible — see [`docs/buffr-cloud-sync-plan.md`](../../../docs/buffr-cloud-sync-plan.md).
- 4 LLM calls across 3 cost tiers, multi-provider (Anthropic + OpenAI)
- React Native + Expo, Android-only (the prebuilt `android/` directory is committed)
- Solo-developed with substantial AI-assisted code generation, all decisions mine

I built this because I wanted a journaling app I'd actually use, but more than that, I wanted a project where the architectural decisions were mine and I could defend every one of them. Read the rest of this guide and you should leave able to do the same.

The next chapter is system architecture — request flow from the moment a user taps the keyboard to the moment a row lands in Supabase.

→ [02 — System architecture](./02-system-architecture.md)
