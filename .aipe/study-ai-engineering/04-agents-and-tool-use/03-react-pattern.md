# ReAct pattern

**Industry name(s):** ReAct, Reasoning + Acting, thought-action-observation
**Type:** Industry standard

> Force the model to externalise its reasoning between actions: Thought → Action → Observation. The trace is debuggable; you can see why each step happened. Standard agent shape for multi-step problems where each step depends on prior results.

**See also:** → [01-agents-vs-chains](./01-agents-vs-chains.md) · → [02-tool-calling](./02-tool-calling.md) · → [`01-llm-foundations/01-what-is-an-llm`](../01-llm-foundations/01-what-is-an-llm.md)

---

## Why care

### Move 1 — The grounded scenario

Imagine asking an agent: "How many auth-related PRs are open?" Without the ReAct shape, the LLM emits a single tool call and you hope it's the right query. With ReAct, the LLM emits its reasoning first: "I need to search PRs for auth-related ones." Then a tool call. Then it reads the result, reasons again ("but I should also check 'authentication' variants"), calls another tool. Each step's reasoning is visible. If the agent goes off the rails, you can see which thought led there.

### Move 2 — Name the question the pattern answers

That can-I-see-its-reasoning question is what ReAct answers. Not "is reasoning better than no reasoning" (yes); just *what structural shape externalises the reasoning so I can debug the agent*.

### Move 3 — Why answering that question matters

**What breaks without ReAct (or similar):** agents become black boxes. When they fail, you have a tool-call trace with no rationale. With ReAct, each tool call is preceded by a thought naming why — debuggable, even on first inspection.

### Move 4 — Concrete before/after

Without ReAct (just tool calls):
- Agent issues 5 tool calls
- The 4th one is wrong; the agent gives up
- Why? Unclear without the rationale trace

With ReAct (thought-action-observation):
- Agent emits Thought 1, Action 1, Observation 1
- Thought 4 reveals: "Based on the previous result I should now…"
- The 4th tool call's wrongness traces back to a misread observation
- Debug in minutes

### Move 5 — The one-line summary

ReAct = Thought → Action → Observation loop; externalises reasoning; makes agents debuggable; standard shape for multi-step problems.

---

## How it works

### Move 1 — The mental model

```
   Question: "How many open auth-related PRs are there?"

   Thought 1: "I need to search PRs for auth-related ones."
   Action 1:  search_prs(query="auth", state="open")
   Observation 1: 7 PRs returned.

   Thought 2: "But the user wants count. Let me also check
              if any have 'authentication' in the title."
   Action 2:  search_prs(query="authentication", state="open")
   Observation 2: 3 additional PRs (no overlap with first).

   Thought 3: "Total is 7 + 3 = 10."
   Final answer: "There are 10 open auth-related PRs."
```

### Move 2 — The layered walkthrough

**Layer 1 — the prompt template.** The system prompt instructs the model to output in the Thought / Action / Observation shape. The agent loop parses each step. Modern providers' tool-calling APIs handle the Action and Observation parts natively; the Thought part is text the model emits between tool calls.

**Layer 2 — chain-of-thought vs ReAct.** Plain chain-of-thought asks the model to reason once and produce a final answer. ReAct interleaves reasoning with tool calls — reason, act, observe, reason again. The interleaving is what makes multi-step problems tractable.

```
   Comparison
   ──────────
   Chain-of-thought:  Thought (long) → Answer
   ReAct:             Thought → Action → Observation → Thought → Action → ...
```

**Layer 3 — when ReAct shines.** Multi-step problems where each step depends on prior results. Code search, data exploration, document Q&A over large corpora. For single-step problems (one tool call answers the question), plain tool calling suffices — no need for the externalised reasoning.

### Move 3 — The principle

Externalise reasoning between actions; make agent traces debuggable; the interleaving of thought and action is the load-bearing part.

---

## ReAct — diagram

```
┌─ ReAct loop ───────────────────────────────────────────────────────────┐
│                                                                        │
│   user question                                                        │
│         │                                                              │
│         ▼                                                              │
│   LLM emits Thought + Action                                           │
│         │                                                              │
│         ▼ Action is a tool_use content block                           │
│         │                                                              │
│   your code runs tool                                                  │
│         │                                                              │
│         ▼                                                              │
│   tool_result message back to LLM                                      │
│         │                                                              │
│         ▼                                                              │
│   LLM emits next Thought + Action (or final Answer)                    │
│         │                                                              │
│         └── loop or done                                               │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not implement ReAct.**

Phase 4 `B4B.1` (classifier upgrade) and `C4.3` (read & annotate the ReAct paper) are the curriculum items. For buffr's planned classifier-with-retrieval, ReAct shape would apply: Thought "I'm uncertain about this classification, let me retrieve similar todos" → Action retrieve → Observation 5 similar todos → Thought "Based on the patterns, the type is X" → Final answer.

---

## Elaborate

### Where this pattern comes from

Yao et al. 2022 "ReAct: Synergizing Reasoning and Acting in Language Models." Adopted broadly as the canonical agent shape by 2023.

### The deeper principle

Visibility into the agent's reasoning is the difference between debuggable and inscrutable. Forced externalisation costs tokens but pays back in debuggability.

### Where this breaks down

For very simple agents (one or two tool calls), the externalised reasoning is overhead. The reasoning's value scales with the path complexity.

### What to explore next

- [02-tool-calling](./02-tool-calling.md) — Action is a tool call
- [04-tool-routing](./04-tool-routing.md) — which tool to pick
- [`01-llm-foundations/01-what-is-an-llm`](../01-llm-foundations/01-what-is-an-llm.md) — the LLM doesn't "think" inherently; ReAct makes it write thinking

---

## Tradeoffs

The breakpoint: ReAct for multi-step agents; plain tool calling for single-step.

---

## Tech reference

- **Paper:** Yao et al. 2022. Required reading for Phase 4 (curriculum `C4.3`).
- **Implementation:** system prompt + tool-calling protocol.

---

## Project exercises

### B4B.1 — Classifier agent with ReAct shape

- **What to build:** the upgraded classifier agent outputs Thought + Action; the loop runs Action, sends Observation back; terminates on Final.
- **Done when:** trace is debuggable; the agent terminates correctly.
- **Estimated effort:** included in Phase 4 work.

---

## Summary

- ReAct = Thought / Action / Observation loop.
- Externalises reasoning for debuggability.
- Standard for multi-step problems.
- Buffr: Case B; Phase 4 build target.

---

## Interview defense

**Q [mid]:** Why is ReAct better than just tool calling for multi-step problems?

**A:** ReAct interleaves reasoning with actions. Every tool call is preceded by an explicit thought stating why. The trace is debuggable — when the agent goes wrong, you can trace which thought led where. Plain tool calling gives you actions but no rationale; debugging is detective work.

### One-line anchors

- Thought / Action / Observation loop.
- Externalised reasoning for debuggability.
- Multi-step problems benefit; single-step doesn't need ReAct.

---

## Validate

### Quick check
- What three steps repeat in the ReAct loop?
- What does ReAct add over plain tool calling?
- When is the overhead not worth it?
