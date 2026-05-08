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

---

## Interview defense

### What an interviewer is really asking
"Why no agents?" is the most loaded AI question in 2026. Half the field is shipping LangGraph state machines for problems that don't need them; the other half is shipping nothing because they can't decide. The interviewer wants to see I picked single-chain because the *steps are knowable in advance* — not because I was scared of complexity. The clue: I want to enumerate the four jobs (summarize/caption/classify/expand) and show that none of them have a "decide what to do next" question.

### Likely questions

[mid] Q: Where in the codebase would I look to find an "orchestrator" if there were one?
      A: There isn't one. Each AI service file in `src/services/ai/` and `src/services/todos/` owns one chain end-to-end: get config, build prompt, single call, parse, validate, persist. There's no `agent.ts`, no `orchestrator.ts`, no graph. The patterns that *surround* the LLM — heuristic-first in `heuristicClassify.ts`, fire-and-forget in `scheduleClassify`, validation in `validate.ts`, the `user_overridden_type` lock — are app-code conventions that run before or after the model, not multi-step LLM reasoning. App fires LLM, never LLM fires LLM.

[senior] Q: What's an example of a feature you considered, then explicitly chose not to build as an agent?
         A: "Plan a vlog from a week of entries with self-critique." The naive agent shape is: outline → critique outline → refine → render plan, with each step a separate LLM call and the model deciding when it's good enough. I chose not to build it because (a) loopd is a single-day app — the editor commits one day's structured composition, and weekly planning doesn't fit the data model; (b) the cost would be 3-4× the per-call cost of summarize at ~$0.04 each, with no quality ceiling I'd hit with a single chain plus better prompts; (c) the failure modes balloon — what does "step 2 returned malformed JSON" recover to? Single-chain summarise plus a future "weekly digest" feature as another single chain handles 95% of what the agent would deliver, at a fraction of the cost and complexity.

[arch] Q: When *would* you add an agent loop in this codebase? What's the trigger?
       A: The day a feature has steps the model needs to *decide* rather than steps I can hardcode. Concretely: "find every time the user mentioned Project X across the archive, summarise the trajectory, flag contradictions" — that needs search → synthesis → comparison → flag, with the model deciding when it has enough evidence. That's an agent. It would go in a new file (not a modification to the four existing chains), with explicit max-iteration cap, per-call timeout, and cost ceiling. The four single-chain files stay single-chain; agents earn their existence by needing the loop.

### The question candidates always dodge
Q: Isn't `expand.ts` essentially a chained call? It picks a system prompt based on type, then validates, then maybe retries with a stricter prompt. Where exactly does single-chain end and agent begin?

A: Partly. But also: at one user with at most three days of context per chain, the steps ARE knowable in advance. `expand.ts` reads `meta.type`, looks up `getSystemPrompt(meta.type)` — that's a deterministic table, not a model decision. The retry with stricter prompt is a re-call of the same chain, not a new step the model chose. An agent is when the model says "I want to call tool X" and the orchestrator runs X and feeds the result back. `expand.ts` never asks the model what to do next; it just runs the chain again with a different system message if validation failed. The line I draw: a chain re-runs the same job; an agent decides what job to run. Adding an agent loop here means more cost, more failure modes, and no capability gain — none of the four jobs need the model to decide. I'd add agents the day the steps stop being knowable in advance, for example the day the user asks the model "show me everything I wrote about Project X" across the full archive.

### One-line anchors
- "Single chain re-runs the same job. An agent decides what job to run."
- "The steps are knowable in advance. That's why no agents."
- "Cost + debuggability + no quality gain = no agent."
- "Agents earn their existence by needing the loop. Today's jobs don't."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
