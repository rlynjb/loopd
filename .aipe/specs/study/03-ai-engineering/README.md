# 03 — AI engineering

Every AI concept in scope for buffr via the curriculum, organized by sub-discipline AND by curriculum phase. Each file opens with a "Why care" zoom-out, walks the mechanics in "How it works," and closes with Interview defense + Validate.

**Mode:** curriculum-loaded (buffr is anchored to Phase 1 / 2A / 3 / 5 of `aieng-curriculum.md`).

Files for already-implemented concepts have Case A `## In this codebase` (real code references). Files for not-yet-implemented concepts have Case B `## In this codebase` ("Not yet implemented — deferred to Phase X") and use `## Project exercises` as the primary buildable target.

## Index by curriculum phase

Use this view to trace each phase's concepts in order.

### Phase 1 — LLM application foundations (anchor: buffr + aipe)

| # | Concept | Status | Curriculum ID | One-line |
|---|---|---|---|---|
| 21 | [Tokenization](./21-tokenization.md) | learn-only | `[C1.1]` | Why context windows are sized in tokens; buffr consumes counts, doesn't tokenize. |
| 03 | [Context window](./03-context-window.md) | Case A (learn-only) | `[C1.2]` | Hand-picked, capped slices per chain. |
| 15 | [Sampling parameters](./15-sampling-parameters.md) | Case A | `[C1.3]` | Only `interpret` tunes temperature; defaults elsewhere. |
| 16 | [Structured outputs](./16-structured-outputs.md) | Case A | `[C1.4]` | Every JSON chain validates after parse. |
| 22 | [Streaming responses](./22-streaming.md) | learn-only | `[C1.5]` | buffr doesn't stream; the design decision is why. |
| 23 | [Token economics](./23-token-economics.md) | Case B | `[C1.6]` | The `ai_call_log` table and AI ops panel. |
| 17 | [Anatomy of a production prompt](./17-anatomy-of-prompt.md) | Case A | `[C1.7]` | Four-section prompt shape across all 5 chains. |
| 04 | [Provider abstraction](./04-provider-abstraction.md) | Case A | `[C1.8]` | Call-site branch, no shared `BaseChatModel`. |
| 05 | [Heuristic before LLM](./05-heuristic-before-llm.md) | Case A | `[C1.9]` | Cheap regex gate before classify. |
| 02 | [Single-purpose chains](./02-single-purpose-chains.md) | Case A | `[C1.10]` | Five chains, five jobs, no agent loops. |
| 10 | [user_overridden_type lock](./10-user-overridden-type-lock.md) | Case A | `[C1.11]` | Sticky user override survives re-classification. |
| 08 | [Validation gate](./08-validation-gate.md) | Case A | `[C1.12]` | Parse, don't validate — validators are runtime guards. |
| 18 | [Forbidden patterns + rotation](./18-forbidden-patterns-rotation.md) | Case A | `[C1.7]` detail | Anti-repetition layer for caption. |
| 19 | [Prompt chaining](./19-prompt-chaining.md) | Case A | `[C1.10]` detail | summarize → caption two-stage chain. |
| 01 | [What an LLM is](./01-what-an-llm-is.md) | foundational | — | The function-of-tokens framing. |

### Phase 2A — RAG over personal corpus (anchor: buffr)

All Case B except where noted — Phase 2A is the curriculum's next phase.

| # | Concept | Status | Curriculum ID | One-line |
|---|---|---|---|---|
| 24 | [Embeddings (geometric)](./24-embeddings-geometric.md) | Case B | `[C2.1]` | Vectors are positions in a learned space; cosine = angle. |
| 25 | [Embedding model choice](./25-embedding-models.md) | Case B | `[C2.2]` | Pick by eval on your data, not by MTEB. |
| 26 | [Chunking strategies](./26-chunking-strategies.md) | Case B | `[C2.3]` | Whole-entry first; sentence-window only if eval fails. |
| 27 | [Dense vs sparse retrieval](./27-dense-vs-sparse.md) | Case B | `[C2.4]` | Each handles cases the other gets wrong. |
| 28 | [Hybrid retrieval (RRF)](./28-hybrid-retrieval-rrf.md) | Case B | `[C2.5]` | `Σ 1/(60 + rank)`. Parameter-free combiner. |
| 29 | [Reranking (cross-encoder)](./29-reranking-cross-encoder.md) | Case B | `[C2.6]` | Two-stage; eval-driven decision in `[B2A.11]`. |
| 30 | [Vector databases](./30-vector-databases.md) | Case B | `[C2.7]` | sqlite-vec local, pgvector cloud; not a new service. |
| 31 | [Query rewriting / HyDE](./31-query-rewriting-hyde.md) | Case B | `[C2.8]` | Conditional; eval-driven on `[B2A.8]` first. |
| 32 | [Stale embeddings](./32-stale-embeddings.md) | Case B | `[C2.11]` | Mark-stale on write; re-embed on idle. |
| 33 | [Incremental indexing](./33-incremental-indexing.md) | Case B | `[C2.12]` | Three lifecycle paths: insert / update / delete. |
| 34 | [GraphRAG](./34-graphrag.md) | Case B | `[C2.13]` | `thread_mentions` is buffr's graph; combine with vectors. |
| 07 | [RAG](./07-rag.md) | Case A (no-RAG today) | `[C2.1]` overview | The "no RAG above bounded scope" decision. |

