# Chains vs agents — the boundary

**Industry name(s):** Workflow vs agent, deterministic chain vs autonomous loop, chain-first design
**Type:** Industry standard

> A chain is a fixed sequence of LLM calls your code orchestrates; an agent is a loop where the model decides which call comes next. Reach for the chain shape until the model needs to decide the path — then, and only then, reach for the loop.

**See also:** → [`../03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md`](../03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md) · → [`../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md`](../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md) (mechanics primer) · → [`../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`](../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md) (ReAct internals)

---

## Why care

### Move 1 — The grounded scenario

You build a feature that summarizes a user's day. You write `summarize(entry)` — one LLM call, structured output, done. You add a second feature: produce four tonal caption variants from the summary. You write `caption(summary)` — another LLM call. You wire them in TypeScript: `const summary = await summarize(entry); const variants = await caption(summary);`. That's a chain. Two calls, fixed order, the orchestrator is `.then()`. No model anywhere in that pipeline ever needs to decide "what should I do next?" — because *you already know what's next.*

Now imagine a different feature: "Help me figure out why my caption from last week sounds off." There is no fixed sequence of calls. The right next step depends on what the model finds. Maybe it needs to look up the entry the caption was for; maybe it needs to compare against captions from other weeks; maybe it needs to ask the user a clarifying question. The orchestrator can't be written ahead of time because the path is *data-dependent*. That's an agent loop.

### Move 2 — Name the question the pattern answers

That do-I-know-the-steps question is what chains-vs-agents answers. Not "which is more capable" (agents are; that's why they're more expensive) — just *given THIS feature, is the path through the LLM calls knowable at write time, or does it have to be discovered at run time*. The answer determines the shape of the code, the cost envelope, the failure modes, and how you'll evaluate it.

### Move 3 — Why answering that question matters

**What breaks if you pick the wrong shape:** picking an agent when a chain would do gives you all the agent costs (variable number of calls, harder eval, harder debug) and none of the agent benefits (you still know the path; the model is just being asked to confirm it). Picking a chain when an agent is needed gives you brittle code — every path the model might take becomes a hand-coded branch, the codebase fills up with "if the model says X, try Y" logic, and you end up half-building an agent in TypeScript without the agent's clarity. The shape decision is upstream of almost everything else above one model.

### Move 4 — Concrete before/after

Wrong shape — chain where an agent is needed:
- Feature: "diagnose why my caption sounds off"
- Code: 200 lines of `if (modelSaid === "compare with last week") { ... }` branches, each calling more chains
- Adding a new diagnosis path = adding another branch
- Debug cost: high (the path through 200 lines of branches is non-obvious)
- Eval: every branch needs its own golden set

Wrong shape — agent where a chain is enough:
- Feature: "summarize the day, then write captions"
- Agent loop runs: Thought "I should summarize first." Action: summarize. Observation: AISummary. Thought: "Now I should caption." Action: caption. Done.
- Cost: ~2x the LLM calls (the meta-reasoning steps), variable termination, harder to cache
- Debug: every output is a trace, not a value

Right shape:
- Diagnosis feature → agent loop (the path is data-dependent)
- Summarize-then-caption → chain (the path is fixed)
- Pick by whether the steps are knowable; never pick by ambition

### Move 5 — The one-line summary

Knowable path → chain; data-dependent path → agent. Pick on whether the steps can be enumerated at write time, not on which sounds more sophisticated.

---

## How it works

### Move 1 — The mental model

```
   the two shapes, side by side

   ┌─ Chain (workflow) ──────────────────┐    ┌─ Agent (autonomous loop) ──────────┐
   │                                     │    │                                    │
   │   input                              │    │   input                             │
   │     │                                │    │     │                              │
   │     ▼                                │    │     ▼                              │
   │   step 1 (LLM call)                  │    │   Thought  (LLM call: what next?)   │
   │     │                                │    │     │                              │
   │     ▼                                │    │     ▼                              │
   │   step 2 (LLM call)                  │    │   Action   (your code: run tool)    │
   │     │                                │    │     │                              │
   │     ▼                                │    │     ▼                              │
   │   step 3 (LLM call)                  │    │   Observation (tool result)         │
   │     │                                │    │     │                              │
   │     ▼                                │    │     └────── loop or stop ──────┐    │
   │   output                             │    │                                │   │
   │                                     │    │   output                        │   │
   │   YOUR CODE knows the order          │    │   THE MODEL decides the order   │   │
   │   number of calls: fixed             │    │   number of calls: 1–N variable  │   │
   │                                     │    │                                  │   │
   └─────────────────────────────────────┘    └────────────────────────────────────┘
```

