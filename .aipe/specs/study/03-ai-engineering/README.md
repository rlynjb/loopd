# 03 — AI engineering

Every AI pattern in loopd, with the diagram first and the why-this-not-that named.

## Index

| # | Concept | One-line |
|---|---|---|
| 01 | [What an LLM actually is](./01-what-an-llm-is.md) | A function. Tokens in → tokens out. No memory, no I/O. |
| 02 | [Single-purpose chains](./02-single-purpose-chains.md) | Loopd's only pattern. Four chains, four jobs. |
| 03 | [Context window](./03-context-window.md) | Hand-picked, capped slices per feature. |
| 04 | [Provider abstraction](./04-provider-abstraction.md) | Read on every call, no shared interface. |
| 05 | [Heuristic before LLM](./05-heuristic-before-llm.md) | Cheap regex gate before the network call. |
| 06 | [Tool calling](./06-tool-calling.md) | Not used here; one-shot calls only. |
| 07 | [RAG](./07-rag.md) | Not used here; hand-picked retrieval is enough. |
| 08 | [Validation as a hard gate](./08-validation-gate.md) | Every model output is parsed + re-validated before persist. |
| 09 | [Async background classification](./09-async-classification.md) | Fire-and-forget; result lands later via DB write + event. |
| 10 | [user_overridden_type lock](./10-user-overridden-type-lock.md) | Manual user pick is permanent until reversed. |
| 11 | [Failure modes](./11-failure-modes.md) | Every AI failure leaves canonical data untouched. |
| 12 | [Why no agents](./12-why-no-agents.md) | Single chains only, by design. |
| 13 | [AI features in this app](./13-ai-features-in-this-app.md) | Per-feature prompt + input + output reference. |

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
  │ Todo expand        │ Per-type chain   │ Six typed schemas (idea / bug /     │
  │                    │ Sonnet/4o        │ question / decision / knowledge /   │
  │                    │                  │ content). The TYPE selects chain.   │
  └────────────────────┴──────────────────┴─────────────────────────────────────┘
```

## Models in use

- **Claude Sonnet 4.6** — summarize, caption, expand (default)
- **Claude Haiku 4.5** — classify (default)
- **GPT-4o** — summarize, caption, expand (alternate)
- **GPT-4o-mini** — classify (alternate)

User picks provider in `app/settings/ai.tsx`. Default is Claude.
