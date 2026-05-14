# Streaming responses

**Industry name(s):** Streaming, Server-Sent Events (SSE), token-by-token streaming, incremental response
**Type:** Industry standard

> Why your ChatGPT replies appear word-by-word — and why loopd deliberately doesn't.

**See also:** → [01-what-an-llm-is](./01-what-an-llm-is.md) · → [11-failure-modes](./11-failure-modes.md) · → [40-llm-caching](./40-llm-caching.md)

---

## Why care

A stenographer is sitting beside a witness in a courtroom, typing every word as it lands. The lawyers don't wait for the witness to finish a five-minute answer before they hear anything; they're reading the transcript scroll in real time on a side monitor. The witness still talks at the same speed; the lawyers just don't have to wait for a "done" to start listening. If the same testimony were delivered as a finished printed statement, every minute of speaking would be a minute of silence on the other side.

The implicit question is whether the consumer reads the output as it lands or only when it's complete. Not a faster model, not a smaller response — incremental delivery, so the perceived wait collapses even though the total bytes are unchanged.

**What depends on getting this right:** whether a 10-second wait on `interpret.ts`'s markdown essay feels like 10 seconds of nothing or 10 seconds of reading. In this codebase no chain streams today — every JSON chain (`summarize.ts`, `caption.ts`, `classify.ts`, `expand.ts`) runs a hard validator (`validate.ts:validateSummary` L12–L137, `caption.ts:parseAndValidate` L169–L199) that needs the complete object, and `interpret.ts` calls `cleanMarkdown` (L98–L108) on the whole response. If streaming were added, the natural first candidate is `interpret.ts` — the only chain whose output the user reads directly. The validators would have to either wait for stream-complete (giving up the UX win) or move to a streaming JSON parser (more complexity); the persistence layer would have to decide what to do with a partial output on a dropped connection.

Without streaming (loopd today):
- User opens interpret modal; sees a spinner for 10 seconds; gets the full essay at once
- All five chains share the same shape: call → wait → validate → render
- One code path; one retry semantics ("call failed → call again")

With streaming (the hypothetical for `interpret`):
- User opens interpret modal; first paragraph appears in 200ms; essay grows on screen
- Validator question: validate at stream-complete, or use partial-JSON parser?
- Three new failure modes: partial completion, mid-stream validation, retry-after-partial

A stenographer typing for an audience who reads in real time, not a printer waiting to finish the page.

---

## How it works

Streaming is HTTP done in slow motion. Instead of the server holding the connection open while it computes a single response, it holds the connection open and sends incremental chunks — one chunk per generated token (or every few tokens). The client receives these chunks as they arrive and renders them as soon as they're parsed.

### The wire shape — SSE chunks instead of one response body

If you're coming from frontend, you're used to `fetch()` returning a `Response` you `await response.json()` on. Streaming is different — the response body is a `ReadableStream` and you consume it chunk-by-chunk via `getReader().read()`. Each chunk is a `Server-Sent Events` line like:

```
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Today"}}

data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" I"}}
```

The practical consequence: the client gets `"Today"` ~200ms into the call and starts rendering it; the full response ("Today I worked on the Phase 2A spec") doesn't arrive for another 3 seconds, but the user has been reading the partial output the whole time. Perceived latency drops by ~80% even though total wall-clock is identical.

### Why streaming changes the validator pattern

In loopd, every JSON chain runs a hard validator after the call (`validateSummary`, `parseAndValidate`, `validateExpansion`). The validator requires the *complete* JSON object — you can't validate `{"headline": "Today` because the object isn't closed yet. Streaming a JSON chain means either (a) waiting for the stream to complete before validating (giving up the UX win) or (b) using a streaming JSON parser that emits partial trees (giving up the simplicity of "JSON is text").

For markdown output, the math is different — partial markdown is still useful to a human reader, even if a heading is incomplete or a code block is unclosed. This is why `interpret.ts` would be the natural first candidate for streaming: it's the only chain in loopd where the model's output is consumed directly by the user, not by the validator-then-database pipeline.

### Where the streaming UX falls apart

Three failure modes a non-streaming chain doesn't have to worry about:

1. **Partial completion** — the connection drops mid-stream and you have half an output. Do you persist the half? Show it to the user with a "...connection lost" indicator? Throw it away?
2. **Mid-stream validation** — you discover the model is going off the rails 5 seconds into a 10-second stream. Do you cancel? Let it finish and reject?
3. **Retry semantics** — non-streaming retries are clean ("call failed → call again"). Streaming retries are messy ("call partial → discard partial → call again → user saw both versions").

### This is what people mean by "streaming is a UX pattern, not a model pattern"

