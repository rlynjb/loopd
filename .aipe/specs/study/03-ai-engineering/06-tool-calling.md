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

---

## Interview defense

### What an interviewer is really asking
"Why no tool calling?" is the senior interviewer's tell that they want to see whether I can articulate when a feature *needs* tools versus when it doesn't. The answer they're checking for: do I understand that tool calling is a control-flow upgrade with a cost upgrade, and do I know what kind of feature would justify it? The trap is the candidate who says "I just didn't get to it" — that signals I haven't thought about the design space.

### Likely questions

[mid] Q: Concretely, what does "no tool calling" mean for the four chains in this codebase?
      A: It means every call returns on the first response. `summarize`, `caption`, `classify`, `expand` all hand the model a prompt, get back a JSON string, parse it, and persist. Nowhere in the codebase does the model emit something like `{tool: "search_entries"}` and the app run a SQL query and feed the result back. The closest cousin is `scheduleClassify` — but that's app code firing an LLM call, not the LLM asking the app to do work. The control flow is always: app decides → LLM responds → app persists.

[senior] Q: Is there a feature in loopd today where adding tool calling would be a clear win?
         A: Not today. Every feature is a one-shot transformation: "summarise this day", "caption this day", "classify this line", "expand this todo". The data the model needs is already in hand at call time, packed into the prompt by `buildContext()`. Tool calling pays off when the model needs to *navigate* — search a corpus, query a DB, hit an external API — and the cost of stuffing every possibility into the prompt is too high. Loopd's prompts are small and the corpus is one user's journal. Nothing to navigate.

[arch] Q: Suppose I add a feature: "find me every day I wrote about Project X." Would that be the moment for tool calling?
       A: That's exactly the moment. The model would emit `{tool: "search_entries", input: {query: "Project X"}}`, the app would run an FTS5 or pgvector search, return the rows as an observation, and the model would synthesise. I'd build it as a new service file — not a modification to the four existing chains. It would need a max-iteration cap, a per-tool-call timeout, and a cost ceiling (otherwise a runaway loop costs real money). Tool calling is a major control-flow upgrade and I'd want it isolated.

### The question candidates always dodge
Q: Tool calling and agents are the standard way to build AI apps in 2026. Are you sure you're not just behind on the tooling?

A: I'm not behind on the tooling — I read the Claude tool-use API and OpenAI's `tools` parameter and I deliberately didn't reach for them. Tool calling turns the LLM from a function into a loop, and a loop has runaway cost, harder debugging, and tool-name hallucination as failure modes. Adding it without a feature that needs it would burn budget for no quality gain. The four chains in `src/services/ai/` work because the data they need fits in the prompt; the moment a feature genuinely needs to navigate (search across the archive, hit an external API, run code) I'd add tools — in a new service file, with iteration caps and timeouts. The decision isn't "tools are bad", it's "tools are the wrong tool for one-shot transformations". I'll grant the dodge though: if I'm wrong about a future feature, the day it ships will look like "we should have built the tool-loop sooner".

### One-line anchors
- "Tools turn an LLM from a function into a loop. Add them deliberately."
- "Every chain returns on the first response. There is no observation step."
- "App-fires-LLM, not LLM-fires-app. The app stays in control."
- "The day a feature needs to navigate, tools go in a new file."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