The mental model is exactly that simple. Everything else flows from "who decides what runs next." For ReAct internals see [`../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`](../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md); this file is about *placement* (when to use which shape), not mechanics.

### Move 2 — The layered walkthrough

**Layer 1 — the test you apply when you're not sure.** Three questions, in order. If the answer to question 1 is yes, build a chain. If you need to get to question 3 to feel comfortable building a chain, you actually need an agent.

```
   The three-question test
   ───────────────────────

   1. Can I enumerate the steps right now?
        yes → chain. Stop.
        no  → keep going.

   2. Is the path data-dependent ONLY in a way I can encode as branches?
      (e.g. "if classification was X, also run expansion")
        yes → chain with a deterministic branch. Stop.
        no  → keep going.

   3. Does the next step depend on what the model FINDS,
      in a way I can't pre-enumerate?
        yes → agent loop. Build it.
        no  → revisit question 1.
```

buffr's `compose.ts` answers yes at question 1 (summarize then caption, fixed). The `reconcileMeta.ts` orchestrator answers yes at question 2 (classify always; expand only if `type ≠ 'todo'` — a deterministic branch on a typed value). Neither reaches question 3. The day a chain in buffr genuinely needs question 3 — "I need to retrieve similar past todos before re-classifying, but only IF the first classification was low-confidence AND only against similar-type todos, which I won't know until I see the first result" — that's when the chain shape stops working.

**Layer 2 — the cost shape of each.**

```
   What you pay for each shape
   ───────────────────────────

   Chain                                  Agent
   ─────────                              ─────
   LLM calls       fixed (N per task)     LLM calls       variable (1 to MAX)
   total cost      knowable               total cost      bounded by MAX × cost
   total latency   sum of N calls          total latency   sum of executed loop turns
   cache surface   per-step exact match    cache surface   harder (trajectory varies)
   debug           inspect each step       debug           inspect Thought traces
   eval            per-chain golden set    eval            trajectory + final + tool-call
                                                            accuracy (3 evals, not 1)
```

The eval row is the one most engineers underestimate. A chain has one golden set per chain: same input → expected output. An agent has *three* eval targets — did the trajectory take a reasonable path, did each tool call have the right args, was the final output correct — and they're partially independent (a wrong-trajectory agent can still produce a correct final answer; that's signal you want). For buffr, "no eval today" is already a flagged gap on five chains; adopting an agent shape would triple the eval surface before the existing gap was closed.

**Layer 3 — the breakpoint, and what to do FIRST when you hit it.** The chain → agent breakpoint isn't always "ship an agent." Often it's "improve the chain so you don't need one yet." Three things to try before reaching for the loop, in order:

```
   Before you upgrade from chain to agent, try:
   ────────────────────────────────────────────

   1. Better structured output on the chain.
        If the chain returns more structured information (confidence
        scores, possible alternates, a "needs human review" flag), the
        ORCHESTRATOR can branch on it deterministically. You bought the
        agent's flexibility without the loop.

   2. A second deterministic step.
        If the chain output names what the next step should be (e.g.
        classify → "this is ambiguous; also retrieve similar past
        todos"), and you encode that branch in your orchestrator, you're
        still in question 2 of the three-question test.

   3. Hand-picked retrieval.
        buffr's principle #11 ("no RAG until provably needed") is this
        principle applied to retrieval. Hand-picked context covers
        feature breadth without an agent's retrieval loop.

   Only after all three fall short: build the agent loop.
```

For a future buffr feature like "diagnose why this caption sounds off," every one of those tries probably fails — diagnosis is open-ended, the path is genuinely data-dependent, the orchestrator can't pre-enumerate the branches. That's where the agent loop earns its keep. The point of the three tries is that *most chain → agent decisions don't survive them*, which is why the agent shape is rarer than internet folklore suggests.

### Move 3 — The principle

The shape decision is who-decides-next. Code that knows what comes next is a chain. Code that needs the model to decide what comes next is an agent. Don't reach for the loop until the chain stops working; the agent shape is more capable AND more expensive AND harder to debug, and the path you wish you had is usually a better chain, not a worse agent.

---

## Chains vs agents — diagram

