# Tool routing

**Industry name(s):** Tool routing, tool dispatch, intent routing
**Type:** Industry standard

> Heuristic routing for predictable input patterns (fast path), LLM routing for everything else (fallback). Heuristic on the front; LLM at the back. Same shape as heuristic-before-LLM (`01-llm-foundations/07`) applied to tool selection.

**See also:** → [02-tool-calling](./02-tool-calling.md) · → [`01-llm-foundations/07-heuristic-before-llm`](../01-llm-foundations/07-heuristic-before-llm.md) · → [01-agents-vs-chains](./01-agents-vs-chains.md)

---

## Why care

### Move 1 — The grounded scenario

Imagine a buffr command bar where the user types: "delete entry 42" → use `delete_entry` tool. "search for auth" → use `search_entries` tool. "summarize this week" → use `summarize_week` tool. The first two have obvious rule-based dispatch (verbs map to tools). The third is ambiguous — "summarize" could mean today, this week, or just this entry. Rule for the first two; LLM for the third.

### Move 2 — Name the question the pattern answers

That who-picks-the-tool question is what tool routing answers. Not "should the LLM always pick" (no — expensive); just *for any tool-using interface, what fraction of inputs is deterministically routable and what needs LLM judgment*.

### Move 3 — Why answering that question matters

**What breaks without routing:** every input goes through the LLM (cost, latency) even when rules would resolve it; or every input is rule-routed and ambiguous inputs return wrong tools.

### Move 4 — Concrete before/after

LLM-routed everything:
- Every input → LLM call to pick tool → tool execution
- Cost: every input pays the routing tax
- Slow: every input is at least 1 LLM call

Hybrid (heuristic first):
- 70% of inputs match rule patterns → direct tool dispatch (sub-ms)
- 30% fall through to LLM router (slower, smarter)
- Cost: 30% of inputs pay the routing tax

### Move 5 — The one-line summary

Heuristic routing for predictable input patterns; LLM routing for the ambiguous remainder; same fast-path / slow-path pattern as heuristic-before-LLM.

---

## How it works

### Move 1 — The mental model

```
   Input
     │
     ▼
   ┌──────────────────────────────────────┐
   │ Heuristic check (regex / prefix)     │  fast, free
   │  "search ..." → search tool          │
   │  "delete N" → delete tool             │
   │  ...                                  │
   └──────────────────┬───────────────────┘
                      │
                 ┌────┴────┐
                 │ match?  │
                 └────┬────┘
                      │
                 ┌────┴─────┐
                 │          │
                 ▼ yes      ▼ no
              dispatch    ┌──────────────────────────────────┐
              directly    │ LLM router with tool definitions │  slower
                          └──────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — heuristic routes.** Regex/prefix patterns mapping to tools. First match wins. Returns the tool name + parsed arguments. Sub-millisecond.

**Layer 2 — LLM routing.** When no heuristic matches, send the input + tool definitions to an LLM with `tool_choice: "auto"`. The LLM picks a tool (or "no tool — answer directly"). Slower (~200ms) but handles ambiguous inputs.

**Layer 3 — same shape as heuristic-before-LLM.** Tool routing IS heuristic-before-LLM applied to tool selection. The discipline is identical: log heuristic-routed cases, periodically sample through the LLM, detect drift.

```
   Symmetry
   ────────
   classifier:   heuristic-before-LLM classifies into a type
   tool router:  heuristic-before-LLM dispatches to a tool
   pattern:      same routing logic; different output domain
```

### Move 3 — The principle

Heuristic for predictable patterns; LLM for ambiguous remainder. Same shape, different domain.

---

## Tool routing — diagram

```
┌─ Hybrid tool dispatch ─────────────────────────────────────────────────┐
│                                                                        │
│   user input                                                           │
│         │                                                              │
│         ▼                                                              │
│   heuristic_route(input)                                               │
│       case prefix "delete ": → delete tool                             │
│       case prefix "search ": → search tool                             │
│       case prefix "@ tag":   → thread tool                             │
│       default:                 null                                    │
│         │                                                              │
│    ┌────┴────┐                                                         │
│    │ null?   │                                                         │
│    └────┬────┘                                                         │
│         │                                                              │
│    ┌────┴────┐                                                         │
│    │         │                                                         │
│    ▼ no      ▼ yes                                                     │
│  dispatch  llm_router(input, tool_definitions)                         │
│  directly  → tool + arguments                                          │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not have a tool-routed surface today.**

Phase 4 builds tool routing for whichever agent path is picked. For buffr's classifier-with-retrieval, the "tool" choice is binary (retrieve or not) and can be heuristic (confidence threshold).

---

## Elaborate

### Where this pattern comes from

Cleanly described in Anthropic's "Building effective agents" (2024) post. The pattern is folklore in production agent systems — heuristic for fast path, LLM for fallback.

### The deeper principle

Same as heuristic-before-LLM (concept 01-llm-foundations/07): the cheapest LLM call is the one you don't make.

### Where this breaks down

When inputs are uniformly ambiguous (chat interfaces with no structural cues), heuristics don't fire reliably. LLM routing throughout is then correct.

### What to explore next

- [02-tool-calling](./02-tool-calling.md) — the LLM-routed path executes tools
- [`01-llm-foundations/07-heuristic-before-llm`](../01-llm-foundations/07-heuristic-before-llm.md) — same pattern, different domain

---

## Tradeoffs

The breakpoint: heuristic when input patterns are structured (verb prefixes, hashtags); LLM-only when input is free-form natural language.

---

## Tech reference

- **Implementation:** dispatch table for heuristic; `tool_choice: "auto"` for LLM router.

---

## Project exercises

### B4-tool-route — Heuristic + LLM router for a future command bar

- **What to build:** if buffr ever adds a command bar, route via the hybrid pattern.
- **Done when:** the command bar dispatches deterministically for structured inputs and falls through to LLM for ambiguous.
- **Estimated effort:** 4 hours.

---

## Summary

- Heuristic routing for predictable; LLM routing for the rest.
- Same shape as heuristic-before-LLM applied to tool selection.
- Log heuristic-routed cases; detect drift.

---

## Interview defense

**Q [mid]:** When does LLM-only routing make sense?

**A:** When input is uniformly free-form natural language without structural cues. For a chat interface where every message could be any kind of request, LLM routing handles the ambiguity. For a command bar with verb-prefix patterns, heuristics catch 70%+ of inputs at sub-ms; LLM handles the rest.

### One-line anchors

- Heuristic for structured input; LLM for free-form.
- Same shape as heuristic-before-LLM.
- Log routed cases; detect drift.

---

## Validate

### Quick check
- What's the symmetry between tool routing and classifier routing?
- When does pure LLM routing earn its place?
- What's the maintenance cost of heuristic routes?
