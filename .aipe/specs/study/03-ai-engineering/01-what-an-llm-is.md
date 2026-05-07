# What an LLM actually is (in one diagram)

> A function. Tokens in → tokens out. No memory, no I/O, no tools.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [06-tool-calling](./06-tool-calling.md)

---

## Quick summary
- **What:** an LLM is a stateless function from a token sequence to a probability distribution over the next token, sampled repeatedly to produce text.
- **Why this framing matters here:** loopd's four AI features are all framed as *one function call each*. No agent loops. Every call is independent.
- **Tradeoff:** the framing forbids stateful "the model remembers what we discussed last week" — every relevant context must travel in the prompt.

---

## What an LLM is — diagram

```
   Input (tokens)              Output (tokens)
        │                            ▲
        │                            │
        ▼                            │
  ┌─────────────────────────────────────┐
  │              LLM                     │
  │     predicts next token              │
  │     (no memory, no I/O, no tools)    │
  └─────────────────────────────────────┘
```

---

## How it works

The model takes a sequence of tokens (the "prompt") and produces a probability distribution over the vocabulary. A sampler picks a token (greedy, top-k, top-p, temperature). That token is appended to the input; the loop runs again. The output stops when a stop token appears or the max-tokens budget is exhausted.

Crucially: nothing happens between calls. No state persists. No I/O is performed. No tools are invoked unless the surrounding code interprets the output as a tool call (see [06-tool-calling](./06-tool-calling.md)). The "model" is a pure function from token sequence to token sequence.

This framing keeps the AI surface debuggable: when something looks wrong, you can re-run a single call deterministically by re-sending the same prompt.

---

## In this codebase

Every AI service in `src/services/ai/` follows the same shape: build prompt → single call → parse output → persist. Files:
- `summarize.ts`, `caption.ts`, `classify.ts`, `expand.ts` — the four chains.
- `config.ts` — provider + key reading.
- `prompt.ts` — shared prompt-building helpers.
- `validate.ts` — schema validation post-call.

There's no agent loop. No retry-with-tool-result. No multi-turn dialog state.

---

## Elaborate

### Where this pattern comes from
Auto-regressive language models trace back to n-gram models from the 80s, recurrent neural networks from the 90s, and transformer-based LLMs from 2017 onward. The "function from tokens to tokens" framing is what makes serving these models tractable — every request is independent.

### The deeper principle
**Statelessness is a feature.** Stateless services are horizontally scalable, easy to retry, and easy to reason about. The moment you give a model "memory" you're really just appending to its prompt under the hood — making the appending explicit makes the system honest.

### Where this breaks down
- Workflows that genuinely need long-running state (a multi-day plan that the model "remembers"). Solution is RAG or persistent context — *not* model state.
- Tasks that need real-time tool use (search, code exec). The model can't do those itself; you wrap it in a loop that interprets tool calls (see [06-tool-calling](./06-tool-calling.md)).

### What to explore next
- [02-single-purpose-chains](./02-single-purpose-chains.md) → loopd's only pattern.
- [06-tool-calling](./06-tool-calling.md) → the loop loopd doesn't use.
- [07-rag](./07-rag.md) → "memory" via retrieval.

---

## Tradeoffs

- **Treat as pure function** — gives: trivially debuggable, retriable, testable. Costs: every relevant context must be in the prompt.
- **No agent loop** — gives: predictable cost. Costs: no autonomous multi-step reasoning.
- **Stateless** — gives: scales with HTTP. Costs: "remember last conversation" must be implemented in app code, not the model.