```
┌─ Decision flow: which shape does this feature want? ────────────────────────┐
│                                                                             │
│   New feature                                                               │
│         │                                                                   │
│         ▼                                                                   │
│   Can I enumerate the steps now?                                            │
│         │                                                                   │
│    ┌────┴────┐                                                              │
│    │  yes    │     no                                                       │
│    ▼         ▼                                                              │
│  CHAIN     Is the path data-dependent only as enumerable branches?          │
│            │                                                                │
│       ┌────┴────┐                                                           │
│       │ yes     │ no                                                        │
│       ▼         ▼                                                           │
│     CHAIN     Have I tried: structured output, second step, hand-picked?    │
│     (with     │                                                             │
│     branch)   ┌──┴────┐                                                     │
│               │ all   │ all                                                 │
│               │ work  │ fail                                                │
│               ▼       ▼                                                     │
│             CHAIN   AGENT LOOP                                              │
│             (better   build it; cross-ref study-ai-engineering for          │
│              shape)   ReAct + tool-calling + error-recovery mechanics       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

   buffr sits firmly in the top-left CHAIN branch. Every step in every
   chain is enumerable; the one branch we have (reconcileMeta's "expand
   if type ≠ 'todo'") is enumerable too.
```

---

## In this codebase

**Case A — buffr is a pure workflow/chain codebase.**

**Files:**
- `src/services/ai/compose.ts` — the day-summary orchestrator. Reads `ai_summaries` cache (`getCachedSummary(userId, date)`), and on miss runs `summarize → caption` in fixed order. No model is asked "what should I do next" anywhere in this file. Pure question-1 chain.
- `src/services/todos/reconcileMeta.ts` — the todo orchestrator. Calls `heuristicClassify(text)` first (fast path, returns `'todo' | null`); on `null` calls the LLM classifier; if the resulting type isn't `'todo'`, calls `expand`. The branch on `type !== 'todo'` is a deterministic branch on a typed value — that's the question-2 chain.
- All five chain files in `src/services/ai/` — `summarize.ts`, `caption.ts`, `expand.ts`, `classify.ts`, `interpret.ts`. Each is a single LLM call with structured output (or markdown for `interpret`); none emits tool requests; none loops. They're the question-1 primitives the orchestrators compose.

There is no file in buffr where a model decides the next step. The classifier's heuristic-first dispatch is sometimes described casually as "routing," but it's deterministic dispatch (`if (heuristic !== null) return heuristic; else call LLM`) — the same shape as a CDN deciding cache-vs-origin, not the same shape as an LLM-routed agent. For LLM-routed dispatch mechanics, see [`../../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md`](../../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md); buffr doesn't exercise that pattern.

**Line ranges to read:** `compose.ts` (~L20–L80) for the cache-or-compute branch + the summarize→caption sequence; `reconcileMeta.ts` (~L40–L120) for the classify-then-conditionally-expand branch; `heuristicClassify.ts` (~L20–L80) for the fast-path regex set that proves the routing is deterministic, not agentic.

---

## Elaborate

### Where this pattern comes from

The chain-vs-agent distinction was codified in Anthropic's "Building effective agents" (2024) post — required reading for anyone making this call. The framing pre-dates the post (LangChain's chain abstraction is from 2022, and the "agent loop" model goes back to ReAct in 2022), but the post is the cleanest articulation of "don't reach for the agent until you have to."

### The deeper principle

Predictability and flexibility trade off. Chains predict (you know what runs, when, in what order, at what cost). Agents adapt (the model decides). Choosing chains by default is the same engineering instinct that prefers explicit code to clever metaprogramming — both work; one is debuggable next year.

### Where this breaks down

For genuinely open-ended tasks — "research this question," "debug this codebase," "diagnose this user complaint" — a chain isn't just less capable; it's the wrong shape. The path through the task is the task. There's no way to enumerate it, no structured output that captures it, no second deterministic step that covers it. That's the territory where the agent loop earns its complexity. The mistake is reaching for that complexity *before* you're in that territory.

### What to explore next

- [`../03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md`](../03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md) — the next boundary out: even codebases that DO have an agent loop usually shouldn't have multiple agents.
- [`../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md`](../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md) — the primer focused on mechanics rather than the architectural boundary.
- [`../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`](../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md) — the standard agent loop shape (Thought / Action / Observation) you'd build if buffr ever crossed the boundary.

---

## Tradeoffs

