# AI engineering — overview of buffr's AI surface

**Codebase shape:** LLM application engineering (single-purpose chains, no RAG yet, no agents, no trained models).

## System map

```
┌─ buffr (React Native + Expo, Android-only) ────────────────────────────────┐
│                                                                            │
│   UI layer (app/)                                                          │
│   ────────────                                                             │
│     editor/[date]    journal/[date]    todos/[id]    settings/ai           │
│         │                  │                │                              │
│         ▼                  ▼                ▼                              │
│   Service layer (src/services/)                                            │
│   ─────────────────────────────                                            │
│                                                                            │
│   ┌─ src/services/ai/ ─────────────────────────────────────────────────┐   │
│   │                                                                     │   │
│   │  summarize.ts   ← structured AISummary per day                      │   │
│   │  caption.ts     ← 4 tonal caption variants per day                  │   │
│   │  compose.ts     ← orchestrator: cached read or trigger              │   │
│   │  validate.ts    ← Zod-shaped runtime checks on AI JSON              │   │
│   │  config.ts      ← provider toggle (anthropic | openai)              │   │
│   │  prompt.ts      ← shared system prompt fragments                    │   │
│   │                                                                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
│   ┌─ src/services/todos/ ──────────────────────────────────────────────┐   │
│   │                                                                     │   │
│   │  heuristicClassify.ts  ← regex-first pass: ~70% short-circuit       │   │
│   │  classify.ts           ← Claude Haiku 4.5 fallback (LLM call)       │   │
│   │  expand.ts             ← per-type structured expansion (LLM call)   │   │
│   │  reconcileMeta.ts      ← 1:1 invariant enforcement                   │   │
│   │                                                                     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                            │
│   Storage layer                                                            │
│   ─────────────                                                            │
│     SQLite (buffr.db, canonical)  →  Supabase Postgres mirror              │
│     `ai_summaries` cache         ─┘  (synced via debounced push)           │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

## What this codebase exercises

**LLM application engineering (Phase 1 of the curriculum):**

- 5 production chains: `summarize`, `caption`, `expand`, `classify`, `interpret`
- Provider abstraction (Anthropic Sonnet 4.6 + Haiku 4.5 primary, OpenAI GPT-4o + 4o-mini alternate)
- Heuristic-before-LLM short-circuit on the classifier (`heuristicClassify.ts`)
- Structured outputs with runtime Zod-shaped validation (`validate.ts`)
- User-override locks (`todo_meta.user_overridden_type`)
- Cached-read pattern in `compose.ts` to avoid repeat LLM calls per day

**What's not here yet (Case B across this guide):**

- No RAG. Principle #11 in `docs/spec.md` says hand-picked retrieval (recency + sibling todos, ≤1000 chars) beats vector search at current corpus size. The "above-threshold" exception is documented but not implemented.
- No agents. All 5 chains are single-shot — no loops, no tool calling, no ReAct.
- No formal eval set. No golden suite, no regression suite, no LLM-as-judge harness. The closest thing is `validate.ts`, which is a parse-shape check, not a quality check.
- No formal observability. No `ai_call_log` table, no token-spend dashboard, no latency tracing. Failures surface as thrown errors that bubble through `compose.ts` and into the UI as silent fallbacks.
- No production hardening. No retry/backoff, no circuit breaker, no rate limiting, no prompt-injection sanitization. The chains assume happy-path provider availability.

**ML surface: none.** Buffr has no trained models, no on-device inference, no recommenders, no classifiers in the ML sense. The `classify.ts` chain is an LLM call, not a trained model. Sub-sections `08-machine-learning/` and `09-ml-system-design-templates/` are skipped per the spec — buffr does not exercise that surface.

## How to read this guide

Three reading orders depending on what you came for:

1. **Onboarding to buffr's AI:** Read `ai-features-in-this-codebase.md`, then `01-llm-foundations/` in order. That gives you the feature shapes and the patterns each one uses.
2. **Interview prep:** Read `07-system-design-templates/01-search-ranking.md` and `02-tech-support-chatbot.md`. Both walk an interview prompt against this codebase as the standard architecture.
3. **Curriculum-driven study:** Walk the sub-sections in order. Case B files (the bulk of `03-retrieval-and-rag/`, all of `04-agents-and-tool-use/`, most of `05-evals-and-observability/`) name the build target — the Project exercises block is the buildable spec.

## Sub-section legend

- **01-llm-foundations/** — what an LLM is and the 9 operational patterns buffr uses around it
- **02-context-and-prompts/** — context-window mechanics, lost-in-the-middle, multi-step prompt chaining (buffr's `summarize → caption` is the live example)
- **03-retrieval-and-rag/** — embeddings, chunking, vector storage, the full RAG pipeline. Mostly Case B; build target is the Phase 2A spec for `interpret-this-week` and thread `related-entries`.
- **04-agents-and-tool-use/** — chains vs agents, tool calling, ReAct, routing, memory. All Case B; buffr does not use agents today.
- **05-evals-and-observability/** — golden / adversarial / regression sets, eval methods, judge bias, observability. Mostly Case B; build target is the Phase 3 eval harness for the 5 chains.
- **06-production-serving/** — caching, cost optimization, prompt injection, rate limiting, retry + circuit breaker. Partly Case A (provider abstraction is in place); mostly Case B.
- **07-system-design-templates/** — Search ranking + Tech support chatbot reframed as interview prompts this codebase could answer (with the refactors named).