### Phase 3 — Evals and observability (anchor: buffr + aipe + contrl-mo)

| # | Concept | Status | Curriculum ID | One-line |
|---|---|---|---|---|
| 35 | [Eval set types](./35-eval-set-types.md) | Case B | `[C3.1]` | Golden + adversarial + regression; three jobs. |
| 36 | [Eval methods](./36-eval-methods.md) | Case B | `[C3.2]` | Five methods; match to output shape. |
| 37 | [LLM-as-judge bias](./37-llm-as-judge-bias.md) | Case B | `[C3.3]` | Position + verbosity + self-preference; controls for each. |
| 39 | ["No-click is not a negative label"](./39-no-click-not-negative.md) | learn-only | `[C3.7]` | Implicit feedback is partial truth. |
| 38 | [LLM observability](./38-llm-observability.md) | Case B | `[C3.10]` + `[C3.11]` | Trace tree per call; local SQLite at solo scale. |

### Phase 5 — Production serving (anchor: buffr + contrl-mo)

| # | Concept | Status | Curriculum ID | One-line |
|---|---|---|---|---|
| 40 | [LLM caching](./40-llm-caching.md) | Case B | `[C5.1]` | Two layers: prompt cache (provider) + semantic cache (app). |
| 41 | [LLM cost optimization](./41-llm-cost-optimization.md) | Case B | `[C5.3]` | Five levers, ROI-ordered. |
| 42 | [Rate limiting + backpressure](./42-rate-limiting-backpressure.md) | Case B (partial) | `[C5.4]` | Centralized queue + per-chain caps. |
| 43 | [Retry + circuit breaker](./43-retry-circuit-breaker.md) | Case B | `[C5.5]` | Retry small failures; break on big ones. |
| 11 | [Failure modes](./11-failure-modes.md) | Case A | `[C5.5]` + `[C5.7]` | Graceful degradation across all 5 chains. |
| 20 | [Prompt injection](./20-prompt-injection.md) | Case A | `[C5.7]` | Output-validation as defense; no input sanitiser. |

### Cross-cutting (codebase-specific, no direct curriculum tag)

| # | Concept | Status | One-line |
|---|---|---|---|
| 06 | [Tool calling](./06-tool-calling.md) | Case A (not used) | One-shot calls only; tool calling deferred. |
| 09 | [Async background classification](./09-async-classification.md) | Case A | Fire-and-forget; event-driven re-render. |
| 12 | [Why no agents](./12-why-no-agents.md) | Case A | Single chains by design. |
| 13 | [AI features in this app](./13-ai-features-in-this-app.md) | Case A | Per-feature pattern map. |
| 14 | [Interpret](./14-interpret.md) | Case A | Markdown out, no JSON, no persistence. |

## Index by sub-discipline

(Original v1.25.0 grouping retained for cross-referencing.)

### LLM foundations
01 · 03 · 04 · 05 · 10 · 15 · 16 · 21 · 22 · 23

### Prompt engineering
02 · 17 · 18

### Context and prompts
03 · 19

### Retrieval and RAG
07 · 24 · 25 · 26 · 27 · 28 · 29 · 30 · 31 · 32 · 33 · 34

### Agents and tool use
06 · 12

### Evals and observability
09 · 11 · 35 · 36 · 37 · 38 · 39

### Production serving
08 · 11 · 20 · 40 · 41 · 42 · 43

### How this codebase uses AI
13 · 14

## AI features table

```
  ┌────────────────────┬──────────────────┬─────────────────────────────────────┐
  │ Feature            │ Pattern used     │ Why this pattern                     │
  ├────────────────────┼──────────────────┼─────────────────────────────────────┤
  │ Day summarize      │ Single chain     │ One job: structured editor JSON +   │
  │                    │ Sonnet/4o        │ freeform summary text                │
  │ 4-variant caption  │ Single chain     │ One job: four tonal voices of a day │
  │                    │ Sonnet/4o        │ with anti-repetition (last 5 caps)  │
  │ Todo classify      │ Heuristic + LLM  │ Heuristic catches obvious; Haiku/   │
  │                    │ Haiku/4o-mini    │ mini handles the rest cheaply       │
  │ Todo expand        │ Per-type chain   │ Four typed schemas (idea /          │
  │                    │ Sonnet/4o        │ knowledge / study / reflect).       │
  │                    │                  │ TYPE selects chain. ('todo' is the  │
  │                    │                  │ non-expandable default.)            │
  │ Interpret          │ Single chain,    │ Long-form mirror reflection on a    │
  │                    │ markdown out     │ journal entry. User-triggered via   │
  │                    │ Sonnet/4o        │ modal. Output not persisted.        │
  └────────────────────┴──────────────────┴─────────────────────────────────────┘
```

