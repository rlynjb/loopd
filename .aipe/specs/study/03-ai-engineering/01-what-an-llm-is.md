# What an LLM actually is (in one diagram)

**Industry name:** Large language model (LLM), token-prediction model, autoregressive transformer
**Type:** Industry standard

> A function. Tokens in → tokens out. No memory, no I/O, no tools.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [06-tool-calling](./06-tool-calling.md)

---

## Quick summary
- **What:** an LLM is a stateless function from a token sequence to a probability distribution over the next token, sampled repeatedly to produce text.
- **Why this framing matters here:** loopd's five AI features are all framed as *one function call each*. No agent loops. Every call is independent.
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

Every AI service follows the same shape: build prompt → single call → parse output → persist (or render, for interpret). Reference files:

**Chains (5):**     `src/services/ai/summarize.ts:summarize()` L42–L105, `caption.ts:generateCaption()` L201–L223, `src/services/todos/classify.ts:classifyTodo()` L90+, `expand.ts:expandTodo()` L191+, `src/services/ai/interpret.ts:interpretEntry()` L114–L149
**Config:**         `src/services/ai/config.ts` → `getProvider()` L9–L12 + key getters L18–L40
**Prompt build:**   `src/services/ai/prompt.ts` → `SYSTEM` const L4–L27, `buildPrompt()` L29–L59
**Validators:**     `src/services/ai/validate.ts` → `validateSummary()` L12+ (caption/expand/interpret validators live in their own files)

No agent loop. No retry-with-tool-result. No multi-turn dialog state. Every call is a pure function from prompt to output (JSON for 4 chains, markdown for interpret).

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
      A: It's not memory; it's context I assemble in app code. `src/services/ai/summarize.ts:buildCaptionInput()` (L111) calls `getRecentAISummaries(date, 5)` at L131 and pastes those into the caption prompt input. The model sees the last 5 captions as input tokens; it doesn't remember them. If I forgot to fetch and paste, the model would happily re-use the same opening line every day. The "memory" is a SQLite query plus a string concat — assembled by `summarize.ts` before it hands the prompt input to `caption.ts:generateCaption()`. The chain emits `{ variants: { clean, smoother, reflective, punchy }, detectedTheme }`; summarize.ts:91–92 then persists those as `summary_json.variants` and `summary_json.variantsTheme` (the theme key is renamed on write).

[senior] Q: Why frame an LLM as a function instead of as an "AI assistant"? What does that buy you in this codebase?
         A: Framing it as a pure function makes every AI call independently retriable, independently testable, and independently debuggable. The same prompt fed to the same model with the same sampler gives the same distribution — that's how `validate.ts` and the one-retry pattern in `expand.ts` are even possible. If I treated it as an assistant with state, I couldn't reason about "what did the model see at call time" — and that's the question I always need to answer when something looks wrong.

[arch] Q: At what point does this "function" framing break down? When would you stop modeling LLM calls as pure transformations?
       A: The framing breaks the moment a feature genuinely needs multi-turn state — say, an interactive editor where the user replies to the model's draft. Then I'd need a conversation buffer, and the abstraction would shift from "function call" to "conversation step". I'd still keep each underlying API call stateless; I'd just acknowledge the buffer as app-side state. Loopd has zero of those features today, which is exactly why every chain in `src/services/ai/` is a single call.

### The question candidates always dodge
Q: If it's just a function, why does everyone — including you, sometimes — anthropomorphise it?

A: Because the output looks like reasoning. It isn't. An LLM is a probability distribution sampled token by token; what comes out reads like thought because the training corpus was thought-shaped. The error class I see most often in the wild is treating the LLM like a database (asking it to recall) or a planner (asking it to commit). In this codebase the validation gate exists exactly because I don't trust the model to be more than a token-predictor — I parse, I check the schema, I reject. The classify chain is the cleanest example: I send 50 tokens of input, get 50 tokens of output, and treat the result as "the model's guess at one of 5 labels", not "the model's understanding of my todo". Once you internalise that, every architectural choice in `src/services/ai/` becomes obvious.

### One-line anchors
- "Tokens in, tokens out. Everything else is in app code."
- "The validation gate exists because I don't trust the model to be more than a token-predictor."
- "Memory is a SQLite query and a string concat. It's not in the model."
- "The same prompt twice is the same problem twice — that's why I can debug it."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain "an LLM is a function" to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → any of `src/services/ai/{summarize,caption}.ts` or `src/services/todos/{classify,expand}.ts`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user reports that the `punchy` caption variant has been suspiciously similar across the last 3 days — same opening clause, same sentence rhythm. Where in the codebase does the "memory" that's *supposed* to prevent that live? What would happen if the function that fetches it returned `[]` due to a SQLite bug — would the caption call fail, or just produce repetitive output? Why does that distinction matter for "treat the model as a function"?

Write your answer. 3–5 sentences minimum. Then open `src/services/ai/summarize.ts:buildCaptionInput()` L111–L163 and trace `getRecentAISummaries(date, 5)` at L131 to verify — the recent-captions fetch lives in summarize.ts (the caption input assembler), not in caption.ts itself.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/ai/caption.ts` (the stateless single-call shape) to support what exists
→ Point to where conversation-buffer state would have to live (a new `chatBuffer` table + an editor screen + the `expand.ts` retry path) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — bumped chain count from 4 to 5 (Interpret added). See `14-interpret.md`.
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block; re-attributed `getRecentAISummaries(date, 5)` to `summarize.ts:buildCaptionInput()` L131 (was wrongly placed in `caption.ts:generateCaption()`); added 4-variant key list (clean/smoother/reflective/punchy) + `summary_json.variantsTheme` persistence note.
