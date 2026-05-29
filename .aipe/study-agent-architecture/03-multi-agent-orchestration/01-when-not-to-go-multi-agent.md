# When not to go multi-agent — the boundary

**Industry name(s):** Single-agent-first design, multi-agent boundary, topology overhead
**Type:** Industry standard

> The single-agent loop with better tools beats the multi-agent topology in almost every case. Multi-agent earns its keep on two narrow conditions: one agent's context window is the bottleneck, OR the work genuinely splits across two sub-domains one agent can't reason about together. Until both walls have been hit, "split into multiple agents" is a refactor in search of a problem.

**See also:** → [`../01-reasoning-patterns/01-chains-vs-agents.md`](../01-reasoning-patterns/01-chains-vs-agents.md) (the boundary one step in) · → [`../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md`](../../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md) (single-agent primer) · → [`../../study-ai-engineering/04-agents-and-tool-use/06-error-recovery.md`](../../study-ai-engineering/04-agents-and-tool-use/06-error-recovery.md) (the failure modes that compound across agents)

---

## Why care

### Move 1 — The grounded scenario

You've shipped a single agent that classifies todos, retrieves related history, and writes a coaching note. It works, but the prompts are getting long — you keep adding "but if the todo is study-flavoured, do X; if it's reflect-flavoured, do Y" instructions, and the agent's reasoning is leaking between the two sub-tasks. A teammate suggests: "split this into two agents — one specialist per type — and add a supervisor agent that routes between them. Each specialist gets a focused prompt and a cleaner context window."

It sounds clean. It is not clean. You now have three agents to debug, two inter-agent handoffs that can fail, a coordination layer to evaluate, and the failure-mode count went from five (single-agent error recovery) to fifteen-plus (per agent, per handoff, per coordination step). And you didn't actually solve the original problem — you can get the same separation of concerns by adding two structured-output fields to the single agent's prompt and one TypeScript branch in the orchestrator.

### Move 2 — Name the question the pattern answers

That when-does-splitting-into-agents-help question is what the multi-agent boundary answers. Not "is multi-agent more capable" (it's strictly more capable on specific shapes; usually it's just more expensive) — just *given THIS specific feature, does the cost of coordination buy enough capability to be net positive*. The answer is almost always no, and a senior engineer's job is to keep recognising that.

### Move 3 — Why answering that question matters

**What breaks if you go multi-agent prematurely:** every coordination boundary is a new failure mode, a new eval target, a new debug surface, and a new cost line item. The team that splits a working single agent into a supervisor + two workers usually spends the next month re-implementing the single agent's behaviour distributed across three loops, plus a coordination layer that didn't exist before. The team that wanted "separation of concerns" gets coordination overhead instead. The single-agent loop with structured-output sub-fields gives the same separation with no coordination.

### Move 4 — Concrete before/after

Wrong shape — multi-agent for a problem that didn't need it:
- Single agent works; prompt is getting long
- Refactor: supervisor + classifier-specialist + writer-specialist
- LLM calls: ~3× the original (supervisor's routing call + each worker's call)
- Failure modes: supervisor mis-routes; classifier-specialist returns format the writer-specialist can't parse; handoffs lose context between calls
- Eval: now three trajectories to evaluate instead of one
- Net capability gain: none — the original agent's job is unchanged, just distributed

Right shape — single agent with better structure:
- Same agent; add two structured-output fields (`primary_type`, `requires_specialist_treatment`)
- Orchestrator branches deterministically on those fields if needed
- LLM calls: same as before
- Failure modes: same five as the single-agent baseline (see [`../../study-ai-engineering/04-agents-and-tool-use/06-error-recovery.md`](../../study-ai-engineering/04-agents-and-tool-use/06-error-recovery.md))
- Net capability gain: same outcome at one-third the calls

### Move 5 — The one-line summary

Single agent + structured output + a few deterministic branches beats multi-agent until you hit one of the two real walls — context window OR genuine sub-domain split. Most "let's split into multiple agents" instincts are solved by better prompts, not more agents.

---

## How it works

### Move 1 — The mental model

