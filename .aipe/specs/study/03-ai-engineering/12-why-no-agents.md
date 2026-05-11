# Why no agents, no chains-of-chains

**Industry name(s):** — (architecture decision: chains over agent loops)
**Type:** Project-specific

> The codebase deliberately stops at single chains. Every pattern surrounding the LLM (heuristic-first, async classify, validation gate, user-override lock) lives *outside* the model — in app code that calls one function and consumes its output.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [06-tool-calling](./06-tool-calling.md) · → [01-what-an-llm-is](./01-what-an-llm-is.md)

---

## Why care

"Agent" is the most loaded word in AI engineering. It promises a model that plans, takes actions, observes the result, and adapts — autonomous, capable, intelligent. In practice, an agent is a `while` loop that re-prompts the same model with growing context until it emits a stop token or runs out of budget. Most of the time, for most jobs, that loop adds nothing a single well-designed prompt couldn't do — but it costs five to twenty times as much and fails in ways that are very hard to debug.

The "no agents" decision is an architectural stance: do the smallest amount of LLM work that solves the problem, and keep the control flow in normal code where it can be read, tested, and instrumented. It belongs to the family of "prefer the boring solution" patterns — choose the deterministic state machine over the autonomous loop, the cron job over the self-scheduling worker, the explicit pipeline over the magic. You've already seen the alternative everywhere: LangChain agents, AutoGPT, BabyAGI, OpenAI's Assistants API, multi-step "researcher" demos. They are dazzling in benchmarks and treacherous in production. Many serious teams quietly rewrite their agents back into chains once the bill arrives. How it works generally is in the next block.

---

## How it works (in loopd: it doesn't)

Loopd does not chain LLM calls. There is no orchestration layer. Each AI service file owns one chain and returns when that chain finishes.

The patterns that *surround* the LLM (heuristic-first gate, async fire-and-forget, validation gate, user-override lock) are app-code conventions, not chain orchestrations. They run before or after the model — never instead of it. The diagram below contrasts the two shapes end-to-end.

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

## When to add an agent

If a feature ever needs multi-step LLM reasoning, the place to add an agent is **a new service file**, not a modification to summarize/caption/classify/expand. Each of those four files is intentionally one-job, and the principle 12 list (DB-first, prose-canonical, etc.) doesn't change because of AI — those constraints apply equally well to whatever loopd ships next.

The criteria for adding an agent:
- The task genuinely needs multi-step reasoning (planning, critique, revise).
- A single chain has been tried and the quality ceiling is reached.
- The cost ceiling and timeout policy have been thought through.

---

## In this codebase

_Agents not implemented — intentionally absent._ The five AI service files are all single-chain:

**Single-chain anchor 1:**  `src/services/ai/summarize.ts` → `summarize()` L42–L105 (no observation step; one parse, one validate, one persist)
**Single-chain anchor 2:**  `src/services/ai/caption.ts` → `generateCaption()` L201–L223
**Single-chain anchor 3:**  `src/services/todos/classify.ts` → `classifyTodo()` L90+
**Single-chain anchor 4:**  `src/services/ai/interpret.ts` → `interpretEntry()` L114–L149 — markdown out, no observation step (the 5th chain, added 2026-05-10)
**Closest to agent:**       `src/services/todos/expand.ts` → `expandTodo()` L191+ with the one-retry pattern — but the retry is a re-call of the same chain with a stricter prompt, not a model-chosen tool invocation
**Architectural anchor:**   no `src/services/ai/agent.ts`, no `orchestrator.ts`, no graph anywhere in `src/services/ai/` or `src/services/todos/`

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

