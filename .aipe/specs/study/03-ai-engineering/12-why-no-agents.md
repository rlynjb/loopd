# Why no agents, no chains-of-chains

> The codebase deliberately stops at single chains. Every pattern surrounding the LLM (heuristic-first, async classify, validation gate, user-override lock) lives *outside* the model — in app code that calls one function and consumes its output.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [06-tool-calling](./06-tool-calling.md) · → [01-what-an-llm-is](./01-what-an-llm-is.md)

---

## Quick summary
- **What:** there are no agents, no LangGraph-style multi-step orchestrations, no chains-of-chains in loopd. Every AI call is one prompt, one response, one parse.
- **Why here:** the four jobs (summarize, caption, classify, expand) are all one-shot transformations. Multi-step doesn't add value for these.
- **Tradeoff:** features that need multi-step reasoning (e.g., "plan a vlog from a week of entries; review each step") would need a new service file with its own loop.

---

## Single chain vs agent — diagram

```
  Loopd (single chain):              Hypothetical agent:
  ─────────────────────              ────────────────────

   summarize(date)                    planAVlog(week)
        │                                   │
        ▼                                   ▼
   prompt → LLM → JSON                 step 1: outline
        │                                   │  prompt → LLM → outline
        ▼                                   ▼
   parse + validate                    step 2: critique outline
        │                                   │  prompt → LLM + outline → critique
        ▼                                   ▼
   persist                             step 3: refine outline
        │                                   │  prompt → LLM + outline + critique → refined
        ▼                                   ▼
     done                              step 4: render plan
                                            │  prompt → LLM + refined → plan
                                            ▼
                                        validate → persist → done
```

---

## How it works (in loopd: it doesn't)

Loopd does not chain LLM calls. There is no orchestration layer. Each AI service file owns one chain and returns when that chain finishes.

The patterns that *surround* the LLM (heuristic-first gate, async fire-and-forget, validation gate, user-override lock) are app-code conventions, not chain orchestrations. They run before or after the model — never instead of it.

---

## When to add an agent

If a feature ever needs multi-step LLM reasoning, the place to add an agent is **a new service file**, not a modification to summarize/caption/classify/expand. Each of those four files is intentionally one-job, and the principle 12 list (DB-first, prose-canonical, etc.) doesn't change because of AI — those constraints apply equally well to whatever loopd ships next.

The criteria for adding an agent:
- The task genuinely needs multi-step reasoning (planning, critique, revise).
- A single chain has been tried and the quality ceiling is reached.
- The cost ceiling and timeout policy have been thought through.

---

## In this codebase

The four AI service files (`summarize`, `caption`, `classify`, `expand`) are all single-chain. There is no "agent" file, no "orchestrator", no "graph" anywhere in `src/services/ai/` or `src/services/todos/`.

---

## Elaborate

### Where this pattern comes from
"Build the simplest thing that works" is the canonical engineering rule. Agents are seductive (they can do anything!) but they're hard to debug, hard to budget, and hard to test. Single chains stay close to the canonical "prompt → JSON" model.

### The deeper principle
**Add complexity only when the simpler model fails.** Loopd's jobs are simple jobs. They don't need agents. Adding an agent because "agents are cool" would burn budget for no quality gain.

### Where this breaks down
- Tasks where single-chain quality plateaus and multi-step is the only way forward. When that day comes, the agent goes in a new file.
- Tasks where the model could navigate richly (large unstructured corpora, code generation). Loopd doesn't have these.

### What to explore next
- [06-tool-calling](./06-tool-calling.md) → the tool-loop pattern that agents use.
- [02-single-purpose-chains](./02-single-purpose-chains.md) → the pattern loopd does use.
- LangGraph / LlamaIndex agents → for the multi-step alternative.

---

## Tradeoffs

- **No agents** — gives: predictable cost, easy debugging, simple control flow. Costs: ceiling on task complexity.
- **Single-chain rule** — gives: every AI service looks the same. Costs: when an agent IS needed, it must be added as a deliberate exception.
- **App-code patterns surrounding LLMs** — gives: separation between "what the model decides" and "what the app does next." Costs: app code carries more logic than a fully agentic system would.
