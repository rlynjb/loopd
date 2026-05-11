# What an LLM actually is (in one diagram)

**Industry name(s):** Large language model (LLM), token-prediction model, autoregressive transformer
**Type:** Industry standard

> A function. Tokens in → tokens out. No memory, no I/O, no tools.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [06-tool-calling](./06-tool-calling.md)

---

## Why care

You've asked an AI chatbot a question, gotten a great answer, asked a follow-up, and watched it forget what it said two minutes ago — that's not a bug, that's the architecture. The thing you're talking to has no memory between requests, no senses, no clock, no ability to do anything on its own. Everything that looks like memory, reasoning, or "knowing you" was assembled by code on the outside and pasted into the prompt before the call.

The pattern here is the mental model itself: treat a language model as a pure function from one block of text to another. It belongs to the family of "stateless service" abstractions — the same shape as HTTP handlers, pure functions, and serverless workers, where every call stands alone and any persistence lives somewhere else. You've already seen this whenever you've worked with OpenAI's chat completions endpoint, with a LangChain LLM wrapper, or with any hosted Claude or GPT API: you send tokens, you get tokens, and the server forgot you the instant it replied. Here's how that actually works in this codebase.

---

## How it works

The model takes a sequence of tokens (the "prompt") and produces a probability distribution over the vocabulary. A sampler picks a token (greedy, top-k, top-p, temperature). That token is appended to the input; the loop runs again. The output stops when a stop token appears or the max-tokens budget is exhausted.

Crucially: nothing happens between calls. No state persists. No I/O is performed. No tools are invoked unless the surrounding code interprets the output as a tool call (see [06-tool-calling](./06-tool-calling.md)). The "model" is a pure function from token sequence to token sequence.

This framing keeps the AI surface debuggable: when something looks wrong, you can re-run a single call deterministically by re-sending the same prompt. The diagram below shows it end-to-end.

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

We traded "the model remembers" for "every relevant context travels in the prompt" — and got debuggability, retriability, and a system whose state we can actually inspect.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (pure function)     │ Alternative (stateful assistant)│
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Money            │ pay for every input token      │ pay for growing context every  │
│                  │ once per call; Haiku 4.5 ~     │ turn; conversation buffer      │
│                  │ $1/1M in, Sonnet 4.6 ~$3/1M    │ doubles cost by turn 5         │
│ Latency          │ predictable — single round-trip│ multi-turn loops add 500ms–2s  │
│                  │ (~800ms classify, ~3s caption) │ per turn; UX worsens linearly  │
│ Debugging        │ same prompt → same problem;    │ "what did the model see at    │
│                  │ replay locally with a curl     │ turn 4?" needs replay of full │
│                  │                                │ buffer history — usually lost │
│ Testability      │ unit-testable: stub one call,  │ requires fixture for full      │
│                  │ assert one parsed output       │ buffer + state machine         │
│ Cognitive load   │ one shape across 5 chains      │ each feature gets its own      │
│                  │ (prompt → call → parse → save) │ state shape — 5× the surface  │
│ Provider lock-in │ swap Anthropic↔OpenAI by       │ buffer formats differ between │
│                  │ swapping config; chains intact │ providers; migration is rewrite│
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

Every relevant context must be assembled in app code and pasted into the prompt — there is no "the model remembers last week." The anti-repetition memory for captions is literally `getRecentAISummaries(date, 5)` at `summarize.ts:buildCaptionInput()` L131, a SQLite query plus a string concat. Forget to fetch it, and the model happily reuses the same opening line every day. That cost is paid five times — once for each chain in `src/services/ai/`.

We also gave up cheap multi-turn reasoning. If a future feature genuinely needs the model to refine its own draft based on a user reply, we'd have to introduce a conversation buffer as app-side state — a new table, a new prompt-assembly path, a new replay mechanism for debugging. Today loopd has zero of those features, which is exactly why every chain is single-call.

### What the alternative would have cost

If we'd modeled chains as multi-turn assistants from day one, the up-front complexity would have looked similar (one library call), but per-chain state would have grown. Caption generation across days would have wanted "the assistant from yesterday's caption" — and yesterday's buffer would either be persisted (new schema, new sync, ~200 LOC for the buffer table alone) or rebuilt from prose every time (defeating the point). The cost compounds with chain count: at 5 chains, 5 state machines, 5 replay paths.

