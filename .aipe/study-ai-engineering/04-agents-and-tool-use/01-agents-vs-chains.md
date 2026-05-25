# Agents vs chains

**Industry name(s):** Agents vs chains, agentic vs scripted, loop vs pipeline
**Type:** Industry standard

> Chain = linear sequence you define, LLM executes each step. Agent = loop where LLM decides which steps and how many. Chains are predictable; agents are flexible. Use chains when you know the steps; use agents when the steps depend on what the LLM finds.

**See also:** → [`02-context-and-prompts/03-prompt-chaining`](../02-context-and-prompts/03-prompt-chaining.md) · → [02-tool-calling](./02-tool-calling.md) · → [03-react-pattern](./03-react-pattern.md)

---

## Why care

### Move 1 — The grounded scenario

Buffr's classifier today is a chain: take input, run heuristic, fall through to LLM if no match, return type. Predictable, deterministic flow. Imagine a "classify with retrieval" upgrade: classify the todo; if confidence < 0.7, retrieve similar past todos via embeddings; re-classify with the retrieved context. The number of LLM calls is no longer fixed — sometimes 1 (high-confidence first pass), sometimes 2 (low-confidence + re-classify). That's an agent shape.

### Move 2 — Name the question the pattern answers

That fixed-steps-or-loop question is what agents-vs-chains answers. Not "should I use agents" (depends on task); just *when do I know the steps in advance vs let the LLM decide*.

### Move 3 — Why answering that question matters

**What breaks if you pick wrong:** chains where the path is unknown produce brittle code (every possible path coded by hand). Agents where the path is known introduce unpredictability and cost for no reason. For buffr today, every chain has a known path — no agents needed. For a future classifier-with-retrieval upgrade (curriculum Path B), the decision shifts.

### Move 4 — Concrete before/after