```
   the topology cost curve
   ───────────────────────

   complexity →

   chain  ──▶  single agent ──▶  multi-agent topology
              (ReAct + tools)    (supervisor / pipeline / fan-out / debate)
              │                   │
              │                   │  COORDINATION
              │                   │  overhead starts here
              │                   │
              ▼                   ▼
   capability flat               capability +X%
   (predictable shape)            ONLY for two narrow conditions
                                  (context wall, sub-domain wall)

   most "multi-agent would be better" claims live at the right edge
   without having hit either wall. The capability bump never arrives.
```

The mental model is: each step right is *strictly* more complexity, more cost, more failure modes. You only justify the next step by showing that the *previous shape stopped working* — not by predicting that the next shape will work better. The asymmetry is intentional: the multi-agent shape has to earn its complexity against the agent-with-better-tools alternative every single time.

### Move 2 — The layered walkthrough

**Layer 1 — the two real walls (and only the two).** A single agent stops being enough only when you've hit one of two specific failure modes. Anything else is solved by better tools, better prompts, or better orchestration of a single agent.

```
   Wall 1 — Context window
   ───────────────────────
   The single agent's effective context (system prompt + tools + accumulated
   trajectory + retrieval) consistently approaches or exceeds the 80% lost-
   in-the-middle threshold for the model you're using. Splitting into a
   supervisor + workers shards the context naturally — each worker sees
   only what's relevant to its sub-task.

   The honest test: have you measured token counts on the bottleneck
   agent's trajectory at steady state? If you haven't measured, you
   haven't hit Wall 1.

   Wall 2 — Sub-domain split
   ─────────────────────────
   The work genuinely spans sub-domains where the reasoning patterns
   are different enough that one prompt cannot cover both without
   degrading on either. A code reviewer + a security reviewer + a perf
   reviewer is the canonical example — different evaluation criteria,
   different reference frames, different tool sets.

   The honest test: can you write ONE system prompt that addresses
   both sub-domains, plus structured-output fields for each? If you
   can, you haven't hit Wall 2.
```

For most production codebases, neither wall has been hit. The instinct to split into agents usually comes from "the prompt is getting long," which is solved by better structuring of the prompt and the outputs — not by introducing a coordination layer.

**Layer 2 — the four things to try BEFORE going multi-agent.** When a single agent feels like it's straining, work down this list. Each rung is cheaper than the next; each rung covers a meaningful fraction of "we need multi-agent" instincts.

```
   The four rungs before the multi-agent ladder
   ────────────────────────────────────────────

   1. Add structured-output sub-fields.
        If the agent is mixing concerns, ask for them as separate fields
        in one output. ("primary_intent", "secondary_concerns", "risk_flags".)
        Cost: zero LLM calls; one schema change.

   2. Split into smaller chains.
        If "agent" is just because someone wrote one mega-prompt, two
        single-purpose chains in sequence (or a chain + an agent) is
        usually clearer. Cost: refactor a few files.

   3. Better tools.
        If the agent's struggle is "it can't see X," give it a tool that
        retrieves X. ReAct + better tools beats multi-agent for most
        capability gains. Cost: one tool implementation + prompt change.

   4. Per-step deterministic orchestration.
        If the path has knowable phases (intake → analysis → decision),
        let your code orchestrate the phases and put a single agent
        inside the one phase that genuinely needs autonomy. Cost: an
        orchestrator.
```

After all four rungs have been tried in earnest, AND one of the two walls is measured, multi-agent is on the table. Until then it's a refactor in search of a problem.

**Layer 3 — what multi-agent actually costs that internet folklore underestimates.** The cost is not just "more LLM calls." It's the coordination layer:

```
   the five hidden costs of multi-agent
   ────────────────────────────────────

   1. Inter-agent handoff payloads
        Each handoff is a serialization → deserialization → context
        reconstruction round-trip. A worker agent never sees the same
        context the supervisor saw; you're paying tokens to summarize.

   2. Coordination failure modes
        Single agent: 5 failure modes (see study-ai-engineering's
        error-recovery file). Multi-agent: 5 per agent + N per handoff
        + coordination-level loops + agreement protocols. Easily 15+.

   3. Trajectory eval × number of agents
        You can no longer ask "did the agent take a reasonable path?"
        You ask it per agent, plus "did the supervisor route correctly?"
        plus "did the handoffs preserve intent?" Multi-objective eval.

   4. Debug as distributed-systems problem
        A bad final output could be a worker's mistake, a supervisor's
        mis-route, or a handoff's lost context. Without trace
        instrumentation across agents, every bug is a needle hunt.

   5. Cost variance widens
        Single-agent cost is bounded by MAX iterations × per-call. Multi-
        agent cost is bounded by every agent's MAX × per-call × the
        coordination depth. Predicting steady-state spend is harder.
```

Notice none of those costs are about LLM calls being expensive (they're not, at the scale of a single user request). They're about the system being a distributed system, with everything that implies. Multi-agent is a distributed-systems pattern. Treat it as one.

### Move 3 — The principle

Multi-agent is a coordination pattern, not a "more capable agent" pattern. It earns its keep when one of two walls has been hit and the four single-agent improvements have all been tried. Until then, "split into agents" is the same shape as "split this monolith into microservices because the file is long" — usually an answer to a problem that better structure would have solved.

---

## When not to go multi-agent — diagram

```
┌─ Decision flow: do I really need multiple agents? ──────────────────────────┐
│                                                                             │
│   Single agent feels strained                                                │
│         │                                                                    │
│         ▼                                                                    │
│   Have I tried structured-output sub-fields?                                │
│         │                                                                    │
│    ┌────┴────┐                                                              │
│    │  no     │  yes                                                          │
│    ▼         ▼                                                              │
│  TRY THAT  Have I tried splitting into smaller chains?                       │
│  FIRST     │                                                                 │
│            ┌──┴───┐                                                          │
│            │ no   │ yes                                                      │
│            ▼      ▼                                                          │
│         TRY     Have I tried better tools for the single agent?              │
│         THAT    │                                                            │
│                 ┌──┴───┐                                                     │
│                 │ no   │ yes                                                 │
│                 ▼      ▼                                                     │
│              TRY      Have I tried per-phase deterministic orchestration?    │
│              THAT     │                                                      │
│                       ┌──┴───┐                                               │
│                       │ no   │ yes                                           │
│                       ▼      ▼                                               │
│                    TRY      Have I MEASURED one of the two walls?            │
│                    THAT     (context-window OR sub-domain split)             │
│                             │                                                │
│                          ┌──┴───┐                                            │
│                          │ no   │ yes                                        │
│                          ▼      ▼                                            │
│                       NO       MULTI-AGENT IS NOW JUSTIFIED.                 │
│                       (you      Pick a topology: supervisor-worker,           │
│                        haven't  pipeline, fan-out, debate, swarm, graph.      │
│                        earned   See sub-section files (this guide skips them │
│                        it)      for codebases that don't need them yet).      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case A — buffr is multi-agent-free and the boundary holds aggressively.**

The relevant code surface: every chain in `src/services/ai/` is single-shot; the orchestrators (`compose.ts`, `reconcileMeta.ts`) are deterministic TypeScript; there is no agent loop anywhere in the codebase (the boundary one step in — see [`../01-reasoning-patterns/01-chains-vs-agents.md`](../01-reasoning-patterns/01-chains-vs-agents.md) — hasn't been crossed). So the multi-agent question is doubly moot: buffr hasn't built a single agent, let alone hit the walls that would justify multiple.

The closest thing buffr exercises to the *spirit* of multi-agent — separating concerns by giving each chain one job — already lives in the workflow shape. Five single-purpose chains (`summarize`, `caption`, `expand`, `classify`, `interpret`) is the chain-level analogue of "single-responsibility agent": each chain has one job, the schema is its contract, errors isolate per chain. That covers the same "I want focused prompts and clean context windows" instinct without paying any coordination cost, because the orchestration is in TypeScript and the chains don't talk to each other.

**Line ranges to read:** every chain file in `src/services/ai/` (~L1–L30 of each) for the per-chain single-job discipline; `src/services/ai/compose.ts` (~L20–L80) for how single-purpose chains compose without inter-chain handoffs.

---

## Elaborate

### Where this pattern comes from

The single-agent-first discipline was codified in Anthropic's "Building effective agents" (2024) post — the same post that drew the chain-vs-agent boundary — and reinforced by a year's worth of public post-mortems from teams who shipped multi-agent topologies and rolled them back to single-agent + better tools. Reading order: the Anthropic post first, then the LangChain "do you need multi-agent?" essays, then any of the multi-agent framework docs (CrewAI, AutoGen, LangGraph multi-agent) for what the topologies actually look like when you DO hit the walls.

### The deeper principle

Coordination cost is real and underestimated. Every distributed system makes the local case (one node, one process) more complex in exchange for properties (scale, fault isolation, parallelism) that the local case can't deliver. Don't pay the distributed cost until you need the distributed property. Multi-agent topologies are distributed systems built on top of LLMs.

### Where this breaks down

For the genuine multi-agent use cases — Anthropic's research-assistant, codebases requiring multiple distinct expertise areas reviewing the same artifact, swarms exploring a problem space in parallel — single-agent doesn't just feel strained; it provably can't deliver the property. Once a wall is measured (not predicted), the topology earns its keep. The mistake is reaching for the topology before measuring.

### What to explore next

- [`../01-reasoning-patterns/01-chains-vs-agents.md`](../01-reasoning-patterns/01-chains-vs-agents.md) — the boundary one step in. You have to cross that one before this one is even relevant.
- [`../../study-ai-engineering/04-agents-and-tool-use/`](../../study-ai-engineering/04-agents-and-tool-use/README.md) — the full single-agent mechanics (tools, ReAct, memory, error recovery). Most "I need multi-agent" instincts are actually "I haven't fully exercised single-agent yet."
- Anthropic's "Building effective agents" (2024) — required reading. Most public multi-agent post-mortems cite this.

---

## Tradeoffs

```
┌─────────────────────────┬────────────────────────────┬──────────────────────────────┐
│ Cost dimension          │ Single agent + better tools│ Multi-agent topology         │
├─────────────────────────┼────────────────────────────┼──────────────────────────────┤
│ LLM calls per task      │ MAX iterations × 1 agent   │ MAX × per-agent × coord depth │
│ Failure modes           │ 5 (tool error, timeout,    │ 5 per agent + N per handoff + │
│                         │ loop, bad schema, max-iter)│ coordination loops + agreement│
│ Eval surface            │ 3 (trajectory + tool calls │ 3 per agent + supervisor route│
│                         │ + final output)            │ + handoff preservation         │
│ Debug surface           │ One trace                  │ One trace per agent + handoff │
│                         │                            │ payloads + coord layer logs    │
│ Coordination overhead   │ None                       │ Handoff serialization + ctx   │
│                         │                            │ reconstruction per boundary   │
│ Cost predictability     │ Bounded; measurable        │ Bounded but variance widens   │
│ Capability ceiling      │ What the model can do given│ +X% ONLY if context or sub-   │
│                         │ the tool set               │ domain wall is the real cap   │
└─────────────────────────┴────────────────────────────┴──────────────────────────────┘
```

### What we gave up

By staying single-agent-or-simpler, buffr (and any team using this discipline) gives up the parallel exploration patterns — fan-out across multiple specialist agents, debate-style verifier/critic loops, swarm coordination — that genuinely beat single-agent on a narrow set of problems. We accept that ceiling because the cost of paying for it on problems that didn't need it is higher than the cost of being slightly capability-capped on the problems that do.

### What the alternative would have cost

If buffr had been built multi-agent (say, a supervisor that routes between a "summarizer agent," a "caption agent," and a "todo-handler agent"), every user request would pay coordination cost — supervisor's LLM call to decide which worker to invoke; worker's LLM call to do the actual work; possibly the supervisor's LLM call to integrate results. For a feature set where the routing is deterministic at write time (you always summarize then caption; you always classify before maybe expanding), that's pure overhead. The codebase would be larger, the eval surface tripled, and the user-visible result identical.

### The breakpoint

The single-agent → multi-agent breakpoint is "I have measured one of the two walls (context-window overflow at steady state OR a genuine sub-domain split that one prompt can't cover without degrading), AND I have tried all four single-agent improvements (structured output sub-fields, smaller chains, better tools, per-phase deterministic orchestration) in earnest." Until both halves of that condition are true, the multi-agent topology is a refactor without a forcing function.

For buffr the breakpoint is doubly distant — the codebase hasn't crossed into the single-agent shape yet, let alone hit the walls that would justify going further.

---

## Tech reference (industry pairing)

### Anthropic "Building effective agents" (2024)

- **Codebase uses:** the single-agent-first discipline the post codifies. The codebase has internalised the principle to the point of not building a single agent yet.
- **Why it's here:** the canonical 2024–2026 articulation of "earn the next shape." Required reading for anyone arguing for multi-agent.
- **Leading today:** Anthropic's framing — `adoption-leading` for production-engineering decision discipline, 2024–2026.

### LangGraph, CrewAI, AutoGen (for when you DO hit the walls)

- **Codebase uses:** none — not justified yet.
- **Why it's worth knowing:** these are the production frameworks for orchestrating real multi-agent topologies when the walls have been measured. LangGraph is graph-based and works for either single-agent or multi-agent; CrewAI is multi-agent-first; AutoGen is debate-style and conversation-flow oriented.
- **Leading today:** LangGraph for graph-based multi-agent in 2026; CrewAI for "team-of-specialists" framings.
- **Runner-up:** Raw provider SDKs with hand-rolled coordination, when the framework abstraction costs more than the coordination logic.

---

## Summary

### Part 1 — concept recap

The multi-agent boundary lives one step further out than the chain-vs-agent boundary. A single agent with better tools beats a multi-agent topology in almost every case; the topology earns its keep only when one of two walls has been hit — context-window overflow at steady state, OR a genuine sub-domain split one prompt can't cover. Four single-agent improvements (structured-output sub-fields, smaller chains, better tools, per-phase orchestration) cover most "we need multi-agent" instincts before the walls become relevant. Multi-agent is a distributed-systems pattern: every handoff is a new failure mode, every agent multiplies the eval surface, and the debug surface becomes a distributed trace problem. buffr is doubly far from this boundary — the chain-vs-agent boundary hasn't been crossed, so the multi-agent question is moot.

### Part 2 — key points to remember

- Two real walls: context-window overflow, or a sub-domain split a single prompt can't cover without degrading. Anything else is solved by better single-agent design.
- Four rungs to try first: structured-output sub-fields, smaller chains, better tools, per-phase deterministic orchestration.
- Multi-agent is a coordination pattern, not a "more capable agent" pattern. Treat it as a distributed system.
- Eval surface multiplies: not just per-agent trajectory + tools + output, also supervisor routing accuracy and handoff context preservation.
- buffr's single-purpose chains already deliver the "focused prompts, clean context" instinct that drives most multi-agent refactor proposals — at zero coordination cost.

---

## Interview defense

### What an interviewer is really asking

Multi-agent is a 2024–2026 hype area, and an interviewer asking about it is testing one of two things: do you know what the topologies are (knowledge), or do you know when *not* to use them (judgment). The senior signal is the second. "I haven't built multi-agent because I haven't hit the walls" is a stronger answer than naming five topologies you've memorised.

### Likely questions

**Q [mid]:** Why isn't buffr multi-agent? Wouldn't separate agents for summarize, caption, and todo classification be cleaner?

**A:** It would be more code without being cleaner. Each chain in buffr is already single-purpose with one job, one schema, isolated failure mode. That's the separation-of-concerns instinct multi-agent reaches for, delivered at zero coordination cost because the orchestration is in TypeScript and the chains don't talk to each other. Adopting a supervisor + workers topology would add a coordination layer that has to evaluate the same composition my orchestrator does deterministically — and it'd pay LLM calls to do it. The "cleaner" intuition is paying for clarity I already have for free.

```
   single-purpose chains in TS         multi-agent topology
   ───────────────────────────         ─────────────────────
   summarize, caption, expand,         supervisor + summarizer-agent +
   classify, interpret — each one      caption-agent + todo-agent +
   has one job, one schema             handoff payloads + coordination loop

   coordination cost: zero             coordination cost: LLM calls per route
   debug surface: per-chain             debug surface: per-agent + per-handoff +
                                       per-coordination-layer
```

**Q [senior]:** What's the actual capability you give up by staying single-agent?

**A:** Parallel exploration and specialist depth. A fan-out topology (multiple specialist agents working in parallel) genuinely beats sequential single-agent on problems where the sub-tasks are independent and the latency budget matters. A debate topology (verifier + critic + writer) genuinely improves output quality on high-stakes generation where two perspectives catch what one misses. Neither shows up in buffr's feature set — buffr's feature shapes are sequential and don't have a high-stakes-verification need. So the ceiling is fine. The discipline is recognising that the ceiling is fine, rather than pre-building for capability you don't need.

**Q [arch]:** What would the multi-agent refactor cost buffr if it ever became justified?

**A:** Realistically: a supervisor agent (one new LLM call per task to decide routing), at least two specialist agents (one per sub-domain), an orchestration layer above all three, per-handoff context serialization, and a tripled eval surface that buffr hasn't built the first version of yet. The single-agent eval gap (no golden sets, no observability) would have to close before multi-agent could ship responsibly, because multi-agent's three-per-agent eval surface compounds on what's not yet built. The order I'd actually adopt the shapes: chain → single-agent → eval harness → multi-agent if walls are measured. Skipping the eval step is how multi-agent rollouts fail in public.

### The question candidates always dodge

**Q:** Frameworks like CrewAI and LangGraph make multi-agent easy. If it's easy, why wouldn't you reach for it?

**A:** The framework makes the *coordination code* easy. It doesn't make the *coordination problem* easy. CrewAI and LangGraph give you supervisor-worker patterns out of the box, but you still pay every coordination cost: handoff payloads, eval-per-agent, debug-as-distributed-system, cost-variance widening. The framework hiding the wiring doesn't change the cost shape. "Easy to set up" is not the same as "easy to debug at 3am when an agent quietly handed off the wrong context to a worker that produced a confident-but-wrong final output." I'd rather know I needed the topology before I adopt one — even an easy one.

### One-line anchors

- "Single agent + better tools beats multi-agent until one of the two walls is measured."
- "The two walls: context-window overflow OR genuine sub-domain split. Everything else is a better-prompt problem."
- "Multi-agent is a distributed system. Treat it as one."
- "Frameworks make the coordination code easy. They don't make the coordination problem easy."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the topology cost curve from Move 1 (chain → single-agent → multi-agent), label "capability flat" on the chain → agent step, label the two walls (context, sub-domain) on the agent → multi-agent step, and mark where most "we need multi-agent" claims actually sit.

### Level 2 — Explain it out loud

Explain in under 90 seconds the two real walls that justify multi-agent and the four rungs to try before climbing to the multi-agent ladder. Use the phrase "coordination cost" and name at least two of the five hidden costs.

### Level 3 — Apply it to a new scenario

A teammate proposes: "Let's split buffr's `compose.ts` into a supervisor agent that routes between a summary-specialist agent and a caption-specialist agent, so the prompts can be specialised." Walk the test:
- Is buffr even at the single-agent shape yet? (Look at `src/services/ai/compose.ts` and confirm.)
- Have they measured a wall, or are they predicting one?
- Which of the four rungs (structured-output sub-fields, smaller chains, better tools, per-phase orchestration) is the current single-purpose-chain shape already on?

Decide: defend or oppose the refactor, with reference to the file.

### Level 4 — Defend the decision you'd change

Defend or oppose: "buffr should adopt a verifier-critic-writer debate topology for the `interpret` chain — interpret writes a draft, a critic agent reviews it, the writer revises. High-stakes output (long-form reflection) deserves it."

### Quick check — code reference test

Without opening files:
- Which file is buffr's day-summary orchestrator (and is it agentic)?
- How many distinct LLM chains exist in `src/services/ai/`, and what's the principle they each follow?
- What are the two walls that would justify multi-agent?
- Why does single-agent + better tools usually beat multi-agent in production?