Worse, debugging would shift from "show me the prompt and the output" to "show me the buffer at turn N" — and buffers age out, get truncated, drift between providers. The "same prompt twice = same problem twice" property we use to fix bugs in `validate.ts` and the one-retry path in `expand.ts` would simply not exist.

### The breakpoint

The framing breaks the day we ship an interactive surface where the user replies to the model's draft and expects coherent multi-turn refinement — say, an "edit my caption" chat. At that point a conversation buffer becomes app-side state we cannot avoid. The breakpoint is feature-shaped, not cost-shaped: zero such features today, the function framing holds; one such feature tomorrow, we add a buffer to that one chain and leave the other four alone.

A secondary breakpoint is provider-feature drift. If Anthropic's prompt caching (90% discount on cached input tokens) becomes load-bearing at higher volumes (~10× current solo usage), we'd push more context into a cacheable system prompt — which is still the function shape, just a longer prompt. That's a tuning move, not an architecture change.

### What wasn't actually a tradeoff

Treating the model as a function did not cost us "AI quality" in any measurable way — the model is what it is regardless of how the surrounding code frames it. The framing is purely about our debugging surface, not the model's behavior.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk

- **Codebase uses:** `@anthropic-ai/sdk` (`client.messages.create`), `claude-sonnet-4-6` / `claude-haiku-4-5`.
- **Why it's here:** the SDK the codebase calls for every LLM chain — the function that takes tokens in and returns tokens out.
- **Leading today:** `@anthropic-ai/sdk` — `adoption-leading`, 2026.
- **Why it leads:** native SDK gives first-class access to prompt caching, JSON output, and tool calling that wrappers sometimes flatten or delay.
- **Runner-up:** Vercel AI SDK — `innovation-leading` multi-provider streaming with typed message structures and `useChat` hook.

---

## Summary

An LLM is a stateless function from a token sequence to a probability distribution over the next token, sampled repeatedly to produce text — every call stands alone, with no memory, no I/O, and no tools. In this codebase that framing drives every chain in `src/services/ai/` (`summarize`, `caption`, `classify`, `expand`, `interpret`): one prompt in, one string out, parse, validate, persist. The constraint that made this the right call here is debuggability — the same prompt fed to the same model with the same sampler reproduces the same problem, which is how `validate.ts` and the one-retry pattern in `expand.ts` are even possible. The cost is that "memory" — like the anti-repetition context for captions — has to be assembled by app code (a SQLite query in `summarize.ts:buildCaptionInput()` plus a string concat), not by the model.

Key points to remember:
- Tokens in, tokens out — no memory between calls, no I/O, no tools unless the surrounding code interprets the output as one.
- All five chains follow the same shape: build prompt, single call, parse output, persist or render.
- "Memory" like recent captions is a `getRecentAISummaries(date, 5)` call at `summarize.ts` L131, not a model property.
- Same prompt + same sampler = same distribution — that's what makes every call independently retriable and testable.
- The cost is that every relevant context must travel in the prompt; there is no "the model remembers last week".

---

## Interview defense

### What an interviewer is really asking
On "what is an LLM" the question almost never tests definitions — it tests whether I treat the model as a function or as a coworker. The error mode they're hunting is the candidate who anthropomorphises: "it remembers", "it knows", "it decides". I want to land on the framing that loopd's whole architecture (validation gate, async classify, heuristic-first) only makes sense if you start from "tokens in, tokens out, no memory, no I/O".

### Likely questions

[mid] Q: If the LLM is stateless, how does loopd give it any "memory" at all — for example, anti-repetition across captions?
      A: It's not memory; it's context I assemble in app code. `src/services/ai/summarize.ts:buildCaptionInput()` (L111) calls `getRecentAISummaries(date, 5)` at L131 and pastes those into the caption prompt input. The model sees the last 5 captions as input tokens; it doesn't remember them. If I forgot to fetch and paste, the model would happily re-use the same opening line every day. The "memory" is a SQLite query plus a string concat — assembled by `summarize.ts` before it hands the prompt input to `caption.ts:generateCaption()`. The chain emits `{ variants: { clean, smoother, reflective, punchy }, detectedTheme }`; summarize.ts:91–92 then persists those as `summary_json.variants` and `summary_json.variantsTheme` (the theme key is renamed on write).