Chain (buffr today's classifier):
- Fixed: heuristic → fallback LLM if needed → return
- 0 or 1 LLM calls, predictable

Agent (hypothetical upgrade):
- Loop: classify → check confidence → maybe retrieve → maybe re-classify → return
- 1 to 3 LLM calls, depends on confidence

### Move 5 — The one-line summary

Chains: fixed steps you define. Agents: loops where the LLM picks. Pick chain when path is known; agent when path depends on what the LLM finds.

---

## How it works

### Move 1 — The mental model

```
   Chain (linear, predictable):
   Input → Step 1 → Step 2 → Step 3 → Output
   (you define the steps; LLM executes each one)

   Agent (loop, unpredictable count):
   Input → Thought → Action → Observation → Thought → ... → Output
   (LLM decides which steps and how many)

   ┌─ Agent loop ────────────────────────────────────┐
   │                                                  │
   │   ┌─────────┐                                    │
   │   │ Thought │ ← LLM decides what to do next      │
   │   └────┬────┘                                    │
   │        │ choose tool                             │
   │        ▼                                         │
   │   ┌─────────┐                                    │
   │   │ Action  │ ← call a tool                      │
   │   └────┬────┘                                    │
   │        │ tool returns result                     │
   │        ▼                                         │
   │   ┌─────────────┐                                │
   │   │ Observation │ ← LLM reads result             │
   │   └────┬────────┘                                │
   │        │                                         │
   │        └──── loop or stop                        │
   └──────────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — chain mechanics.** You write the sequence. Each LLM call has fixed input shape and produces fixed output shape. Buffr's `summarize → caption` is the canonical example.

**Layer 2 — agent mechanics.** The LLM is given a set of tools; on each turn it picks one (or "I'm done"). Your code runs the tool, feeds the result back, and loops. Termination: an explicit "done" signal from the LLM, a max-iteration cap, or an error.

```
   Cost shape
   ──────────
   chain:    N LLM calls, fixed up-front (you know N)
   agent:    1 to MAX LLM calls, depends on the path
             worst case: MAX × cost per call
```

**Layer 3 — when to reach for agents.** When the task has multiple possible paths AND the LLM needs to choose among them. When the task is single-path, a chain is simpler. For buffr's current chains, single-path is correct — there's no decision the LLM should make about "which step next." A future ask like "diagnose why this entry failed validation" might be agent-shaped because the diagnosis path depends on what the LLM finds.

### Move 3 — The principle

Chains for known paths; agents for paths the LLM should decide. Default to chains; reach for agents when the decision is structural, not just hypothetical complexity.

---

## Agents vs chains — diagram

```
┌─ Chain (buffr today) ──────────────────────────────────────────────────┐
│                                                                        │
│   input → summarize → cache → caption → output                         │
│            (1 call)            (1 call)                                │
│           fixed: 2 LLM calls per day-summary feature                   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

┌─ Agent (hypothetical buffr classifier-with-retrieval) ─────────────────┐
│                                                                        │
│   input → classify ──→ confidence?                                     │
│                            │                                           │
│                       ┌────┴────┐                                      │
│                       │         │                                      │
│                       ▼ high    ▼ low                                  │
│                    return       retrieve similar → re-classify         │
│                    type         (LLM decides if needed; may loop)      │
│                                                                        │
│           variable: 1 to 3 LLM calls depending on the path             │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not use agents.**

All 5 chains are single-path. Phase 4 (curriculum) offers three potential agent paths; Path B (buffr classifier upgrade) and Path C (contrl-mo coaching) are buffr-relevant only Path B applies to buffr. Path B is the build target if buffr ever needs agent-shaped behaviour; today it doesn't.

---

## Elaborate

### The deeper principle

Predictability and flexibility trade off. Chains predict; agents adapt. Default to predictable.

### Where this breaks down

When you don't know your task shape yet (exploration phase), agents are appealing because they're flexible. The trap: agents that "work" in exploration become uncontrollable in production. Fix the path once you know it; chain.

### What to explore next

- [`02-context-and-prompts/03-prompt-chaining`](../02-context-and-prompts/03-prompt-chaining.md) — the chain pattern in detail
- [02-tool-calling](./02-tool-calling.md) — agents need tools
- [03-react-pattern](./03-react-pattern.md) — the specific agent shape

---

## Tradeoffs

The breakpoint: chain by default; agent when the path is genuinely LLM-decided. "More flexible" is not enough reason; the LLM has to be making a real decision.

---

## Tech reference

- **Chain libraries:** plain TypeScript functions in buffr today.
- **Agent libraries:** Anthropic tool calling, OpenAI assistants, LangChain agents, manually-coded loops.

---

## Project exercises

### B4B.1 — Classifier mini-agent (path B from Phase 4)

- **Exercise ID:** `B4B.1`
- **What to build:** upgrade classifier to a mini-agent: classify → check confidence → retrieve if low → re-classify. Tools: `retrieve_similar_todos`, `get_user_override_history`. Termination: confidence ≥ 0.7 or 2 iterations.
- **Done when:** the upgraded classifier outperforms the current one on the eval set.
- **Estimated effort:** 8 hours.

---

## Summary

- Chain: known steps, fixed flow.
- Agent: loop where LLM decides.
- Buffr is all chains today; agents are Case B (Phase 4 build).
- Default to chains.

---

## Interview defense

**Q [mid]:** When does an agent earn its place?

**A:** When the path through the task genuinely depends on what the LLM finds. If you can write the flow as a fixed sequence of steps, write it as a chain — predictable, cheaper, debuggable. Use an agent when the next step is a real decision (e.g., classify-then-maybe-retrieve-then-re-classify). For buffr today, every chain is single-path; no agents.

### One-line anchors

- Chain: fixed; agent: LLM-decided loop.
- Cost: chain is bounded; agent is variable.
- Default to chain.

---

## Validate

### Quick check
- Which of buffr's chains is closest to being agent-shaped?
- What's the cost shape of an agent vs a chain?
- When does an agent earn its place?