We traded the capability ceiling of multi-step agent loops (planning, critique, revise) for predictable single-chain cost, trivial debuggability, and zero runaway-loop risk — every chain is one prompt, one response, one persist, with the steps knowable at design time.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (single chains)     │ Alternative (agent loops)      │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Money            │ 1 call per chain at $0.0001-   │ N iterations × ~$0.04 each;    │
│ ($/feature)      │ $0.04 (per-call)               │ uncapped = $1+ per request;    │
│                  │                                │ 3-4× per-call cost minimum     │
│ Latency          │ ~800ms-5s per chain            │ N × ~1.5s = 5-30s per feature  │
│                  │                                │ user-visible wait              │
│ Failure mode     │ parse/validate/network — 3     │ all 3 PLUS step-2-fails,       │
│ surface          │ categories; recovery clear     │ model-stops-early, infinite-   │
│                  │                                │ loop, tool-arg-hallucination   │
│ Debuggability    │ prompt + response + validator  │ N-step trace + intermediate    │
│                  │ — 3 artifacts per call          │ state log; needs Trace UI to   │
│                  │                                │ replay                         │
│ Cost ceiling     │ implicit — one call per fire   │ explicit caps required:        │
│ control          │                                │ max_iterations + per-call      │
│                  │                                │ timeout + total $$ ceiling     │
│ Capability       │ ceiling: steps must be         │ unbounded — model plans,       │
│ ceiling          │ knowable at design time         │ critiques, revises, decides    │
│ Cognitive load   │ "one chain, one job" — uniform │ "what step is this? what tool? │
│                  │ across 5 services              │ when does it stop?" — 4 new    │
│                  │                                │ questions per feature          │
│ Quality gain     │ baseline — good prompts +      │ +5-15% on complex tasks; ~0%   │
│                  │ structured output suffice for  │ on one-shot tasks (loopd's     │
│                  │ knowable steps                  │ are all knowable)              │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

We gave up the capability ceiling of multi-step reasoning. None of the five chains can plan, critique, revise, or decide what to do next — they each do one job and return. A feature that genuinely needs sequential thinking ("read the entry, identify themes, group todos, propose tomorrow's pinned items, with the model deciding when it has enough evidence") cannot be expressed as a single chain. We'd have to ship it as a new service file (an agent), with explicit iteration cap, per-call timeout, and total cost ceiling — and we don't have any such feature today.

We pay the implicit cost of keeping app code in control. The patterns surrounding the LLM — heuristic-first gate (`heuristicClassify.ts`), async fire-and-forget (`scheduleClassify`), validation gate (`validate.ts`), user-override lock (`user_overridden_type`) — are all app-code conventions that run before or after the model. An agentic system would let the model decide more of this: "I'm not confident, let me search for similar entries first" instead of the app deciding "let me run the heuristic first." Agentic flexibility comes at the cost of giving up that control.

The cost is also lock-in to the "one prompt, one response" mental model. If a future feature *does* need multi-step reasoning, the codebase doesn't have any prior art for iteration caps, cost ceilings, intermediate-state logging, or replay tools — all of which would need to be designed and built. We're deliberately deferring that work until a feature demands it.

### What the alternative would have cost

A multi-step agent loop on top of the existing chains would have added three categories of cost. First, runaway-loop risk: without explicit `max_iterations` and per-call timeouts, a misbehaving model can spin for 20+ iterations and rack up $20 on a single user query. Mitigations are straightforward code (caps + cost ceiling + timeout) but they're code we don't have to write today because we have no loops.

Second, debugging cost. A single-chain trace is "prompt + response + validation result" — three artifacts. An agent trace is "prompt + step1 response + critique + step2 response + revision + ..." with N branching iterations. Replaying a failed agent run requires the full intermediate state log. Tools like LangSmith and LangChain Trace UI exist because raw logs are unreadable; we'd need similar.

Third, failure-mode surface multiplies. Today's three categories (parse fail, validation fail, network) would balloon to seven or eight (step-2-fails, tool-name hallucination, mid-loop network drop, infinite loop, premature stop, tool-arg type mismatch, ...). Each one needs a handler. The current chains handle three failure modes total across all five services; agents would multiply this 2-3× per feature.

