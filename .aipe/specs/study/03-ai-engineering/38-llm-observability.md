# LLM observability

**Industry name(s):** LLM observability, traces, spans, LLM tracing, Langfuse / LangSmith / Phoenix
**Type:** Industry standard

> Why "the call worked" is a useless answer at production scale — and what to log so you can answer real questions.

**See also:** → [23-token-economics](./23-token-economics.md) · → [11-failure-modes](./11-failure-modes.md) · → [35-eval-set-types](./35-eval-set-types.md)

---

## Why care

A user reports "the classifier got my todo wrong." You look at the entry text. You can't tell what prompt was sent, what the model returned, what the parsing did, or why the validator accepted it. You ship a fix. The user reports a similar bug a week later. You still can't reproduce.

LLM observability is the discipline of recording enough about each LLM call that you can reconstruct what happened weeks later. Token counts (see [23-token-economics](./23-token-economics.md)) are one slice; full traces with prompts, responses, latencies, model versions, and downstream parsing are the bigger picture. The pattern is the same shape as distributed-system tracing (OpenTelemetry, Jaeger) — every operation gets a trace ID, every sub-operation gets a span, and queries against the trace store answer "what happened" with evidence. Here's the version for LLM calls.

---

## How it works

Each LLM call is a multi-stage operation. Each stage has inputs, outputs, and timing. Observability captures all of them.

### The trace tree of an LLM call

```
A single classify() call's trace tree

trace_id: 7f3a...
├─ classify(todo_text)               [total: 1240ms]
│  ├─ heuristicClassify()            [span: 5ms]   → null (delegate)
│  ├─ buildPrompt()                  [span: 2ms]   → 450 tokens
│  ├─ provider_call (Haiku 4.5)      [span: 1180ms]
│  │  ├─ network request             [span: 30ms]
│  │  ├─ model inference             [span: 1100ms]
│  │  ├─ network response            [span: 50ms]
│  │  └─ tokens: in=450, out=12       
│  ├─ parseClassifyJson()            [span: 5ms]   → {type, conf}
│  └─ validator()                    [span: 1ms]   → passed
└─ write to todo_meta                [span: 35ms]
```

If you're coming from frontend, this is React DevTools' Profiler for LLM calls — a flame graph of where time went, plus the inputs and outputs at each layer.

### What to capture per span

- **timestamp** — when the span started.
- **duration_ms** — how long it took.
- **input** — the prompt (full text for debugging; redacted in shared storage).
- **output** — the response (same caveat).
- **model + version** — `claude-haiku-4-5`, never just `"Claude"`.
- **token counts** — input + output.
- **error / status** — success, validation_failed, network_error, etc.
- **trace_id + parent_span_id** — to reconstruct the tree.

The practical consequence: with a structured trace, "the classifier got this wrong" becomes a query — find trace where output.type='X' AND human-labelled-correct-type='Y' — and you can read the exact prompt, the exact response, the exact validator path.

### Where to store traces

Three options:

1. **Local SQLite table** — same shape as `ai_call_log` ([23-token-economics](./23-token-economics.md)), but with prompt + response payloads. Works at solo scale; doesn't scale to multi-user without per-user encryption.
2. **Managed service** — Langfuse (self-hosted or managed), LangSmith, Phoenix/Arize. OpenTelemetry-compatible. Vendor handles storage, search, and dashboards.
3. **Hybrid** — local for development, managed for production.

For loopd: at solo scale, local SQLite is sufficient — the `ai_trace` table from `[B3.11]`. The interface stays the same regardless of where traces eventually live.

### What traces unlock

Three categories of questions become answerable:

1. **Post-hoc debugging** — "show me the trace where classify said `study` for this entry."
2. **Regression detection** — "show me traces where output is `null` (provider returned blank)."
3. **Cost / latency investigation** — "show me p95 expand-chain latency by model and time-of-day."

Without traces, all three questions are guesses. With traces, they're SQL queries.

### Where it goes wrong

- **PII / secrets in prompts** — user prose ends up in the trace store; treat it like user data with appropriate retention and access controls.
- **Trace storage cost** — at high volume, full-prompt-and-response storage is expensive; sample or truncate after N days.
- **Async-call trace correlation** — fire-and-forget classify (see [09-async-classification](./09-async-classification.md)) needs trace propagation across the schedule boundary so the eventual call links back to the originating context.

### This is what people mean by "logs alone aren't enough"

Print statements get you the moment something goes wrong; traces get you the full timeline. The principle generalises across distributed systems and async pipelines — every event that crosses an interesting boundary gets a span. Here's the picture.

