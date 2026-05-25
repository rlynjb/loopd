# Streaming responses

**Industry name(s):** Streaming, server-sent events (SSE), token streaming
**Type:** Industry standard

> Streaming returns tokens as the model produces them rather than buffering the full response. Perceived latency drops to first-token time; total time is unchanged. Tradeoff: harder to validate (can't check schema until stream ends), harder to handle mid-stream errors.

**See also:** → [04-structured-outputs](./04-structured-outputs.md) · → [06-token-economics](./06-token-economics.md) · → [`06-production-serving/04-rate-limiting-and-backpressure`](../06-production-serving/04-rate-limiting-and-backpressure.md)

---

## Why care

### Move 1 — The grounded scenario

You open the buffr editor for a day with a long entry. Tap "interpret" and... wait. The interpret chain takes 4 seconds before any text appears. The user sees a spinner. By second 3 they wonder if it broke; by second 4 they tap again, queuing a duplicate call. The model is doing the same work either way; the user just doesn't know it's happening. Streaming would show the first paragraph appearing at ~600ms, then continuing — same total time, but the user can read what's there while the rest finishes.

### Move 2 — Name the question the pattern answers

That do-I-buffer-or-stream question is what streaming answers. Not "what is SSE" (transport); just *when does the user benefit from seeing partial output, and what's the cost of giving it to them*. The answer: stream for any user-facing long-form output; buffer for anything code consumes.

### Move 3 — Why answering that question matters

**What breaks without streaming on user-facing chains:** perceived latency. A 4-second wait with a spinner feels broken; a 4-second wait that shows progressive output feels responsive. **What breaks with streaming on code-consuming chains:** schema validation needs the full output before it can run; mid-stream parse errors are harder to handle than post-call errors. In buffr today, no chain uses streaming — the 4 JSON chains can't stream meaningfully (schema needs the full object), and the one markdown chain (`interpret`) doesn't stream because the implementation effort hadn't paid off at current usage volumes.

### Move 4 — Concrete before/after

Without streaming on `interpret`:
- User taps "interpret"; 4-second blocking wait; full output appears
- 30% of users tap twice (perceived broken state)
- Engineering effort to ship: zero; implementation cost is the user's patience

With streaming on `interpret`:
- User taps "interpret"; ~600ms to first token; progressive markdown render
- 2% tap-twice rate (users see it's working)
- Engineering effort: SSE handler, partial-markdown renderer, error path for mid-stream failures, longer-lived HTTP connection

### Move 5 — The one-line summary

Stream long-form user-facing output for perceived-latency wins; buffer everything that gets parsed as code. The cost is mid-stream error handling, not throughput.

---

## How it works

### Move 1 — The mental model

```
   Non-streaming (buffr today):           Streaming (Case B for buffr):
   ┌────────────────┐                     ┌────────────────┐
   │ LLM produces   │                     │ "The"          │ ← chunk 1 @ ~500ms
   │ ...3 sec...    │                     │ " day"         │ ← chunk 2
   │ ...5 sec...    │                     │ " felt"        │ ← chunk 3
   │ ...8 sec...    │                     │ " ..."          │
   │                │                     │                │
   └─────┬──────────┘                     └─────┬──────────┘
         │                                      │
         ▼                                      ▼
   Full response arrives at once           Tokens stream live
```

Same total time. Different perceived latency.

### Move 2 — The layered walkthrough

**Layer 1 — what streaming does mechanically.** The HTTP response is a long-lived connection over Server-Sent Events (SSE) or chunked transfer encoding. The provider sends each token (or small batch of tokens) as it's generated. Your client appends each chunk to a buffer; the UI re-renders as new content arrives. The stream ends with a final event indicating "done" plus the usage stats.

```
   SSE stream shape (Anthropic):
   ──────────────────────────────
   event: message_start         {usage info baseline}
   event: content_block_start   {tools or text}
   event: content_block_delta   {delta: "The"}
   event: content_block_delta   {delta: " day"}
   event: content_block_delta   {delta: " felt"}
   ...
   event: content_block_stop
   event: message_delta         {final usage}
   event: message_stop
```

**Layer 2 — why streaming is hard for structured outputs.** Schema validation needs the complete JSON object. You can't validate `{"intent":"to` mid-stream — it's not yet valid JSON. For JSON-mode outputs, you have three options: (a) buffer the full stream then validate (loses the streaming benefit), (b) partial-parse with a tolerant parser like `json-stream-parser` (complex, edge cases), (c) skip streaming for JSON chains entirely (buffr's choice). Streaming-friendly outputs are markdown, plain text, or "deltas" where each chunk is independently meaningful.

```
   ┌─ Stream-friendly ──────────────────────────────────────┐
   │   plain text, markdown, raw prose                      │
   │   each token adds value to the user                    │
   └────────────────────────────────────────────────────────┘

   ┌─ Stream-unfriendly ────────────────────────────────────┐
   │   structured JSON (full schema needed before parse)    │
   │   classifiers (single label — nothing to stream)        │
   │   short outputs under ~50 tokens                       │
   └────────────────────────────────────────────────────────┘
```

**Layer 3 — error handling mid-stream.** Streaming connections drop. A 4-second stream that fails at 3.5 seconds leaves the user with partial output. You need: (a) a "retry from start" path because the model can't resume mid-stream, (b) a UI state for "stream incomplete," (c) a fallback to non-streaming if streaming fails twice. The complexity is real — for buffr's interpret chain, the non-streaming implementation is ~30 lines; a streaming version with proper error handling would be ~150.

```
   Streaming error paths
   ─────────────────────
   network drop mid-stream      →  retry from scratch
   provider rate limit          →  back off, retry
   schema-shaped output mid-    →  validation failure;
   way through (rare)              fall back to non-streaming
   user navigates away          →  abort the stream cleanly
```

### Move 3 — The principle

Stream when the user sees the output; buffer when code parses it. The perceived-latency win for user-facing output is large; the validation cost for code-facing output is also large. Match the streaming choice to the consumer.

The full picture is below.

---

## Streaming — diagram

```
┌─ Non-streaming (buffr today, all 5 chains) ────────────────────────────┐
│                                                                        │
│   chain.ts → provider.messages.create({ stream: false })               │
│         │                                                              │
│         │  ~4 second wait (interpret chain), spinner shown to user    │
│         ▼                                                              │
│   full response → validate.ts → orchestrator → UI                      │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

┌─ Streaming (Case B for buffr's interpret chain) ───────────────────────┐
│                                                                        │
│   chain.ts → provider.messages.create({ stream: true })                │
│         │                                                              │
│         ▼                                                              │
│   for-await chunk of stream:                                           │
│         │                                                              │
│         ├─ first chunk ~600ms  →  UI shows partial markdown            │
│         ├─ next chunk          →  UI appends + re-renders              │
│         ├─ ...                                                         │
│         └─ done event          →  total tokens for cost log            │
│                                                                        │
│   ┌─ Failure paths ──────────────────────────────────────────────┐    │
│   │   network drop      →  retry from start (no resume support)   │    │
│   │   user navigates    →  abort + clean up                       │    │
│   │   mid-stream error  →  surface; UI shows "regenerate" button  │    │
│   └───────────────────────────────────────────────────────────────┘    │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not currently stream any chain output.**

**Files:** `src/services/ai/summarize.ts`, `caption.ts`, `expand.ts`, `classify.ts`, `interpret.ts` — all call `messages.create({ stream: false })` or its OpenAI equivalent. The 4 JSON chains cannot stream meaningfully (schema needs full output); the markdown chain (`interpret`) does not stream.

The buildable next step is streaming for `interpret` only — it's the only chain where streaming would help users (markdown output, ~4 second total time, user-facing render). Spec: replace the `messages.create()` call in `src/services/ai/interpret.ts` with an SSE iterator; in the calling component (the editor's interpret action), accumulate the partial markdown and re-render on each chunk; handle the network-drop case by surfacing a "regenerate" button instead of silently failing. Estimated effort: 6-8 hours including error paths and UI work.

---

## Elaborate

### Where this pattern comes from

Server-Sent Events have been in browsers since 2009; their use for LLM streaming became canonical with OpenAI's 2022 SSE-based completion endpoint. ChatGPT's web UI made progressive token rendering the user expectation by ~2023.

### The deeper principle

When a user-facing operation takes longer than ~1 second, show progress. The progress can be a progress bar, a spinner with status, or — when possible — the actual output as it's produced. Streaming is the third option, and it's the only one that gives the user useful information during the wait.

### Where this breaks down

For very fast chains (under 1 second total), streaming overhead exceeds the perceived-latency benefit. For mobile clients (buffr's target), streaming requires a long-lived HTTP connection that can drop on backgrounding the app; the failure path is more complex than on a desktop browser. For chains whose output is consumed by code, streaming is straight loss.

### What to explore next

- [04-structured-outputs](./04-structured-outputs.md) — the reason 4 of buffr's 5 chains can't meaningfully stream
- [`06-production-serving/05-retry-and-circuit-breaker`](../06-production-serving/05-retry-and-circuit-breaker.md) — streaming amplifies the retry-and-recover challenge
- [`02-context-and-prompts/03-prompt-chaining`](../02-context-and-prompts/03-prompt-chaining.md) — chained chains can't stream the intermediate result, only the final one

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Streaming                 │ Non-streaming                │
├──────────────────┼───────────────────────────┼──────────────────────────────┤
│ Perceived        │ ~5x better for long       │ Baseline (spinner)            │
│ latency          │ outputs                   │                              │
│ Total time       │ Identical                 │ Identical                    │
│ Implementation   │ ~5x lines for full        │ Trivial                      │
│ complexity       │ error handling            │                              │
│ Schema           │ Buffered then parsed      │ Parsed once                  │
│ validation       │ (loses streaming gain)    │                              │
│ Mobile complexity│ Long-lived connections;    │ Single request               │
│                  │ backgrounding kills        │                              │
└──────────────────┴───────────────────────────┴──────────────────────────────┘
```

### The breakpoint

Stream when: (a) output is markdown or prose, (b) total time exceeds 1 second, (c) user is watching the output render. Skip streaming when: (a) output is structured JSON, (b) total time is under 1 second, (c) output is consumed by code or by a background job.

---

## Tech reference (industry pairing)

### Anthropic SDK streaming API

- **Codebase uses:** **Case B** — `messages.create({ stream: true })` returns an async iterable of SSE events. Not currently used.
- **Why it's here:** the provider-native primitive for streaming chat completions.
- **Leading today:** Anthropic's SSE format (`message_start` / `content_block_delta` / `message_stop`) is well-documented and stable.

### React Native fetch streaming

- **Codebase uses:** **Case B** — React Native's `fetch` supports `ReadableStream` via the `whatwg-streams` polyfill on Android. Not currently used.
- **Why it's here:** on the OpenAI raw-fetch path, manual SSE parsing would happen here.

---

## Project exercises

### B5-interpret-streaming — Add streaming to the `interpret` chain only

- **Exercise ID:** `B5-interpret-streaming`
- **What to build:** convert `src/services/ai/interpret.ts` to use SSE streaming; in the editor's interpret action handler, accumulate chunks into a `useState` markdown buffer; re-render on each chunk via a memoized markdown component. Handle the three failure paths: network drop, user navigation away, mid-stream error.
- **Why it earns its place:** the only buffr chain where streaming pays off (markdown output, ~4 sec time, user-facing render). All 4 JSON chains are excluded by schema validation needs.
- **Files to touch:** `src/services/ai/interpret.ts`, the editor's interpret action component, possibly a new abort hook.
- **Done when:** interpret action shows first markdown within ~600ms; cancellation works on screen leave; network failure surfaces a "regenerate" button.
- **Estimated effort:** 6-8 hours.

---

## Summary

### Part 1 — concept recap

Streaming returns tokens as the model produces them; total time is unchanged but perceived latency drops to first-token time. Suitable for user-facing markdown and prose; unsuitable for JSON-mode chains because schema validation needs the full output. Buffr does not currently stream any chain — the 4 JSON chains can't (schema), and the one markdown chain (`interpret`) hasn't been re-implemented. The build target is streaming for `interpret` only.

### Part 2 — key points to remember

- Streaming improves perceived latency, not throughput.
- JSON-mode outputs can't meaningfully stream (validation needs full output).
- Markdown and prose stream naturally.
- Mid-stream error handling is the implementation cost.
- Match streaming choice to the consumer: user → stream; code → buffer.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "do you stream your LLM responses," they're checking whether you've thought about perceived latency separately from throughput. Engineers who say "always" haven't thought about JSON validation; engineers who say "never" haven't thought about UX.

### Likely questions

**Q [mid]:** When does streaming help and when doesn't it?

**A:** Helps when the user sees the output and total time is over ~1 second — long-form text, markdown reflections, chat-style responses. Doesn't help when the output is structured JSON consumed by code (schema validation needs the full object), when total time is under 1 second (streaming overhead exceeds the gain), or when the output is short (no progressive value). For buffr, only the `interpret` chain fits the "helps" criteria; the other 4 are JSON-mode and stay non-streaming.

**Q [senior]:** What's hard about streaming on mobile?

**A:** Long-lived HTTP connections plus app backgrounding. On Android (buffr's target), the OS can kill background network requests; if the user taps "interpret" then locks the screen, the stream may abort without a clean error event. Solution: detect app state changes, abort the stream on background, surface a "regenerate" button on resume. Additionally, partial output must be discarded on abort — the half-rendered markdown isn't a useful state to leave on screen.

### One-line anchors

- Streaming improves perceived latency, not total time.
- JSON-mode outputs can't stream — schema needs the full object.
- Markdown and prose stream naturally; mid-stream errors are the cost.
- Buffr streams nothing today; `interpret` is the build target.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the streaming vs non-streaming flows side by side, with first-token-time labels.

### Level 2 — Explain it out loud

Explain in under 60 seconds why JSON chains can't meaningfully stream.

### Level 3 — Apply it to a new scenario

A new requirement: buffr should add a chat-style "ask your journal" feature. Would you stream? Sketch the I/O flow.

### Level 4 — Defend the decision you'd change

Defend or oppose: "Buffr should stream `summarize` even though it's JSON — partial parse with a tolerant parser to show progress." Why or why not?

### Quick check — code reference test

Without opening files:
- How many buffr chains stream today?
- Which chain would benefit most from streaming?
- What's the main implementation cost of streaming on mobile?
