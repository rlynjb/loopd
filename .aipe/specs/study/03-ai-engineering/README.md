# 03 — AI engineering

Every AI pattern in loopd, with the diagram first and the why-this-not-that named.

## Index

| # | Concept | Industry term | One-line |
|---|---|---|---|
| 01 | [What an LLM actually is](./01-what-an-llm-is.md) | *(pedagogical — no industry rename)* | A function. Tokens in → tokens out. No memory, no I/O. |
| 02 | [Single-purpose chains](./02-single-purpose-chains.md) | **Single-step chain / one-shot LLM call** *(industry standard — LangChain)* | Loopd's only pattern. Five chains, five jobs. |
| 03 | [Context window](./03-context-window.md) | **Context window** *(industry standard)* | Hand-picked, capped slices per feature. |
| 04 | [Provider abstraction](./04-provider-abstraction.md) | **Adapter / Strategy pattern** *(industry standard)* | Read on every call, no shared interface. |
| 05 | [Heuristic before LLM](./05-heuristic-before-llm.md) | **Pre-filter / cost-aware fast path** *(language agnostic)* | Cheap regex gate before the network call. |
| 06 | [Tool calling](./06-tool-calling.md) | **Tool use / function calling** *(industry standard)* | Not used here; one-shot calls only. |
| 07 | [RAG](./07-rag.md) | **Retrieval-Augmented Generation (RAG)** *(industry standard)* | Not used here; hand-picked retrieval is enough. |
| 08 | [Validation as a hard gate](./08-validation-gate.md) | **Output guardrails / schema-validated outputs** *(industry standard)* | Every model output is parsed + re-validated before persist. |
| 09 | [Async background classification](./09-async-classification.md) | **Fire-and-forget / async write-behind** *(industry standard)* | Fire-and-forget; result lands later via DB write + event. |
| 10 | [user_overridden_type lock](./10-user-overridden-type-lock.md) | **Sticky user override / manual override flag** *(language agnostic)* | Manual user pick is permanent until reversed. |
| 11 | [Failure modes](./11-failure-modes.md) | **Graceful degradation / failure mode analysis** *(industry standard)* | Every AI failure leaves canonical data untouched. |
| 12 | [Why no agents](./12-why-no-agents.md) | *(no industry rename — descriptive)* | Single chains only, by design. |
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

---
Updated: 2026-05-10 — added 14-interpret to index, added Interpret + reduced expand-types row to features table, added thinking-mode taxonomy section (template v1.12.0 maintenance + codebase changes).