```
[caption "memory" flow — assembled, not remembered]

  buildCaptionInput(date)
        │
        ▼  SQLite read
  getRecentAISummaries(date, 5)  ◀── L131, app-side state
        │
        ▼  string concat
  prompt = SYSTEM + recent + today
        │
        ▼  single call, stateless
  caption.ts:generateCaption(prompt)
        │
        ▼  parse + persist
  ai_summaries.summary_json.variants
```

[senior] Q: Why frame an LLM as a function instead of as an "AI assistant"? What does that buy you in this codebase?
         A: Framing it as a pure function makes every AI call independently retriable, independently testable, and independently debuggable. The same prompt fed to the same model with the same sampler gives the same distribution — that's how `validate.ts` and the one-retry pattern in `expand.ts` are even possible. If I treated it as an assistant with state, I couldn't reason about "what did the model see at call time" — and that's the question I always need to answer when something looks wrong.

```
                  Path taken (pure function)          Alternative (stateful assistant)
                  ───────────────────────────         ────────────────────────────────
state             zero — app-side context only        conversation buffer per chain
replay            same prompt → same output           need buffer + turn index to replay
testability       stub 1 call, assert 1 output        fixture for N-turn history
retry             one-shot, deterministic             retry destroys buffer coherence
provider swap     swap config; chains unchanged       buffer format differs per vendor
cost per call     paid once for input tokens          cost grows with turn count
```

[arch] Q: At what point does this "function" framing break down? When would you stop modeling LLM calls as pure transformations?
       A: The framing breaks the moment a feature genuinely needs multi-turn state — say, an interactive editor where the user replies to the model's draft. Then I'd need a conversation buffer, and the abstraction would shift from "function call" to "conversation step". I'd still keep each underlying API call stateless; I'd just acknowledge the buffer as app-side state. Loopd has zero of those features today, which is exactly why every chain in `src/services/ai/` is a single call.

```
At 10× current volume + 1 interactive chain:

  ┌─ UI layer ──────────────────────────────────┐
  │ existing 5 chains unchanged                 │
  │ new "edit my caption" chat surface          │  ◀── new feature
  └─────────────────────────────────────────────┘
              │
  ┌─ Chains (single-call) ──────────────────────┐
  │ 4 untouched (summarize/classify/expand/     │
  │ interpret) — function framing holds         │
  │ 1 new chain owns a conversation buffer      │  ◀── BREAKS FIRST
  └─────────────────────────────────────────────┘
              │
  ┌─ App-side state ────────────────────────────┐
  │ new chat_buffer table; provider-neutral     │
  │ shape (turns: [{role, content}])            │
  │ replay = re-send buffer to current provider │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: If it's just a function, why does everyone — including you, sometimes — anthropomorphise it?

A: Because the output looks like reasoning. It isn't. An LLM is a probability distribution sampled token by token; what comes out reads like thought because the training corpus was thought-shaped. The error class I see most often in the wild is treating the LLM like a database (asking it to recall) or a planner (asking it to commit). In this codebase the validation gate exists exactly because I don't trust the model to be more than a token-predictor — I parse, I check the schema, I reject. The classify chain is the cleanest example: I send 50 tokens of input, get 50 tokens of output, and treat the result as "the model's guess at one of 5 labels", not "the model's understanding of my todo". Once you internalise that, every architectural choice in `src/services/ai/` becomes obvious.

```
                  Path taken (token-predictor)        Suggested (AI-as-coworker)
                  ───────────────────────────         ──────────────────────────
trust model       no — parse, validate, reject        yes — "the model knows"
schema check      validate.ts on every output         hope the JSON parses
failure mode      loud (rejected by validator)        silent (bad data persists)
recall            done by SQLite query in app         "ask the model to remember"
classify output   "guess at 1 of 5 labels"            "the model's understanding"
debug surface     prompt + output; replayable         narrative — "it decided to"
$ per wrong call  cheap; one parse, one reject        compounding; bad data spreads
```

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
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram. Diagram layer-labels skipped (purely conceptual LLM I/O box, no architectural boundaries to cross).

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @anthropic-ai/sdk.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.
