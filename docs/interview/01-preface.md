# 01 — Preface: what this project is really about

> **Read first.** This chapter exists to frame what an interviewer should take away from loopd before they ask a single question.

If you describe loopd as "a journaling app with a built-in todo tracker and a vlog editor," you've already lost. That's the surface. The interesting thing about loopd is that it's three architectural experiments hiding behind a journaling UI, and any one of those experiments is enough to talk for an hour.

Here are the three. Memorize them. They are the project, in priority order.

**The first experiment is prose-canonical drops.** Most apps that combine free-form writing with structured records — todos, calorie counts, tags — make the user mode-switch. They put up a separate todo input, or a special tag-entry surface, or a slash-command palette. loopd doesn't. The user types `[] call mom` in a normal journal entry. The app scans the prose at commit time and *derives* a structured todo from that line. The text stays the canonical source. Edit the line, the todo updates. Delete the line, the todo archives. Toggle the todo's done state from the dashboard, and the prose rewrites from `[]` to `[x]` to keep prose authoritative. This is the structural decision the rest of the codebase orbits.

**The second experiment is heuristic-first cost-tiered AI.** Every `[]` line is classified into one of seven thinking modes (todo, idea, bug, question, decision, knowledge, content). A free deterministic classifier — about 50 imperative verbs and modal phrases — handles the obvious 70-80%. Only the genuinely ambiguous 20% goes to a cheap LLM (Haiku or GPT-4o-mini, ~$0.0001 per call). When the user explicitly taps "expand" on a non-todo, a primary-tier LLM (Sonnet 4.6 or GPT-4o, ~$0.04 per call) produces a structured per-type analysis. Three cost tiers, three jobs, deliberately different model selections. The architectural principle is simple: AI is expensive and slow; build the cheap deterministic path first; use the LLM only where the heuristic abstains.

**The third experiment is local-first SQLite with optional bidirectional Notion sync.** The local database is canonical for everything — entries, todos, nutrition, AI summaries, expansion outputs. Notion is an *additive* sync target. If Notion's API breaks tomorrow, every captured byte is intact locally and the user keeps using the app. The sync layer has to do real work: per-field merge rules, schema-gap tolerance for users on older Notion DB versions, a sync-deletion queue with an `entity_type` discriminator, and a module-level rate limiter that serializes every Notion call regardless of which feature triggered it. None of this is template code.

```
                       What loopd actually is

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
  │   3. Local-first SQLite, additive Notion sync               │
  │                                                             │
  │      SQLite (canonical) ─── push dirty rows ───► Notion     │
  │             ▲                                       │       │
  │             └─── pull merge per-field rules ────────┘       │
  │                                                             │
  │      If Notion breaks: app keeps working                    │
  │      If SQLite breaks: there is no app                      │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

What this project shows about me as an engineer is that I can hold all three of these decisions in my head simultaneously and explain why each one was the right call given the constraints. The code is the artifact; the thinking is the point.

A few stats so the rough scope is grounded:

- ~11k lines of TypeScript
- 9 SQLite tables (one of them — `todo_meta` — has a 1:1 invariant with each TodoItem in `entries.todos_json` enforced by application logic, not foreign key)
- 4-phase ship plan for the latest feature (thinking-modes), each phase independently shippable
- 3 LLM model integrations across 3 cost tiers, multi-provider (Anthropic + OpenAI)
- React Native + Expo, Android-only (the prebuilt `android/` directory is committed)
- Solo-developed with substantial AI-assisted code generation, all decisions mine

I built this because I wanted a journaling app I'd actually use, but more than that, I wanted a project where the architectural decisions were mine and I could defend every one of them. Read the rest of this guide and you should leave able to do the same.

The next chapter is system architecture — request flow from the moment a user taps the keyboard to the moment a Notion page exists.

→ [02 — System architecture](./02-system-architecture.md)
