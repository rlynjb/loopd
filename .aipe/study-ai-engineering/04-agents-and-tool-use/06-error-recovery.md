# Error recovery in agents

**Industry name(s):** Error recovery, agent failure handling, loop guards
**Type:** Industry standard

> Agents fail in more ways than chains. Without explicit recovery, a failing agent loops silently or burns tokens. Five failure modes: tool errors, tool timeouts, model loops, invalid tool calls, max-iteration overrun. Each needs an explicit recovery.

**See also:** → [01-agents-vs-chains](./01-agents-vs-chains.md) · → [02-tool-calling](./02-tool-calling.md) · → [`06-production-serving/05-retry-and-circuit-breaker`](../06-production-serving/05-retry-and-circuit-breaker.md)

---

## Why care

### Move 1 — The grounded scenario

Imagine buffr's classifier agent calls `retrieve_similar_todos` and SQLite errors out (locked DB, IO failure). What does the agent do? Without explicit recovery: the agent gets a tool error result, doesn't know how to handle it, may loop ("let me try again with the same tool") burning tokens. With explicit recovery: pass the error to the LLM as an observation; let it choose a different tool or terminate.

### Move 2 — Name the question the pattern answers

That what-when-it-breaks question is what error recovery answers. Not "should agents handle errors" (yes); just *what's the recovery for each failure mode and how do I implement it without infinite loops*.

### Move 3 — Why answering that question matters

**What breaks without explicit recovery:** agents silently spin (max iterations hit; tokens burned); agents return partial garbage (tool errored, agent didn't notice); agents loop on the same tool repeatedly.

### Move 4 — Concrete before/after

Without explicit recovery:
- Tool errors → agent retries same tool with same args → infinite loop until max-iter cap
- Agent burns $5 of tokens per call instead of $0.05

With explicit recovery:
- Each failure type has a specific handler
- Tool error → pass as observation; LLM picks different tool or terminates
- Max-iter cap → hard stop; return partial result + error

### Move 5 — The one-line summary

Five failure modes; each needs a recovery; the worst failure is the silent infinite loop.

---

## How it works

### Move 1 — The mental model

```
   Failure mode               Recovery
   ──────────────────────     ───────────────────────────
   Tool returns error         Pass error to LLM as observation;
                              LLM retries or picks different tool
   Tool times out             Cancel; pass timeout as observation
   LLM loops on same tool     Detect repeated tool calls (same name +
                              same args); force stop or inject "try
                              different approach" message
   LLM outputs invalid        Catch parse error; re-prompt with the
   tool call (bad schema)     specific error message
   Loop exceeds max iter      Hard stop; return partial result + error
```

### Move 2 — The layered walkthrough

**Layer 1 — pass errors as observations.** When a tool errors, send the error back as the tool's result (just text). The LLM treats it as data: "the tool returned 'database locked'." The LLM can then choose: retry, pick a different tool, or terminate.

**Layer 2 — loop detection.** Maintain a sliding window of recent tool calls. If the same `(tool_name, normalised_args)` repeats N times within the window, force stop. Without this, agents that confidently re-call the same tool burn tokens.

```
   Loop detection
   ──────────────
   recent_calls: deque, size 5
   if (current_call.tool, current_call.args) in recent_calls:
     count += 1
     if count >= 2: break with "loop detected"
```

**Layer 3 — max-iteration cap.** Always have a hard cap. 5-10 iterations for a simple agent, up to 20-30 for complex multi-tool agents. Past that, terminate with the best partial result you have.

### Move 3 — The principle

Every failure mode has an explicit recovery; the cap is hard; the worst outcome is the silent spin.

---

## Error recovery — diagram

```
┌─ Agent turn with recovery checks ──────────────────────────────────────┐
│                                                                        │
│   LLM emits tool call                                                  │
│         │                                                              │
│         ▼                                                              │
│   ┌──────────────────────────────┐                                     │
│   │ schema-validate tool call    │ → if invalid: re-prompt with error  │
│   └──────────────┬───────────────┘                                     │
│                  │                                                     │
│                  ▼                                                     │
│   ┌──────────────────────────────┐                                     │
│   │ check loop detection         │ → if repeat: force stop             │
│   └──────────────┬───────────────┘                                     │
│                  │                                                     │
│                  ▼                                                     │
│   ┌──────────────────────────────┐                                     │
│   │ check max-iter               │ → if exceeded: terminate            │
│   └──────────────┬───────────────┘                                     │
│                  │                                                     │
│                  ▼                                                     │
│   run tool with timeout                                                │
│         │                                                              │
│    ┌────┴────┐                                                         │
│    │  result │                                                         │
│    └────┬────┘                                                         │
│         │                                                              │
│    ┌────┴─────┬──────────┐                                             │
│    │          │          │                                             │
│    ▼ success  ▼ error    ▼ timeout                                     │
│   pass        pass       pass timeout                                  │
│   result      error      message                                       │
│   to LLM      to LLM     to LLM                                        │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not have agents; no recovery to implement today.**

Phase 4 `B4B.5` defines the recovery design for the classifier upgrade.

---

## Elaborate

### The deeper principle

Distributed systems fail in many ways; each failure needs a handler. Agents are distributed systems where one of the nodes is an LLM.

### Where this breaks down

For very simple single-tool agents, the recovery checks are over-engineered. For complex multi-tool agents, recovery handlers are mandatory.

### What to explore next

- [02-tool-calling](./02-tool-calling.md) — tools are where most errors come from
- [`06-production-serving/05-retry-and-circuit-breaker`](../06-production-serving/05-retry-and-circuit-breaker.md) — broader retry/circuit-breaker patterns

---

## Tradeoffs

The breakpoint: every agent needs at least max-iteration cap and tool-error pass-through. Loop detection and timeout handling are mandatory beyond single-tool agents.

---

## Tech reference

- **Max iterations:** typical 5-10 for simple, 20-30 for complex.
- **Loop detection:** deque of `(tool, args)` tuples.
- **Tool timeouts:** wrap with `Promise.race`.

---

## Project exercises

### B4B.5 — Classifier agent failure modes

- **What to build:** for the planned classifier agent, implement all five recoveries: tool error pass-through, tool timeout, loop detection on `retrieve_similar_todos`, invalid tool call re-prompt, max-iter cap at 5.
- **Done when:** unit tests demonstrate each recovery.
- **Estimated effort:** 3 hours.

---

## Summary

- Five failure modes; each needs a specific recovery.
- Worst outcome: silent infinite loop.
- Max-iter cap is always required.
- Buffr: Case B.

---

## Interview defense

**Q [mid]:** What's the worst agent failure mode?

**A:** Silent infinite loop. The agent confidently re-calls the same tool with the same args; the LLM doesn't notice the repetition; tokens burn until the max-iter cap (if you set one). Mitigation: explicit loop detection (deque of recent tool calls; if (tool, args) repeats, force stop) AND hard max-iter cap. Without these, a failing agent can run up real money before anyone notices.

### One-line anchors

- Five failure modes: error, timeout, loop, bad-schema, max-iter.
- Each needs a specific recovery.
- Worst is the silent loop.
- Max-iter cap is non-negotiable.

---

## Validate

### Quick check
- What are the five failure modes?
- How do you detect a loop?
- What's the max-iter cap for?