---

## LLM observability — diagram

```
The trace-tree shape

  ┌─ Trace store (target: ai_trace SQLite table) ──────┐
  │                                                      │
  │  trace_id   parent_span   span_id   name             │
  │  ──────────────────────────────────────────────────  │
  │  7f3a...    NULL          a1        classify         │
  │  7f3a...    a1            b1        heuristic        │
  │  7f3a...    a1            b2        buildPrompt      │
  │  7f3a...    a1            b3        provider_call    │
  │  7f3a...    b3            c1        network_request  │
  │  7f3a...    b3            c2        model_inference  │
  │  7f3a...    b3            c3        network_response │
  │  7f3a...    a1            b4        parseClassifyJson│
  │  7f3a...    a1            b5        validator        │
  └──────────────────────────────────────────────────────┘
            │
            ▼  query
  "show traces where output.type='X' on entry Y"
            │
            ▼
  Read prompt, response, parsing path; reproduce locally
```

```
Architectural layer view

┌─ Service layer ────────────────────────────────────────┐
│  Every chain wraps calls in startSpan() / endSpan()    │
│  Every chain reads/writes trace_id from a context obj  │
└────────────────────────────────────────────────────────┘
            │
            ▼  fire-and-forget write
┌─ Storage layer ────────────────────────────────────────┐
│  ai_trace (local SQLite)                               │
│   ├─ id, trace_id, parent_span_id, span_id            │
│   ├─ name, start_ts, duration_ms                       │
│   ├─ input_text, output_text                           │
│   ├─ model, provider                                   │
│   └─ tokens_in, tokens_out, error                      │
└────────────────────────────────────────────────────────┘
            │  (optional, later)
            ▼
┌─ Production observability tool (Langfuse) ─────────────┐
│  Self-hosted; OpenTelemetry-compatible                 │
└────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Status:** Case B — no LLM tracing today.

`[B3.11]` adds the local `ai_trace` table. `[B3.14]` evaluates Langfuse self-hosted; the decision is "stay local or migrate." `[B3.12]` is the ML-side analog (training-run logging for contrl-mo); the patterns share a discipline but live in different projects.

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, the trace wrapper lives in `src/services/ai/trace.ts`; the table lives in `src/services/database.ts` schema)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
LLM observability borrows directly from distributed-tracing primitives (OpenTelemetry, trace_id / span_id / parent_span_id). The LLM-specific additions are prompt + response capture, model + version tagging, and token counts. The toolchain (Langfuse, LangSmith, Phoenix) emerged around 2023-2024.

### The deeper principle
Async pipelines benefit disproportionately from structured tracing because their causal chain spans process boundaries. A scheduled-but-not-yet-executed classify call is invisible without trace propagation; with it, the trace links back to the entry-commit that scheduled it.

### Where this breaks down
Naive prompt-and-response capture stores PII verbatim. Production deployments need redaction or encryption-at-rest. For loopd at solo scale this is your own data, but at multi-user scale this becomes mandatory.

### What to explore next
- [23-token-economics](./23-token-economics.md) → the token-count subset of full observability
- [11-failure-modes](./11-failure-modes.md) → traces are what makes failure-mode analysis evidence-based
- Langfuse / LangSmith / Phoenix → the production toolchain

---

## Tradeoffs

### Comparison table — observability strategies

```
┌─────────────────────────┬────────────────────┬─────────────────────┬────────────────────┐
│ Cost dimension          │ Local ai_trace     │ Print logs only     │ Managed (Langfuse) │
├─────────────────────────┼────────────────────┼─────────────────────┼────────────────────┤
│ Reproducibility         │ High               │ Low (logs may rotate)│ High               │
│ Search / query          │ SQL                │ grep                 │ Web UI             │
│ Trace tree              │ Yes                │ No                   │ Yes                │
│ Cross-async correlation │ Yes (via trace_id) │ No                   │ Yes                │
│ Implementation effort   │ ~100-150 LOC       │ 0                    │ ~30 LOC + service  │
│ PII / data residency    │ Local              │ Logs                 │ Vendor or self-host│
│ Cost                    │ Storage only       │ Storage only         │ Vendor or infra    │
│ Scale ceiling           │ ~100k traces/day   │ Print-aware grep     │ Millions/day       │
└─────────────────────────┴────────────────────┴─────────────────────┴────────────────────┘
```

### Sub-block 1 — what local `ai_trace` gives up

A managed UI. Local SQLite is queryable via SQL but lacks the dashboards, flame-graph UI, and built-in analytics that Langfuse or LangSmith provide. For solo loopd this is fine — most queries are one-offs done at the SQL prompt. At multi-user scale the UI starts mattering.

### Sub-block 2 — what print-logs-only would cost

The inability to answer "show me all the traces where X happened" — you'd have to grep, and `console.log` output isn't structured or queryable. The first time you try to debug a class of failures across many calls, you reinvent observability.

### Sub-block 3 — the breakpoint
Local `ai_trace` stops being right when (a) trace volume exceeds ~100k/day (search becomes slow), (b) you need shared access (multi-developer team), or (c) you need cross-service correlation (microservices). For loopd, none of these apply.

### What wasn't actually a tradeoff
"Just rely on the model provider's logs" was never an option. Providers see only the model call; they don't see your parsing, your validator, your downstream writes. The full trace exists only in your application.

---

## Tech reference (industry pairing)

### Local SQLite (target — `ai_trace`)

- **Codebase uses:** target for `[B3.11]`.
- **Why it's here:** integrates with loopd's local-first architecture; no new service.
- **Leading today:** local SQL traces — `adoption-leading` for solo applications, 2026.
- **Why it leads:** zero new infra; queryable; uses existing storage layer.
- **Runner-up:** OpenTelemetry SDK with local backend — `innovation-leading` for codebases planning to grow into multi-service; standard format eases later migration.

### Langfuse (self-hosted)

- **Codebase uses:** target evaluation in `[B3.14]`.
- **Why it's here:** the leading open-source LLM observability platform.
- **Leading today:** Langfuse — `innovation-leading` for self-hosted LLM observability, 2026.
- **Why it leads:** open source, OpenTelemetry-compatible, native LLM-trace shape (not retrofitted from generic tracing).
- **Runner-up:** LangSmith — `adoption-leading` for managed observability; richer features; vendor lock-in.

---

## Project exercises

### [B3.11] Local `ai_trace` table for LLM tracing

- **Exercise ID:** `[B3.11]`
- **What to build:** A new local-only SQLite table `ai_trace` with columns: `id`, `trace_id`, `parent_span_id`, `span_id`, `name`, `start_ts`, `duration_ms`, `input_text`, `output_text`, `model`, `provider`, `tokens_in`, `tokens_out`, `error`. A wrapper `traceCall(name, parentSpanId, fn)` in `src/services/ai/trace.ts` that wraps any chain invocation and writes a span on completion.
- **Why it earns its place:** the foundation for post-hoc debugging and the eval-replay loop ("show me traces where the eval failed").
- **Files to touch:** new migration adding `ai_trace`; new `src/services/ai/trace.ts`; each chain wraps its operation.
- **Done when:** every chain call produces a trace tree; SQL queries against `ai_trace` reconstruct any call's flow.
- **Estimated effort:** `1–2 days`.

### [B3.14] Evaluate one observability tool

- **Exercise ID:** `[B3.14]`
- **What to build:** Self-host Langfuse for a week. Wire one chain (suggest: caption) to write spans to Langfuse via OpenTelemetry. Compare the dashboard UX vs the local SQL workflow. Decide: stay local or migrate.
- **Why it earns its place:** the discipline-level question is whether managed tooling beats local SQL for loopd's actual queries. The answer is empirical.
- **Files to touch:** new docker-compose for Langfuse; instrument caption chain.
- **Done when:** the comparison is documented; decision is recorded; if "stay local," Langfuse infra is dismantled.
- **Estimated effort:** `1–2 days`.

### [B3.15] Document one regression caught

- **Exercise ID:** `[B3.15]`
- **What to build:** A short writeup `loopd/.aipe/specs/eval/caught-regression.md` documenting one regression that traces helped catch — what changed, how trace inspection identified the cause, how it would have been invisible without traces.
- **Why it earns its place:** the interview-quality story. "I built observability" is a claim; "here's the regression it caught" is a receipt.
- **Files to touch:** new doc file.
- **Done when:** the writeup exists; the regression is named; the trace query that found it is shown.
- **Estimated effort:** `1–4hr` (after the first regression is caught — opportunistic).

---

## Summary

LLM observability records prompts, responses, latencies, models, and parsing outcomes for every call so you can reconstruct what happened later. In loopd this is not yet implemented; `[B3.11]` adds a local `ai_trace` table; `[B3.14]` evaluates Langfuse as a possible upgrade; `[B3.15]` documents the first regression caught. The constraint that makes local SQLite the right starting call is solo scale + loopd's local-first architecture — managed services aren't justified yet. The cost being paid is the lack of a managed UI; SQL queries fill the gap for now.

Key points to remember:
- Traces capture inputs, outputs, latency, and metadata per span.
- Trace tree shape lets you reconstruct the full call.
- Local SQLite works at solo scale; managed (Langfuse) wins at team scale.
- Async pipelines need trace propagation across the schedule boundary.
- "I built observability" is a claim; "here's the regression it caught" is the proof.

---

## Interview defense

### What an interviewer is really asking
"How do you debug an LLM-related production bug?" tests whether the candidate has observability or just logs.

### Likely questions

  [mid] Q: What gets logged per LLM call?
  A: For each call, a trace tree of spans: the outer chain span, sub-spans for prompt building, the provider call (with token counts), parsing, validation, and the downstream write. Each span has timestamp, duration, input, output, model + version, error status, and trace correlation IDs. Stored in a local SQLite `ai_trace` table at solo scale; would move to Langfuse or similar at team scale.
  Diagram:
  ```
  classify trace tree:
  classify ── heuristic     5ms → null
            ── buildPrompt  2ms → 450 tokens
            ── provider_call 1180ms
            ── parseJson    5ms → {type, conf}
            ── validator    1ms → passed
  ```

  [senior] Q: Why local SQLite instead of Langfuse from day 1?
  A: Three reasons. First, scale — at solo usage (~30 calls/day), the dashboard features of Langfuse are overkill; SQL queries handle every actual question. Second, infra — running Langfuse self-hosted adds a service to operate (Docker container, Postgres backend, port mapping); not justified for one developer. Third, the interface stays the same — local `ai_trace` follows OpenTelemetry-shape spans, so migrating to Langfuse later is a wire-up change, not a redesign. The `[B3.14]` exercise is explicitly to evaluate whether to migrate; absent evidence the local approach is failing, it stays.
  Diagram:
  ```
  Picked: local ai_trace                Suggested: Langfuse day 1
  ─────────────────────                 ─────────────────────────
  Zero infra                            Docker + Postgres
  SQL queries                           Web UI
  ~150 LOC                              ~30 LOC + service
  Right at solo scale                   Right at team scale
  ```

  [arch] Q: At 10× volume, what changes?
  A: Two shifts. First, full-prompt-and-response capture becomes storage-expensive — at 100k calls/day with ~1KB per trace, that's 100MB/day. Mitigation: keep full traces for 7 days, then truncate to metadata-only for older. Second, PII concerns appear — user prose in prompts means the trace store is now user data and needs proper access controls. The architectural shift is moving traces from "everyone reads" to "production-access-only with audit logging."
  Diagram:
  ```
  Today (solo)         →  ~30 calls/day, ~30KB/day
  10× users            →  ~3000 calls/day, ~3MB/day; truncate >30d
  100× users           →  ~30k/day; per-user access controls; managed tool
  ```

### The question candidates always dodge
"How do you propagate trace_id across a fire-and-forget async call like `scheduleClassify`?" The honest answer: pass `trace_id` (or generate one and pass) into the schedule call; the eventual async classify writes spans with that `parent_span_id`. Without explicit propagation, the async call is an orphan span and the original entry-commit context is lost.

```
Picked: explicit trace_id propagation     Suggested: implicit (impossible)
─────────────────────────────────         ─────────────────────────────
scheduleClassify(todo, trace_id)           scheduleClassify(todo)
Async span linked to original              Orphan async spans
Right for debuggability                    Right for nothing
```

### One-line anchors
- Traces capture more than token counts.
- Each call is a span tree, not a single event.
- Local SQLite at solo; Langfuse at team scale.
- Propagate trace_id across async boundaries.
- "Here's the regression it caught" beats "I built observability."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and redraw the classify trace tree. Label the spans and their durations.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) what a trace tree captures, (b) why local SQLite is fine at solo scale, (c) when Langfuse starts winning, (d) trace propagation across async calls.

### Level 3 — Apply it to a new scenario
A user reports that their interpret output started feeling generic last week. Without looking, propose a SQL query against `ai_trace` that would help diagnose whether the issue is prompt drift, model change, or context truncation.

Open the diagram and check whether your query joins the right span types.

### Level 4 — Defend the decision you'd change
Today the plan is local SQLite. If you were starting today, would you skip the local table and instrument straight to Langfuse? Defend your answer.

### Quick check — code reference test
- What table will hold the traces?
- What function wraps each chain call to emit a span?

Answer: `ai_trace` (target — `[B3.11]`). `traceCall(name, parentSpanId, fn)` in `src/services/ai/trace.ts` (target, not yet created).