The quality benefit is real but bounded. Agent loops empirically gain 5-15% on complex tasks (planning, multi-document synthesis); on one-shot transformations like summarize / caption / classify / expand / interpret, the gain is ~0% because the steps are knowable. We'd pay 3-4× the per-call cost for ~0% quality gain. That's a bad trade.

### The breakpoint

The pattern flips the day a feature has steps the model needs to *decide* rather than steps we can hardcode. Concrete trigger shape: "find every time the user mentioned Project X across the archive, summarise the trajectory, flag contradictions" — that needs search → synthesis → comparison → flag, with the model deciding when it has enough evidence. That's an agent. It would go in a new file (`src/services/ai/agent.ts`) with explicit max-iteration cap (probably 5-7), per-call timeout (~8s), and total cost ceiling (~$0.50/request).

A secondary trigger: corpus-wide queries that don't fit in a prompt. Today every chain's context fits in a 200K-token window. The day a power user has hundreds of entries per day, "last 3 days" no longer fits, and an agent that paginates through the corpus becomes valuable. That's also when [07-rag](./07-rag.md) becomes relevant — RAG is the simpler answer for "fetch relevant entries before answering," and agents are reserved for "decide what to fetch next."

The four existing chains stay single-chain even after we add agents. Agents earn their existence by needing the loop; chains stay chains because their steps are knowable.

### What wasn't actually a tradeoff