## Models in use

- **Claude Sonnet 4.6** — summarize, caption, expand, interpret (default)
- **Claude Haiku 4.5** — classify (default)
- **GPT-4o** — summarize, caption, expand, interpret (alternate)
- **GPT-4o-mini** — classify (alternate)

User picks provider in `app/settings/ai.tsx`. Default is Claude.

## Thinking-mode taxonomy (2026-05-10)

The classifier picks one of **5** modes (was 7; reduced 2026-05-10 in migration `0008_todo_meta_type_reduce.sql`):

- `todo` — a plain action item the writer intends to do
- `idea` — a possibility, a "what if", an unproven direction
- `knowledge` — an observation or insight worth remembering
- `study` — an intention to learn a topic (added 2026-05-09)
- `reflect` — past-facing introspection, something to sit with (added 2026-05-10)

`bug`, `question`, `decision`, `content` were dropped — the engineering-flavored modes; existing rows with those values were remapped to `todo` and `user_overridden_type` cleared.

`ExpandableType = Exclude<TodoType, 'todo'>` so expand has 4 typed schemas: idea, knowledge, study, reflect.

## Curriculum scope vs current implementation

buffr's curriculum scope is **Phase 1 / 2A / 3 / 5**. Phase 2C (classical ML) is anchored to contrl-mo, not buffr — buffr has no trained-model surface and the `04-machine-learning/` section is intentionally absent. Phase 4 (agents) is recommended for contrl-mo (Path C); buffr's option (Path B) is deferred — `06-tool-calling.md` and `12-why-no-agents.md` carry the "why no agents in buffr" position.

**Current state across the 43 concept files:**
- **Case A (implemented)**: ~20 files — Phase 1's foundations and the chain-shape concepts buffr already ships.
- **Case B (not yet implemented)**: ~22 files — Phase 2A's RAG pipeline, Phase 3's eval suites, Phase 5's production hardening. Each is a `[Bx.y]` build target with a measurable Done-when condition.
- **learn-only**: a handful — concepts the curriculum tags as foundation-only (tokenization, streaming, no-click signal).

The `## Project exercises` block on every file names the curriculum's `[Bx.y]` Build items that exercise the concept — Case A files name extensions ("the next deepening"); Case B files name the primary buildable target ("the spec for building it").

→ See `system-design-templates/` for IK-style interview reframes (search ranking, tech support chatbot).

---

Updated: 2026-05-10 — added 14-interpret to index, added Interpret + reduced expand-types row to features table, added thinking-mode taxonomy section (template v1.12.0 maintenance + codebase changes).

---
Updated: 2026-05-11 — v1.25.0 pass: re-grouped index by sub-discipline (LLM foundations / Prompt engineering / Context and prompts / Retrieval and RAG / Agents and tool use / Evals and observability / Production serving / How this codebase uses AI); added 6 new concept files (15-sampling-parameters, 16-structured-outputs, 17-anatomy-of-prompt, 18-forbidden-patterns-rotation, 19-prompt-chaining, 20-prompt-injection); added "Sub-disciplines not represented in this codebase" section naming the deliberate omissions. `04-machine-learning/` section not created — buffr has no trained-model surface.

---
Updated: 2026-05-11 — v1.26.0 + v1.29.0 pass: switched Section 03 to curriculum-loaded mode (curriculum auto-installed from `~/.config/aipe/global/aieng-curriculum.md`). Added `## Project exercises` blocks to all 20 existing AI files mapping each to the curriculum's `[Bx.y]` Build items. Added 23 new files (21-43) covering Phase 1 remainder, Phase 2A in full, Phase 3, and Phase 5 — each Case B file names the primary buildable target. Replaced the v1.25.0 "Sub-disciplines not represented" section with "Curriculum scope vs current implementation." Added an index-by-curriculum-phase view alongside the existing sub-discipline grouping. Created `system-design-templates/` sub-directory (v1.29.0) with `01-search-ranking.md` and `02-tech-support-chatbot.md`. `04-machine-learning/` remains intentionally absent — buffr is LLM-only; Phase 2C is anchored to contrl-mo.
