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

---

## Interview defense

### What an interviewer is really asking
On "what is an LLM" the question almost never tests definitions — it tests whether I treat the model as a function or as a coworker. The error mode they're hunting is the candidate who anthropomorphises: "it remembers", "it knows", "it decides". I want to land on the framing that loopd's whole architecture (validation gate, async classify, heuristic-first) only makes sense if you start from "tokens in, tokens out, no memory, no I/O".

### Likely questions

[mid] Q: If the LLM is stateless, how does loopd give it any "memory" at all — for example, anti-repetition across captions?
      A: It's not memory; it's context I assemble in app code. `caption.ts` calls `getRecentAISummaries(date, 5)` and pastes those into the prompt for each new caption. The model sees the last 5 captions as input tokens; it doesn't remember them. If I forgot to fetch and paste, the model would happily re-use the same opening line every day. The "memory" is a SQLite query plus a string concat.

[senior] Q: Why frame an LLM as a function instead of as an "AI assistant"? What does that buy you in this codebase?
         A: Framing it as a pure function makes every AI call independently retriable, independently testable, and independently debuggable. The same prompt fed to the same model with the same sampler gives the same distribution — that's how `validate.ts` and the one-retry pattern in `expand.ts` are even possible. If I treated it as an assistant with state, I couldn't reason about "what did the model see at call time" — and that's the question I always need to answer when something looks wrong.

[arch] Q: At what point does this "function" framing break down? When would you stop modeling LLM calls as pure transformations?
       A: The framing breaks the moment a feature genuinely needs multi-turn state — say, an interactive editor where the user replies to the model's draft. Then I'd need a conversation buffer, and the abstraction would shift from "function call" to "conversation step". I'd still keep each underlying API call stateless; I'd just acknowledge the buffer as app-side state. Loopd has zero of those features today, which is exactly why every chain in `src/services/ai/` is a single call.

### The question candidates always dodge
Q: If it's just a function, why does everyone — including you, sometimes — anthropomorphise it?

A: Because the output looks like reasoning. It isn't. An LLM is a probability distribution sampled token by token; what comes out reads like thought because the training corpus was thought-shaped. The error class I see most often in the wild is treating the LLM like a database (asking it to recall) or a planner (asking it to commit). In this codebase the validation gate exists exactly because I don't trust the model to be more than a token-predictor — I parse, I check the schema, I reject. The classify chain is the cleanest example: I send 50 tokens of input, get 50 tokens of output, and treat the result as "the model's guess at one of 7 labels", not "the model's understanding of my todo". Once you internalise that, every architectural choice in `src/services/ai/` becomes obvious.

### One-line anchors
- "Tokens in, tokens out. Everything else is in app code."
- "The validation gate exists because I don't trust the model to be more than a token-predictor."
- "Memory is a SQLite query and a string concat. It's not in the model."
- "The same prompt twice is the same problem twice — that's why I can debug it."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