```
┌─────────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Cost dimension      │ Chain (buffr's choice)       │ Agent loop                   │
├─────────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Calls per task      │ Fixed (N known at write time)│ Variable (1 to MAX cap)       │
│ Total cost          │ Knowable; budget at design    │ Bounded by MAX × per-call,    │
│                     │ time                          │ measure to optimise          │
│ Debug surface       │ Inspect each step's I/O       │ Inspect Thought traces +      │
│                     │                               │ tool-call args + Observations │
│ Eval surface        │ 1 golden set per chain        │ 3: trajectory + tool-call     │
│                     │                               │ accuracy + final output        │
│ Cache strategy      │ Per-step exact-match (cheap)  │ Per-trajectory (harder; agents│
│                     │                               │ rarely traverse identically)  │
│ Failure recovery    │ Retry the failed step         │ Five distinct failure modes   │
│                     │                               │ (see study-ai-engineering's   │
│                     │                               │ error-recovery file)          │
│ Capability ceiling  │ Whatever the orchestrator     │ Whatever the model can decide  │
│                     │ author imagined               │ given the toolset              │
└─────────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### What we gave up

By staying in the chain shape, buffr cannot adapt to inputs whose ideal handling can't be enumerated. A feature like "diagnose why this caption sounds off" — open-ended, path-data-dependent — has no clean place in the chain architecture. We'd have to either build it as an agent (and pay the costs above) or scope the feature down until it fits the chain shape (which is what we'd actually do, because the current feature set fits).

### What the alternative would have cost

If we'd started buffr with the agent shape (a single ReAct loop with `summarize_day`, `make_captions`, `expand_todo` as tools), every chain would run inside a `Thought → Action → Observation` envelope. Each user-visible operation would cost ~2× the LLM calls (the meta-reasoning steps), termination would be variable, and the eval surface would triple before the codebase had any evals at all. None of that buys anything for the current feature set, which is enumerable at write time.

### The breakpoint

The chain → agent breakpoint is "I cannot enumerate the steps for this feature, AND structured-output / second-deterministic-step / hand-picked retrieval all fail to cover it." Until all three fail, the chain shape is the right shape. A concrete candidate: if buffr ever ships a "diagnose this week" feature where the user asks a free-form question about their journal, the path through retrieval + classification + reasoning isn't enumerable; that's the feature that would force the loop. None of the planned features cross that line.

---

## Tech reference (industry pairing)

### Anthropic's "Building effective agents" framing

- **Codebase uses:** the explicit "chain by default, agent only when justified" decision-discipline that the post codifies. Buffr's `compose.ts` and `reconcileMeta.ts` are textbook applications.
- **Why it's here:** the cleanest articulation in 2024 of when to reach for the loop. Required reading before building one.
- **Leading today:** Anthropic's post itself — `adoption-leading` for the decision framework, 2024–2026.
- **Why it leads:** comes from the team that ships frontier models; speaks to the cost shape from the inside.

### LangGraph / LangChain LCEL

- **Codebase uses:** not used in buffr. Plain TypeScript orchestration is enough at buffr's chain count (two orchestrators, five chains).
- **Why it's worth knowing:** when chain count grows past ~10–15, a graph abstraction starts to earn its keep. The chain shape doesn't stop being correct — the orchestration tool changes.
- **Leading today:** LangGraph for graph-based orchestration of either chains or agents.
- **Runner-up:** Plain code (what buffr does); CrewAI for multi-agent topologies.

---

## Summary

### Part 1 — concept recap

The chain-vs-agent boundary is about *who decides what runs next*. A chain is your code orchestrating a fixed sequence of LLM calls; an agent is a loop where the model picks the next call. The three-question test — can I enumerate the steps, is the branching enumerable, can I pre-encode the path — decides the shape; the agent loop is for features that fail all three. buffr's two orchestrators (`compose.ts`, `reconcileMeta.ts`) are textbook chains: every step is enumerable, the one branch is deterministic, no model anywhere is asked what to do next. The shape is correct for the current feature set; the breakpoint that would flip it is a genuinely open-ended feature like free-form diagnosis, which isn't planned.

### Part 2 — key points to remember

- Chain by default. The agent shape is more capable AND more expensive AND harder to debug; pick it only when forced.
- The three-question test: enumerable steps → chain; enumerable branches → chain with branch; otherwise try structured output / second step / hand-picked retrieval before reaching for the loop.
- An agent's eval surface is three (trajectory + tool-call accuracy + final output), not one. Adopting an agent triples the eval debt.
- buffr's heuristic-first classifier dispatch is deterministic routing, not agentic routing — the same shape as a CDN cache check, not a tool-routing agent.
- The breakpoint that would force a buffr agent loop is a feature whose path is genuinely data-dependent in a way no structured output or pre-encoded branch covers (e.g. open-ended diagnosis). None of the planned features cross that line.

---

## Interview defense

### What an interviewer is really asking

"Why didn't you use an agent for this?" is a calibration question. Engineers who haven't shipped agents tend to either dismiss the question (defensive) or overclaim (they pretend they have one). The senior answer is the boundary: name the test you applied, show that the feature failed the agent's test, and name the specific feature that would flip it.

### Likely questions

**Q [mid]:** Why is buffr a workflow and not an agent?

**A:** Because every step in every chain is enumerable. `compose.ts` runs summarize then caption — fixed order, fixed count, no decision the model has to make about "what next." `reconcileMeta.ts` runs classify then maybe expand — the branch is on a typed value, encodable in TypeScript. There's no input shape under which the orchestrator would need a model's help to decide the next step. Picking an agent for code I can already enumerate would buy me variable-call-count costs and three eval surfaces for no capability gain.

```
   the test, applied to buffr's two orchestrators
   ──────────────────────────────────────────────
   compose.ts:        enumerate? yes (summarize → caption). Chain.
   reconcileMeta.ts:  enumerate? yes, with a branch on type. Chain.