The model doesn't care if you stream — it generates the same tokens either way. Streaming is purely a question of when the client gets to see them. In loopd's current shape (JSON chains for derived state, validator-as-gate, persistence-as-truth) streaming offers little — the user doesn't see the model output, they see the rendered editor that was built from the parsed JSON. Where streaming *would* matter is the markdown surface (`interpret`), and only there. Here's the diagram.

---

## Streaming responses — diagram

```
Streaming vs non-streaming response

NON-STREAMING (loopd today)
  ┌─ Client ──────────────────────────────────────────────┐
  │  fetch() ─────►                                       │
  │                  (5-10s wait — opaque)                │
  │              ◄───── full response                     │
  │              parse, validate, render                  │
  └───────────────────────────────────────────────────────┘
  Time-to-first-byte: 5–10s
  Time-to-full-response: 5–10s

STREAMING (hypothetical loopd interpret)
  ┌─ Client ──────────────────────────────────────────────┐
  │  fetch() ─────►                                       │
  │              ◄── "Today"                              │
  │              ◄── " I"                                 │
  │              ◄── " worked"                            │
  │              (each chunk: ~50–200ms)                  │
  │              render incrementally                     │
  │              ◄── [end of stream]                      │
  └───────────────────────────────────────────────────────┘
  Time-to-first-byte: ~200ms  ← the UX win
  Time-to-full-response: 5–10s ← same as non-streaming
```

The full-response duration is unchanged. The first-byte time is the entire win.

---

## In this codebase

**Status:** `learn-only` — loopd has no streaming chain today.

