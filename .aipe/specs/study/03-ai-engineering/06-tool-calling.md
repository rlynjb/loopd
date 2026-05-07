# Tool calling — not used in loopd

> The codebase deliberately does not implement tool calling, agents, or any loop where the LLM asks the app to do something and read the result back.

**See also:** → [01-what-an-llm-is](./01-what-an-llm-is.md) · → [12-why-no-agents](./12-why-no-agents.md)

---

## Quick summary
- **What:** every loopd AI call is one-shot — prompt → JSON → done. No loops where the model decides "I need to search," runs a tool, and reads the result.
- **Why here:** every AI feature is a one-shot transformation (text → structured JSON). There's nothing for the LLM to *navigate* — the data the app needs is already in hand when the call is made.
- **Tradeoff:** when a feature legitimately needs tool use ("find the day I was sickest last month"), it would have to be added as a new service file with its own tool loop.

---

## Tool calling — diagram

```
  Every loopd AI call:                  An agent with tools (NOT loopd):
  ────────────────────────              ────────────────────────────────

   prompt → JSON → done                  prompt → tool? → run tool
                                                     ▲          │
                                                     │          ▼
                                                     │     observation
                                                     └──────────┘
```

---

## How it works (in agents that use tools, which loopd doesn't)

The model is given a list of "tools" with their input schemas. Its output may include a tool call: `{ tool: "search_entries", input: { query: "sickest" } }`. The orchestrator runs the tool (a SQL query, an HTTP call, a calculation), packages the result as an "observation," and re-prompts the model with the original conversation + the observation. The model can then issue another tool call or a final answer. This loops until done.

**Loopd doesn't do any of this.** Every call is final the moment the JSON is parsed.

---

## When tools would matter

If the user asked "find me the day I was sickest last month" and the answer required searching entries, that's where tool calling fits. The model emits `{tool: "search_entries", input: {query: "sickest"}}`, the app runs SQL, replies, the model summarises. Loopd doesn't have that surface today.

The closest cousin loopd does have is `scheduleClassify` — but that's app code firing an LLM call, not the LLM asking the app to do work.

---

## In this codebase

Tool calling is absent. The four AI services (`summarize`, `caption`, `classify`, `expand`) all return on the first response. There is no place in the codebase that interprets a model output as a tool invocation.

---

## Elaborate

### Where this pattern comes from
Tool calling came out of the ReAct paper (2022) and was popularised by ChatGPT plugins, then formalised in Claude's tool-use API and OpenAI's `tools` parameter. The pattern: let the model decide which tool to invoke, run it, give it back the result, repeat.

### The deeper principle
**Tools turn an LLM from a "function" into a "loop."** That's a major capability upgrade and a major reasoning-about-cost downgrade. Tool loops can run unboundedly, can call expensive operations, can hallucinate tool names. Add them deliberately, not by default.

### Where this breaks down
- Without tools, the model can't navigate large data. Stuffing everything into the prompt fails at scale.
- Tool loops without budget caps can run away. Production tool agents need timeouts, max iterations, cost ceilings.

### What to explore next
- [12-why-no-agents](./12-why-no-agents.md) → loopd's explicit decision against multi-step.
- [07-rag](./07-rag.md) → the alternative when context is too big.

---

## Tradeoffs

- **No tool calling** — gives: predictable cost, simple control flow. Costs: features needing navigation can't be expressed as a single chain.
- **One-shot transformations** — gives: trivially debuggable, retriable. Costs: hits a ceiling on task complexity.
- **App-fires-LLM, not LLM-fires-app** — gives: the app stays in control. Costs: the model can't ask for what it needs.