```

**Q [senior]:** What would force you to refactor to an agent?

**A:** A feature whose path is data-dependent in a way I can't enumerate. The concrete candidate I'd be most likely to ship is open-ended diagnosis — "Why does this caption sound off?" — where the model needs to decide whether to retrieve past captions, compare against the source entry, run a critique step, or ask a clarifying question. The branches aren't enumerable; structured output doesn't help because the path isn't a discrete classification; hand-picked retrieval can't anticipate every direction. That's where the loop earns its complexity. None of buffr's planned features cross that line, which is why I haven't built one.

```
   the chain → agent breakpoint
   ────────────────────────────
   knowable path           ▶ chain
   data-dependent branches ▶ chain with branch
   open-ended, model       ▶ AGENT LOOP
   needs to discover path
```

**Q [arch]:** Some of these "chains" call deterministic helpers — the heuristic-first classifier dispatch, for example. Isn't that already a routing agent?

**A:** No, and the distinction matters. The classifier's `heuristic → LLM fallback` is fast-path/slow-path dispatch: `if (heuristic !== null) return heuristic; else call LLM`. The orchestrator picks the path based on whether the regex set matched — there's no model in the dispatch loop. An LLM-routed agent would be: model decides which tool to call given the input. That's a different shape; see the study-ai-engineering tool-routing file for the comparison. Same word ("routing"), different decision-maker — one is code, one is a model.

### The question candidates always dodge

**Q:** Have you actually built an agent, or are you just defending not building one?

**A:** I haven't shipped an agent in production. I've designed buffr to NOT need one, which is a different skill. The honest answer is that the chain shape covers the current feature set and the planned features, and the breakpoint that would force the loop is one I'd recognise (open-ended path). The thing I'd most want to learn by building a single agent is the eval trio — trajectory + tool-call accuracy + final output — because the per-chain golden-set discipline I haven't shipped yet would have to triple before an agent could ship responsibly. If I built one tomorrow, the eval harness is what I'd build first.

### One-line anchors

- "Knowable path → chain. Data-dependent path → agent. Pick on the shape of the question, not on which sounds more sophisticated."
- "Don't reach for the loop before the chain stops working — that's the whole discipline."
- "An agent's eval surface is three, not one. Adopting one triples the eval debt before you even start."
- "buffr's heuristic-first dispatch is deterministic routing, not agentic. Same word, different decision-maker."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the side-by-side from Move 1: chain (input → step → step → step → output, your code knows the order) vs agent (input → Thought → Action → Observation → loop, the model decides). Label which decision-maker is in each.

### Level 2 — Explain it out loud

Explain in under 90 seconds why buffr is a chain and what would force it to be an agent. You should use the phrase "knowable path" and you should name a concrete hypothetical feature that crosses the line.

### Level 3 — Apply it to a new scenario

A new requirement: buffr should add a "interpret this week" feature that produces a long-form reflection on the last 7 days, drawing on whichever entries are most relevant. Walk the three-question test:
- Can you enumerate the steps?
- Is the branching enumerable?
- Have you tried structured output / second step / hand-picked retrieval?

Decide: chain or agent? Defend with reference to `src/services/ai/interpret.ts` (the current single-shot interpret chain) and `src/services/ai/compose.ts` (the orchestrator pattern).

### Level 4 — Defend the decision you'd change

Defend or oppose: "buffr's `reconcileMeta.ts` should become a single-agent loop where the model decides whether to retrieve similar past todos before classifying. That would catch the ambiguous cases the LLM currently mis-labels."

### Quick check — code reference test

Without opening files:
- Which file is buffr's day-summary orchestrator?
- Which file is the todo orchestrator?
- Where does the only deterministic branch in either orchestrator live?
- What concrete feature would force buffr to adopt the agent loop?
