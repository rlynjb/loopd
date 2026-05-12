# 03 — AI engineering

Every AI pattern in loopd, organized by sub-discipline. Each file opens with a diagram and ends with an Elaborate block.

## Index by sub-discipline

### LLM foundations

| # | Concept | Industry term | One-line |
|---|---|---|---|
| 01 | [What an LLM actually is](./01-what-an-llm-is.md) | *(pedagogical — no industry rename)* | A function. Tokens in → tokens out. No memory, no I/O. |
| 15 | [Sampling parameters](./15-sampling-parameters.md) | **Temperature, top-p (nucleus sampling), top-k** *(industry standard)* | Only `interpret` tunes temperature (=0.7); every other chain runs on the provider default. |
| 16 | [Structured outputs](./16-structured-outputs.md) | **Structured outputs, JSON mode, schema-validated outputs** *(industry standard)* | Every JSON chain returns text → regex → JSON.parse → typed-contract validator. |
| 05 | [Heuristic before LLM](./05-heuristic-before-llm.md) | **Pre-filter / cost-aware fast path** *(language agnostic)* | Cheap regex gate before the network call. |
| 04 | [Provider abstraction](./04-provider-abstraction.md) | **Adapter / Strategy pattern** *(industry standard)* | Read on every call, no shared interface. |
| 10 | [user_overridden_type lock](./10-user-overridden-type-lock.md) | **Sticky user override / manual override flag** *(language agnostic)* | Manual user pick is permanent until reversed. |

### Prompt engineering

| # | Concept | Industry term | One-line |
|---|---|---|---|
| 17 | [Anatomy of a production prompt](./17-anatomy-of-prompt.md) | **Four-section prompt structure (role/task/constraints/output)** *(industry standard)* | All 5 chains use the same four-section shape; user message carries payload only. |
| 02 | [Single-purpose chains](./02-single-purpose-chains.md) | **Single-step chain / one-shot LLM call** *(industry standard — LangChain)* | Loopd's only pattern. Five chains, five jobs. |
| 18 | [Forbidden patterns and rotating formulas](./18-forbidden-patterns-rotation.md) | **Anti-repetition, rotation prompting** *(industry standard)* | Static UNIVERSAL RULES + dynamic last-5-captions block in the user message. |

### Context and prompts

| # | Concept | Industry term | One-line |
|---|---|---|---|
| 03 | [Context window](./03-context-window.md) | **Context window** *(industry standard)* | Hand-picked, capped slices per feature. |
| 19 | [Prompt chaining](./19-prompt-chaining.md) | **Prompt chaining, multi-step LLM pipeline** *(industry standard)* | summarize → caption two-stage chain; mood flows from stage 1 to stage 2. |

### Retrieval and RAG

| # | Concept | Industry term | One-line |
|---|---|---|---|
| 07 | [RAG](./07-rag.md) | **Retrieval-Augmented Generation (RAG)** *(industry standard)* | Not used here; hand-picked retrieval is enough. |

### Agents and tool use

| # | Concept | Industry term | One-line |
|---|---|---|---|
| 06 | [Tool calling](./06-tool-calling.md) | **Tool use / function calling** *(industry standard)* | Not used here; one-shot calls only. |
| 12 | [Why no agents](./12-why-no-agents.md) | *(no industry rename — descriptive)* | Single chains only, by design. |

### Evals and observability

| # | Concept | Industry term | One-line |
|---|---|---|---|
| 09 | [Async background classification](./09-async-classification.md) | **Fire-and-forget / async write-behind** *(industry standard)* | Fire-and-forget; result lands later via DB write + event. |
| 11 | [Failure modes](./11-failure-modes.md) | **Graceful degradation / failure mode analysis** *(industry standard)* | Every AI failure leaves canonical data untouched. |

### Production serving

| # | Concept | Industry term | One-line |
|---|---|---|---|
| 08 | [Validation as a hard gate](./08-validation-gate.md) | **Output guardrails / schema-validated outputs** *(industry standard)* | Every model output is parsed + re-validated before persist. |
| 20 | [Prompt injection](./20-prompt-injection.md) | **Prompt injection, indirect prompt injection** *(industry standard)* | User prose feeds every chain; output validation is the real defense, not input filtering. |

### How this codebase uses AI

| # | Concept | Industry term | One-line |
|---|---|---|---|
| 13 | [AI features in this app](./13-ai-features-in-this-app.md) | *(no industry rename — codebase-specific)* | Per-feature prompt + input + output reference. |
| 14 | [Interpret — long-form markdown chain](./14-interpret.md) | *(no industry rename — feature-specific)* | 5th chain. User-triggered, markdown out, no JSON, no persistence. |

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

## Sub-disciplines not represented in this codebase

The v1.25.0 AI catalog covers ~34 patterns across 8 sub-disciplines. loopd uses 20; the others were deliberately omitted because the codebase doesn't have the surface area:

- **Tokenization, streaming, token economics** — no token-level instrumentation; no chat UI; single-user spend is invisible.
- **All retrieval / RAG sub-patterns** (embeddings, embedding model choice, chunking strategies, vector databases, dense vs sparse retrieval, hybrid retrieval with RRF, reranking with cross-encoder, query rewriting / HyDE, stale embeddings, incremental indexing, GraphRAG) — no embeddings, no vector storage; the codebase relies on prose as canonical and hand-picked retrieval. See [07-rag.md](./07-rag.md) for why this is the right call here.
- **ReAct, tool routing, agent memory, error recovery in agents** — no agents; see [12-why-no-agents.md](./12-why-no-agents.md).
- **Eval set types, eval methods, LLM-as-judge bias, LLM observability** — no eval set; manual UAT on the device after each meaningful change.
- **LLM caching, cost optimization, rate limiting and backpressure, retry and circuit breaker** — covered partially by [05-heuristic-before-llm.md](./05-heuristic-before-llm.md) (cost) and [11-failure-modes.md](./11-failure-modes.md) (failure handling); the standalone patterns aren't load-bearing at single-user scale.
- **Lost-in-the-middle, few-shot prompting, chain-of-thought, output mode mismatch** — either implied by other patterns (output-mode-mismatch is folded into [08-validation-gate.md](./08-validation-gate.md)) or not used (no few-shot, no CoT).

---

Updated: 2026-05-10 — added 14-interpret to index, added Interpret + reduced expand-types row to features table, added thinking-mode taxonomy section (template v1.12.0 maintenance + codebase changes).

---
Updated: 2026-05-11 — v1.25.0 pass: re-grouped index by sub-discipline (LLM foundations / Prompt engineering / Context and prompts / Retrieval and RAG / Agents and tool use / Evals and observability / Production serving / How this codebase uses AI); added 6 new concept files (15-sampling-parameters, 16-structured-outputs, 17-anatomy-of-prompt, 18-forbidden-patterns-rotation, 19-prompt-chaining, 20-prompt-injection); added "Sub-disciplines not represented in this codebase" section naming the deliberate omissions. `04-machine-learning/` section not created — loopd has no trained-model surface.
