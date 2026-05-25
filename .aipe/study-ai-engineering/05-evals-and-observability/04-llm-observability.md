# LLM observability

**Industry name(s):** LLM observability, tracing, spans, replay
**Type:** Industry standard

> Three pillars: traces (per-request: input, output, tokens, cost, model, prompt version), spans (sub-steps within), replay (re-run a saved trace with a different prompt or model). Tools: Langfuse, LangSmith, Phoenix, Helicone, or a local `ai_trace` table.

**See also:** → [`01-llm-foundations/06-token-economics`](../01-llm-foundations/06-token-economics.md) · → [01-eval-set-types](./01-eval-set-types.md) · → [`06-production-serving/06-production-observability`](../06-production-serving/06-production-observability.md)

---

## Why care

### Move 1 — The grounded scenario

User reports buffr's caption variants drifted in tone yesterday. You check — but you have no log of yesterday's calls. The provider dashboard shows total spend, not per-call traces. You can't reproduce the exact input that produced the bad output. The bug is lost.

### Move 2 — Name the question the pattern answers

That what-happened-on-call-X question is what observability answers. Not "how do I monitor my system" (broader); just *what's the per-call data I need to debug, reproduce, and iterate*.

### Move 3 — Why answering that question matters

**What breaks without observability:** every prompt iteration is blind. You can't replay yesterday's bad output to test today's fix. You can't tell which chain's quality drifted. Buffr today: no traces, no replay, no per-chain timing.

### Move 4 — Concrete before/after

Without observability:
- User reports bad output → "can you re-create?" → "I don't remember exactly what I typed"
- Bug irreproducible

With observability:
- User reports → look up the trace by user_id + timestamp → exact input + output + tokens + latency + model
- Replay through a new prompt → verify fix → ship

### Move 5 — The one-line summary

Three pillars: traces (per-call data), spans (sub-step timing), replay (re-run with changes). Tools optional; local `ai_call_log` is a minimum-viable shape.

---

## How it works

### Move 1 — The mental model

```
   ┌─ Traces ──────────────────────────────────────┐
   │  Per-request: input, output, latency, tokens, │
   │  cost, model, prompt version.                  │
   └────────────────────────────────────────────────┘

   ┌─ Spans ───────────────────────────────────────┐
   │  Sub-steps within a request: chain steps,      │
   │  tool calls, retrieval steps. Lets you find    │
   │  the slow link.                                │
   └────────────────────────────────────────────────┘

   ┌─ Replay ──────────────────────────────────────┐
   │  Re-run a saved trace with a different prompt │
   │  or model. Lets you verify a fix without      │
   │  shipping it.                                 │
   └────────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — traces.** One row per chain call. Schema includes: id, chain, provider, model, input (JSON), output (JSON or text), input_tokens, output_tokens, ms, error, prompt_version, created_at. Stored locally in `ai_trace` (curriculum `B3.11`) or via a hosted tool.

```
   buffr's planned ai_trace schema (B3.11)
   ────────────────────────────────────────
   id              integer primary key
   chain           text
   provider        text
   model           text
   prompt_version  text   (e.g. "summarize-v3")
   input           json
   output          json
   input_tokens    integer
   output_tokens   integer
   ms              integer
   error           text nullable
   created_at      text
```

**Layer 2 — spans.** Sub-step timing within a request. For a chain with retrieval: span 1 = retrieval (50ms), span 2 = LLM call (1800ms), span 3 = validation (10ms). Total = 1860ms. Spans tell you which step dominates. Useful for chains over ~500ms.

**Layer 3 — replay.** Pick a trace from `ai_trace`; modify the prompt or model; re-run with the same input. Compare outputs. Useful for verifying fixes before shipping a prompt change.

### Move 3 — The principle

Per-call data is the unit of debuggability. Without it, every bug report is detective work. With it, debugging is replay.

---

## LLM observability — diagram

```
┌─ Trace lifecycle ──────────────────────────────────────────────────────┐
│                                                                        │
│   chain call                                                           │
│         │                                                              │
│         ▼                                                              │
│   start span                                                           │
│         │                                                              │
│         ▼                                                              │
│   provider.messages.create(...)                                        │
│         │                                                              │
│         ▼                                                              │
│   end span; compute ms; record tokens                                  │
│         │                                                              │
│         ▼                                                              │
│   INSERT INTO ai_trace (chain, model, input, output, tokens, ms, ...) │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

┌─ Replay flow ──────────────────────────────────────────────────────────┐
│                                                                        │
│   pick trace by id                                                     │
│   build prompt from new prompt_version                                 │
│   run chain with same input                                            │
│   compare output side by side                                          │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr has no observability today.**

Phase 3 `B3.11` builds the local `ai_trace` table; `B3.14` evaluates one external tool (Langfuse self-hosted) for whether to migrate. For buffr's local-first architecture, local is the right shape; hosted tools are overkill for solo-dev usage.

---

## Elaborate

### Where this pattern comes from

Hosted LLM tracing tools (Langfuse, LangSmith, Phoenix/Arize, Helicone) emerged in 2023. The closest cross-domain analog is APM tools (Datadog, New Relic) for traditional services.

### The deeper principle

Per-call data is the unit of debugging for stateless systems. Logging the input/output/timing is non-negotiable past prototype phase.

### Where this breaks down

For ephemeral prototypes, full tracing is over-engineered. For very high-volume systems, hosted tools become expensive.

### What to explore next

- [`01-llm-foundations/06-token-economics`](../01-llm-foundations/06-token-economics.md) — the trace data drives cost queries
- [05-drift-detection](./05-drift-detection.md) — the trace data drives drift queries

---

## Tradeoffs

The breakpoint: local `ai_trace` is the minimum-viable; reach for hosted tools when team size or volume justifies.

---

## Tech reference

- **Langfuse:** open-source, self-hostable. Solid for solo + small team.
- **LangSmith:** LangChain's hosted offering; tight integration if you use LangChain.
- **Local `ai_trace` table:** the minimum-viable shape; sufficient for buffr.

---

## Project exercises

### B3.11 — Local `ai_trace` table

- **Exercise ID:** `B3.11`
- **What to build:** new SQLite migration adding `ai_trace`; wrap every chain call to write a row; build a small query helper for replay.
- **Done when:** every chain call is traced; replay is possible from a trace id.
- **Estimated effort:** 4 hours.

---

## Summary

- Three pillars: traces, spans, replay.
- Local `ai_trace` table is minimum-viable; hosted tools optional.
- Per-call data is the unit of debugging.

---

## Interview defense

**Q [mid]:** What's the minimum-viable observability for an LLM application?

**A:** A per-call log: input, output, tokens, latency, model, prompt version. Stored locally (SQLite table) or hosted (Langfuse et al). Enables three things: per-chain cost queries, per-bug-report replay, prompt-version A/B. Without this, every iteration is blind and every bug report is detective work.

### One-line anchors

- Three pillars: traces, spans, replay.
- Local table is minimum-viable.
- Per-call data is the unit of debugging.

---

## Validate

### Quick check
- What three pillars constitute LLM observability?
- What does buffr currently log?
- What's the replay use case?
