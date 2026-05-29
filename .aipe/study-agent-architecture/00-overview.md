# Agent architecture — overview of buffr's agent surface

**Codebase shape:** **workflow / chain.** No autonomous loops, no tools, no ReAct, no RAG, no multi-agent. The 5 LLM chains in `src/services/ai/` are single-shot calls; the orchestration is deterministic application code (`compose.ts`, `reconcileMeta.ts`), not an agent that decides its own next step.

## What lives above the model in buffr (and what doesn't)

```
┌─ buffr's "agent" surface — a workflow/chain, not an agent ───────────────────┐
│                                                                              │
│  UI                                                                          │
│   │  user opens editor/[date]                                                │
│   ▼                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │ src/services/ai/compose.ts  (deterministic orchestrator)            │     │
│  │                                                                     │     │
│  │   read ai_summaries cache (user_id, date)                           │     │
│  │           │                                                         │     │
│  │      ┌────┴────┐                                                    │     │
│  │      │ cached? │                                                    │     │
│  │      └────┬────┘                                                    │     │
│  │           │ no                                                      │     │
│  │           ▼                                                         │     │
│  │   summarize chain  ──── single LLM call ────▶ AISummary             │     │
│  │           │                                                         │     │
│  │           ▼                                                         │     │
│  │   caption chain    ──── single LLM call ────▶ 4 variants            │     │
│  │           │                                                         │     │
│  │           ▼                                                         │     │
│  │   write to ai_summaries cache                                       │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │ src/services/todos/reconcileMeta.ts  (deterministic orchestrator)   │     │
│  │                                                                     │     │
│  │   for each new todo:                                                │     │
│  │     heuristicClassify(text)  → 'todo' | null   (regex, free)        │     │
│  │           │                                                         │     │
│  │      ┌────┴────┐                                                    │     │
│  │      │  null?  │                                                    │     │
│  │      └────┬────┘                                                    │     │
│  │           │ yes                                                     │     │
│  │           ▼                                                         │     │
│  │     classify chain ─── single LLM call (Haiku 4.5) ─▶ type          │     │
│  │           │                                                         │     │
│  │           ▼                                                         │     │
│  │     expand chain   ─── single LLM call (per-type schema) ─▶ md      │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
│  Things NOT present anywhere:                                                │
│   ─ no tool calling (no chain emits structured tool requests)                │
│   ─ no ReAct / no Thought-Action-Observation loop                            │
│   ─ no RAG (principle #11 — hand-picked retrieval until provably needed)     │
│   ─ no agent memory tier (no conversation; each call stateless)              │
│   ─ no multi-agent topology (supervisor, pipeline-of-agents, fan-out)        │
│   ─ no autonomous decision-making — every branch is in TS code               │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

That diagram is buffr's entire "agent surface" — which is to say, buffr doesn't have one. The chains do their one job; the orchestrators decide what runs in what order *in TypeScript*, not by asking a model what to do next.

## Why this guide is short

This spec covers everything *above one agent* — reasoning patterns, retrieval as a control loop, multi-agent topologies. buffr does none of that. The bulk of the spec's sub-sections (agentic retrieval, agent infrastructure, multi-agent production serving) get **no concept files** here because buffr's shape doesn't reach them and the codebase doesn't exercise them. Generating "Not yet implemented" files for every pattern in every shape would be busywork; the SECTION F templates ([`06-orchestration-system-design-templates/`](./06-orchestration-system-design-templates/README.md)) carry that "what adopting these patterns would require" weight at the architecture level.

What you get instead is two **boundary files** — the load-bearing teaching for a workflow-shape codebase:

- [`01-reasoning-patterns/01-chains-vs-agents.md`](./01-reasoning-patterns/01-chains-vs-agents.md) — when buffr's chain shape is the right call and when an autonomous loop would earn its complexity.
- [`03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md`](./03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md) — the deeper boundary one step further out: even codebases that *do* have an autonomous loop usually shouldn't have multiple agents.

Plus three [SECTION F templates](./06-orchestration-system-design-templates/README.md) (research assistant, agentic support system, agentic coding system) — generated for every guide regardless of shape — that name the architecture and the refactor each would require if buffr ever needed it.

## The breakpoint to remember

```
   shape progression — left to right is more complexity, more capability
   ──────────────────────────────────────────────────────────────────

   workflow / chain  ──▶  single agent (ReAct)  ──▶  multi-agent topology
   buffr is here          (next step IF needed)     (the step after that)

   move right when the current shape STOPS WORKING, not before.

   workflow → single-agent breakpoint:
     "I can't enumerate the steps in advance because the next step depends
      on what the model finds." That's an agent loop.

   single-agent → multi-agent breakpoint:
     "One agent's context window is the bottleneck OR one agent can't
      reason across two genuinely different sub-domains." Even then,
      try better tools and better prompts first.
```

For buffr today: every step in every chain is enumerable in TypeScript. There is no point at which the model needs to decide "what should I do next?" because the orchestrator already knows. That's the workflow shape, and it's the right shape for this product. The boundary files make the case in detail.

## Where the guide cross-references

Where a pattern's *mechanics* are already taught in `study-ai-engineering/`, this guide cross-references rather than re-teaches. The spec is explicit: a file that re-teaches mechanics already covered in `study-ai-engineering` is a generation failure. So:

- ReAct loop mechanics → [`../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`](../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md)
- Tool calling → [`../study-ai-engineering/04-agents-and-tool-use/02-tool-calling.md`](../study-ai-engineering/04-agents-and-tool-use/02-tool-calling.md)
- Agents vs chains primer → [`../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md`](../study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md)
- Tool routing → [`../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md`](../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md)
- Agent memory → [`../study-ai-engineering/04-agents-and-tool-use/05-agent-memory.md`](../study-ai-engineering/04-agents-and-tool-use/05-agent-memory.md)
- RAG mechanics → [`../study-ai-engineering/03-retrieval-and-rag/`](../study-ai-engineering/03-retrieval-and-rag/README.md)
- LLM-as-judge bias → [`../study-ai-engineering/05-evals-and-observability/03-llm-judge-bias.md`](../study-ai-engineering/05-evals-and-observability/03-llm-judge-bias.md)
- Production serving (caching, retry, circuit breaker) → [`../study-ai-engineering/06-production-serving/`](../study-ai-engineering/06-production-serving/README.md)

This guide's contribution is the *architectural placement* — where each pattern sits in the family of shapes, what the breakpoint looks like, and what the topology costs vs buys.