Chain-with-retry (expand's pattern) vs agent loop wasn't a real choice. `expand.ts` retries once with a stricter system prompt when validation fails — that's a re-call of the *same chain* with the same job, not a new step the model chose. An agent would be the model saying "I want to call tool X" or "let me critique my own draft." The retry pattern is a chain-internal recovery, not a step transition; we already have it without becoming an agent.

---

## Summary

"No agents" is the architectural stance of doing the smallest amount of LLM work that solves the problem and keeping control flow in normal code — prefer the boring deterministic pipeline to the autonomous loop. In this codebase that means five single-chain service files (`summarize.ts`, `caption.ts`, `classify.ts`, `expand.ts`, `interpret.ts`), no `agent.ts`, no `orchestrator.ts`, no graph anywhere — and the surrounding patterns (heuristic-first, async fire-and-forget, validation gate, user-override lock) are app-code conventions that run before or after the model, not multi-step LLM reasoning. The constraint that drove it is that the five jobs are knowable in advance: none of them have a "decide what to do next" question for the model. The cost is a ceiling on task complexity — features that genuinely need planning, critique, and revision would have to land as a new service file with explicit iteration cap and cost ceiling, not as a modification to the existing chains.

Key points to remember:
- Five single-chain files, zero orchestrators. App fires LLM; LLM never fires LLM.
- Each chain is one prompt, one response, one parse (or one render, for interpret).
- `expand.ts`'s one-retry-with-stricter-prompt is a chain re-run of the same job, not a model-chosen step.
- A chain re-runs the same job; an agent decides what job to run.
- The day a feature needs the model to choose the next step, the agent goes in a new file with iteration cap, per-call timeout, and cost ceiling.

---

## Interview defense

### What an interviewer is really asking
"Why no agents?" is the most loaded AI question in 2026. Half the field is shipping LangGraph state machines for problems that don't need them; the other half is shipping nothing because they can't decide. The interviewer wants to see I picked single-chain because the *steps are knowable in advance* — not because I was scared of complexity. The clue: I want to enumerate the five jobs (summarize/caption/classify/expand/interpret) and show that none of them have a "decide what to do next" question.

### Likely questions

[mid] Q: Where in the codebase would I look to find an "orchestrator" if there were one?
      A: There isn't one. Each AI service file in `src/services/ai/` and `src/services/todos/` owns one chain end-to-end: get config, build prompt, single call, parse, validate, persist. There's no `agent.ts`, no `orchestrator.ts`, no graph. The patterns that *surround* the LLM — heuristic-first in `heuristicClassify.ts`, fire-and-forget in `scheduleClassify`, validation in `validate.ts`, the `user_overridden_type` lock — are app-code conventions that run before or after the model, not multi-step LLM reasoning. App fires LLM, never LLM fires LLM.

```
[where the orchestrator would live — and doesn't]

  src/services/ai/
    summarize.ts     ← single chain
    caption.ts       ← single chain
    expand.ts        ← single chain (with same-chain retry)
    interpret.ts     ← single chain (markdown out)
    config.ts        ← provider getter
    validate.ts      ← validators
    (no agent.ts)
    (no orchestrator.ts)
    (no graph.ts)

  src/services/todos/
    classify.ts      ← single chain
    heuristicClassify.ts ← regex-only, no LLM
    reconcileMeta.ts ← app code that FIRES the LLM (not LLM-fires-LLM)
```

[senior] Q: What's an example of a feature you considered, then explicitly chose not to build as an agent?
         A: "Plan a vlog from a week of entries with self-critique." The naive agent shape is: outline → critique outline → refine → render plan, with each step a separate LLM call and the model deciding when it's good enough. I chose not to build it because (a) loopd is a single-day app — the editor commits one day's structured composition, and weekly planning doesn't fit the data model; (b) the cost would be 3-4× the per-call cost of summarize at ~$0.04 each, with no quality ceiling I'd hit with a single chain plus better prompts; (c) the failure modes balloon — what does "step 2 returned malformed JSON" recover to? Single-chain summarise plus a future "weekly digest" feature as another single chain handles 95% of what the agent would deliver, at a fraction of the cost and complexity.

```
                  Path taken (single chain summarize)   Alternative (planAVlog agent)
                  ──────────────────────────────────    ─────────────────────────────
$ per feature     1 call × ~$0.04 = $0.04               4 steps × ~$0.04 = $0.16+
                  (outline + critique + refine +
                   render = uncapped: $1+ runaway)
latency           ~3-5s                                  ~15-25s user-visible wait
quality on        ~85% — Sonnet does outline + render   ~90% — small gain over single
single-day task   in one shot with good prompt          chain plus much higher cost
quality on        n/a — weekly doesn't fit data model   the supposed use case;
weekly synthesis                                        but data model doesn't support
                                                        it either
failure modes     parse fail, validate fail, network    same 3 PLUS step-2-fails,
                                                        critique-loops-forever,
                                                        revision-rejects-original
data-model fit    natural — entries are day-grained    awkward — weekly synthesis has
                                                        no canonical surface in SQLite
honest framing    one chain at $0.04 with 85% quality  agent loop at $0.16+ with 90%
                  meets the bar                         quality misses the bar
```

[arch] Q: When *would* you add an agent loop in this codebase? What's the trigger?
       A: The day a feature has steps the model needs to *decide* rather than steps I can hardcode. Concretely: "find every time the user mentioned Project X across the archive, summarise the trajectory, flag contradictions" — that needs search → synthesis → comparison → flag, with the model deciding when it has enough evidence. That's an agent. It would go in a new file (not a modification to the four existing chains), with explicit max-iteration cap, per-call timeout, and cost ceiling. The four single-chain files stay single-chain; agents earn their existence by needing the loop.

```
At "find every time the user mentioned Project X" (corpus + decide-next-step):

  ┌─ Existing 5 chains ──────────────────────────┐
  │ unchanged — summarize / caption / classify / │
  │ expand / interpret all stay single-chain     │
  └─────────────────────────────────────────────┘
              │ (no modifications)
              ▼
  ┌─ NEW: src/services/ai/agent.ts ─────────────┐
  │ max_iterations = 7    ◀── BREAKS FIRST     │
  │                          if uncapped — $$$ │
  │                          runaway is real   │
  │ per_call_timeout_ms = 8000                   │
  │ total_cost_ceiling = $0.50/request          │
  │ intermediate-state log for replay/debug      │
  │ tool registry: search_entries / get_text /  │
  │   compare_entries / flag_contradiction       │
  └─────────────────────────────────────────────┘
              │
              ▼
  ┌─ Tool implementations ──────────────────────┐
  │ search_entries → FTS5/pgvector SQL          │
  │ get_text → SELECT text FROM entries         │
  │ compare_entries → app-side semantic diff    │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: Isn't `expand.ts` essentially a chained call? It picks a system prompt based on type, then validates, then maybe retries with a stricter prompt. Where exactly does single-chain end and agent begin?

A: Partly. But also: at one user with at most three days of context per chain, the steps ARE knowable in advance. `expand.ts` reads `meta.type`, looks up `getSystemPrompt(meta.type)` — that's a deterministic table, not a model decision. The retry with stricter prompt is a re-call of the same chain, not a new step the model chose. An agent is when the model says "I want to call tool X" and the orchestrator runs X and feeds the result back. `expand.ts` never asks the model what to do next; it just runs the chain again with a different system message if validation failed. The line I draw: a chain re-runs the same job; an agent decides what job to run. Adding an agent loop here means more cost, more failure modes, and no capability gain — none of the five jobs need the model to decide. I'd add agents the day the steps stop being knowable in advance, for example the day the user asks the model "show me everything I wrote about Project X" across the full archive.

```
                  Path taken (expand.ts chain-w-retry)  Suggested (count expand as agent)
                  ─────────────────────────────────     ──────────────────────────────────
who decides       app code: getSystemPrompt(type) is    model: "I want to call tool X"
"next step"       a deterministic lookup table
on validate-fail  re-call same chain, stricter prompt   model decides what to try next
who picks         app code reads meta.type              model emits step name
the prompt
debug surface     prompt + response + retry prompt +    N-step trace + intermediate
                  retry response — 4 artifacts          state log per attempt
cost ceiling      bounded at 2 calls ($0.08 worst-case) unbounded without explicit cap
                                                        on iterations + total $
line drawn        chain re-runs same job; agent         expand is a chain (re-runs same
                  decides what job to run               job with stricter prompt) — not
                                                        an agent
"agent" requires  no                                    yes — model-as-decider is the
model-as-decider                                        defining feature
honest framing    expand is a chain with built-in       expand is the closest single-
                  recovery; doesn't become an agent     chain analog to an agent but
                  by retrying once                      still single-chain by definition
```

### One-line anchors
- "Single chain re-runs the same job. An agent decides what job to run."
- "The steps are knowable in advance. That's why no agents."
- "Cost + debuggability + no quality gain = no agent."
- "Agents earn their existence by needing the loop. Today's jobs don't."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the contrast diagram (single chain vs hypothetical agent) from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain "why no agents" to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → name 2 single-chain anchors and the absence of any agent file
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

Someone proposes a "daily reflection agent" that loops over the day's entries with thought/action/observation: read entry → identify themes → group todos → propose tomorrow's pinned items, with the model deciding when it has enough evidence. Walk your one-paragraph rebuttal grounded in this codebase: why isn't this a fit for the existing single-chain shape, what would a fit-for-purpose version look like (single chain or agent?), where would it land file-wise, and what cost ceiling would you set?

Write your answer. 3–5 sentences minimum. Then open `src/services/ai/summarize.ts` L42–L105 and `src/services/todos/expand.ts` L211–L266 to compare.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/expand.ts:expandTodo` (the chain-with-retry that's the *closest* to an agent in the codebase) to support what exists
→ Point to where a real agent would land (a new `src/services/ai/agent.ts` with iteration cap + per-call timeout + cost ceiling) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly (or correctly named that no agent file exists)
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0). Agents are intentionally absent — anchored on the closest single-chain sites.
Updated: 2026-05-10 — bumped chain count from 4 to 5 (interpret added; still no agents).
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block.
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