All five chains in `src/services/ai/` await the full response before parsing or validating. The choice is deliberate: four chains return JSON (which can't be incrementally validated cleanly) and the fifth (`interpret`) returns markdown the user reads in a modal — and even there, the wait is borderline acceptable (~3–5s on Sonnet) because the modal is a deliberate "lean in and read" moment, not an inline chat.

**File:** *(no implementation — deferred)*
**Function / class:** *(if shipped, would land in `src/services/ai/interpret.ts` first)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
Streaming responses are inherited from chat-UX patterns popularised by ChatGPT (2022) and from the earlier SSE-over-HTTP pattern used by every "live event feed" web app since ~2010. The technical primitive (HTTP chunked transfer encoding) dates to HTTP/1.1 in 1997 — what changed is that LLM token generation finally gave a use case where slow-stream UX matters more than fast-complete UX.

### The deeper principle
Streaming is a perceived-latency optimisation that trades implementation simplicity for UX. The bytes are the same; the experience is different. The principle generalises: any operation where the result accumulates over time (search results, generated text, video transcoding) benefits from showing partial output if the user can use the partial output.

### Where this breaks down
Streaming breaks down when the consumer is a machine, not a human — when the next step is "parse JSON, write to DB, recompute derived state," streaming buys nothing because no consumer can use partial input. Most production LLM pipelines that don't have a human in the loop also don't stream.

### What to explore next
- [11-failure-modes](./11-failure-modes.md) → how streaming would add new failure surfaces to the existing failure-mode table
- [40-llm-caching](./40-llm-caching.md) → why streaming and caching interact awkwardly
- [14-interpret](./14-interpret.md) → the one chain in loopd where streaming would change the UX meaningfully

---

## Tradeoffs

### Comparison table — streaming vs non-streaming for the `interpret` chain

```
┌────────────────────────┬──────────────────────┬──────────────────────────┐
│ Cost dimension         │ Non-streaming (now)  │ Streaming (hypothetical) │
├────────────────────────┼──────────────────────┼──────────────────────────┤
│ Time-to-first-byte     │ 3–5s                 │ ~200ms                   │
│ Time-to-full-response  │ 3–5s                 │ 3–5s (unchanged)         │
│ Validator gate         │ Hard (whole-output)  │ Soft (post-stream)       │
│ Failure handling       │ Try/catch + retry    │ Partial-output state     │
│ Retry semantics        │ Clean                │ Messy (user saw partial) │
│ Implementation cost    │ ~10 lines            │ ~50–80 lines             │
│ Mobile UX (Android)    │ Modal wait spinner   │ Token-by-token render    │
└────────────────────────┴──────────────────────┴──────────────────────────┘
```

### Sub-block 1 — what non-streaming gives up

The user stares at a spinner for 3–5 seconds before any output appears. On a fast network this is bearable; on a degraded mobile network this is the dominant frustration vector. Past a 5-second wait, the user perceives the app as "broken" rather than "thinking."

### Sub-block 2 — what streaming would have cost

Adding streaming to `interpret.ts` is roughly 50–80 lines of changes: SSE parser, chunk-accumulator, mid-stream error handler, partial-output UI state. Plus the doubled set of failure modes in [11-failure-modes](./11-failure-modes.md): mid-stream cancel, partial-output persist-or-discard, retry-after-partial. That's the engineering side. The product side is harder: a user who saw half a reflection start to appear and then watched it vanish on retry is a worse experience than waiting longer for a complete one.

### Sub-block 3 — the breakpoint
Streaming becomes the right call for `interpret` when (a) average response time exceeds ~5s consistently (which would happen if interpret grows from per-entry to week-scope per `[B2A.7]`, or if multi-step reasoning chains are added) or (b) the interpret modal becomes a more central feature that users invoke many times per session rather than once.

### What wasn't actually a tradeoff
JSON chains were never a real streaming candidate. The validator gate is the load-bearing pattern; streaming JSON loses the gate's main value.

---

## Tech reference (industry pairing)

### Server-Sent Events (SSE)

- **Codebase uses:** not used today.
- **Why it's here:** the transport mechanism every LLM streaming API uses; one-way HTTP stream of `data: {...}\n\n` chunks.
- **Leading today:** SSE — `adoption-leading` for LLM streaming, 2026.
- **Why it leads:** lightweight (built on regular HTTP), proxy-friendly, native browser support via `EventSource`; chosen by Anthropic and OpenAI as their streaming wire format.
- **Runner-up:** WebSockets — `innovation-leading` for bidirectional needs (tool-use callbacks, agent loops). Adds connection-management complexity; pays off only when the client needs to send data mid-stream.

### Vercel AI SDK `useChat`

- **Codebase uses:** not used today.
- **Why it's here:** the framework-level abstraction over SSE — handles chunk parsing, state accumulation, and React/Vue/Svelte bindings.
- **Leading today:** Vercel AI SDK — `innovation-leading` for streaming UX, 2026.
- **Why it leads:** typed message structures, framework-aware, abstracts away the SSE parser. The fastest path from "no streaming" to "production streaming" for a TypeScript codebase.
- **Runner-up:** raw `fetch` + `ReadableStream` — `adoption-leading` for codebases that prefer no framework dependencies; pays off when streaming is one chain, not the app's primary mode.

---

## Project exercises

**Status:** `learn-only` (Phase 1 — `[C1.5]` is tagged `learn-only — loopd has no streaming`). The concept enters loopd only if interpret-at-week-scope (`[B2A.7]`) lands and the wait time crosses the 5-second perceptual threshold.

### Conditional — Stream `interpret` if response time becomes a problem

- **Exercise ID:** *deferred (gated on `[B2A.7]` shipping and a measured response-time regression)*
- **What to build:** Convert `interpretEntry()` (and `interpretWeek` once shipped) to consume Anthropic's streaming API (`stream: true`), accumulate chunks in component state, and render incrementally inside `InterpretModal`. Add a "stop generation" affordance.
- **Why it earns its place:** the curriculum says learn-only because loopd doesn't have streaming today and doesn't need it. If Phase 2A's week-scope interpret pushes response time to 10+ seconds, this exercise becomes load-bearing.
- **Files to touch:** `src/services/ai/interpret.ts` (switch to streaming call), `src/components/journal/InterpretModal.tsx` (incremental render + stop button).
- **Done when:** time-to-first-byte is ≤ 500ms; the stop button cancels the stream cleanly; an interrupted stream is not persisted or fed into the rotation history.
- **Estimated effort:** `1–2 days`.

---

## Summary

Streaming is the pattern where the API sends partial output token-by-token as the model generates, so the client renders incrementally instead of waiting for the full response. In loopd this is not implemented — all five chains await the full response, parse, validate, and either persist or render the complete output. The constraint that makes this the right call here is the validator-as-gate pattern: four chains return JSON that can't be validated until complete, and the fifth (`interpret`) has a borderline-acceptable wait at current scope. The cost being paid is the 3–5s modal wait on `interpret` and the visible spinner on every chain that takes longer than ~1s.

Key points to remember:
- Streaming is a UX optimisation, not a model optimisation — the same bytes arrive either way.
- Time-to-first-byte drops to ~200ms; time-to-full-response is unchanged.
- JSON chains can't easily stream because validation requires the complete output.
- Markdown chains (`interpret`) are the natural first streaming candidate in loopd.
- Streaming doubles the failure-mode surface: partial completion, mid-stream errors, messy retry semantics.

---

## Interview defense

### What an interviewer is really asking
"Why don't you stream?" is the surface question. The deeper question is whether the candidate knows that streaming is a *UX* pattern, not a model pattern — and whether they can defend not-streaming with the same rigor most candidates defend streaming with.

### Likely questions

  [mid] Q: Why don't loopd's chains stream like ChatGPT?
  A: Because the consumer of four of the five chains is the validator → database, not a human reader. Streaming buys nothing when the next step is "wait for complete JSON, parse, validate, persist." The fifth chain (`interpret`) returns markdown the user reads, and streaming would help there — but the current 3–5s wait is acceptable for a deliberate "lean in" modal interaction, and adding streaming doubles the failure-mode surface.
  Diagram:
  ```
  4 JSON chains:  model → JSON → [validate] → DB → UI rerender
                              ↑ streaming gains nothing here
  1 MD chain:     model → [direct render to user]
                              ↑ streaming would help; not yet load-bearing
  ```

  [senior] Q: What changes if you added streaming to interpret today?
  A: Three things, all real costs. First, ~50–80 lines of SSE handling: chunk parser, accumulator, mid-stream error handler. Second, doubled failure modes: partial-output persistence decisions, mid-stream cancel UX, messy retry semantics (the user already saw a partial result). Third, a worse retry experience: today a failed call gives you a clean "try again"; with streaming, the user saw half a reflection then watched it vanish on retry. The win is time-to-first-byte from 3s to ~200ms.
  Diagram:
  ```
  Picked: non-stream         Suggested: stream
  ───────────────────         ───────────────────
  ~10 lines                   ~50–80 lines
  1 failure mode              3 failure modes
  Clean retry                 Messy retry
  TTFB: 3–5s                  TTFB: ~200ms (win)
  ```

  [arch] Q: At what scale does streaming become unavoidable?
  A: Two thresholds. First, when `interpret` grows from per-entry to multi-entry scope (e.g., `[B2A.7]` week-scope) the response time rises past 5s and the modal-wait UX breaks. Second, when interpret becomes a frequently-used surface (current usage is ~once per session at most), the cumulative wait time per session becomes a meaningful product-quality signal. The architectural change is migrating `interpret.ts` to a streaming consumer; the rest of the codebase is unaffected.
  Diagram:
  ```
  ┌─ UI layer ────────────────┐
  │ InterpretModal            │  ← needs streaming render
  └───────────────────────────┘
            │
  ┌─ Service layer ───────────┐
  │ interpret.ts              │  ← needs SSE consumer
  │ (other 4 chains)          │  ← unchanged
  └───────────────────────────┘
            │
  ┌─ Provider layer ──────────┐
  │ Anthropic/OpenAI SDK      │  ← already supports streaming
  └───────────────────────────┘
            ↑ This is the layer that "breaks first" if we wait
  ```

### The question candidates always dodge
"Why is it so hard to stream a JSON chain?" Most candidates handwave "it's just complicated." The real answer: structured outputs (per [16-structured-outputs](./16-structured-outputs.md)) are validated as complete objects. A partial JSON `{"headline": "Today` has no way to be validated against the schema, and a streaming JSON parser that emits partial trees is a lot of new code for marginal UX gain (the user can't read structured editor JSON anyway).

```
Picked: wait-then-validate     Suggested: stream JSON
──────────────────────────     ───────────────────────
Whole-output schema check      Partial-tree parser (new dep)
Clean reject path              Partial-output rollback state
~10 LOC                        ~150+ LOC + tested parser
User waits 3s                  User sees JSON braces appear?
```

### One-line anchors
- Streaming is a UX pattern. The bytes don't change.
- The consumer matters: human → stream; validator → don't.
- Markdown streams cleanly. JSON does not.
- Every streaming chain has at least 3 more failure modes than its non-streaming twin.
- "We don't stream" is a defensible architectural choice, not a missing feature.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and draw the streaming-vs-non-streaming time diagram from memory. Label both axes: time-to-first-byte and time-to-full-response. Show why they differ for one and don't for the other.

### Level 2 — Explain it out loud
In under 90 seconds, explain (a) what streaming is at the wire level (SSE chunks), (b) why it's a UX-only optimisation, (c) why loopd doesn't stream, (d) the one chain that would benefit.

### Level 3 — Apply it to a new scenario
loopd ships `[B2A.7]` interpret-this-week. Average response time on Sonnet 4.6 is 8 seconds. The user opens the week modal and stares at a spinner. Should you add streaming? If yes, in what order should you add it (UI changes, service changes, failure-mode updates)? Write the answer in 3–5 sentences.

Then open [11-failure-modes](./11-failure-modes.md) and check whether your answer accounts for every new failure surface streaming introduces.

### Level 4 — Defend the decision you'd change
Today, four chains do not stream because their output is JSON consumed by validators. If you were starting fresh, would you (a) keep the same validator gate and keep them non-streaming, or (b) adopt a streaming JSON parser and validate progressively? Defend your answer naming one specific failure mode each option creates that the other avoids.

### Quick check — code reference test
- Which file would streaming land in first?
- Why is `validate.ts` an obstacle to streaming the structured chains?

Answer: `src/services/ai/interpret.ts` (markdown output, no validator gate). `validate.ts` requires whole-output JSON; streaming would force a partial-tree parser to coexist with the existing whole-object validator.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (courtroom-stenographer scenario, name the incremental-vs-complete question, interpret.ts streaming candidate stakes, before/after, single-line metaphor).
