# buffr — agent architecture study guide

Topic-focused companion to `/aipe:study` and `/aipe:study-ai-engineering`. This spec covers everything *above one agent*: reasoning patterns (when chains stop being enough), agentic retrieval (retrieval as a control loop), multi-agent orchestration (topologies), and the production concerns those introduce.

**buffr's shape: workflow / chain.** No autonomous loops, no tools, no RAG, no multi-agent. The right shape for buffr today; this guide defends that and names the breakpoints. See [`00-overview.md`](./00-overview.md) for the system map.

## How the guide is structured

This is a deliberately tight guide. The spec says: "Patterns from a shape the codebase does not match at all are skipped — no file generated." buffr's workflow shape skips most of the sub-sections; what remains is the boundary teaching and the system-design templates.

- [`00-overview.md`](./00-overview.md) — system map: buffr's agent surface (mostly empty by design) and the shape-progression breakpoint.
- [`agent-patterns-in-this-codebase.md`](./agent-patterns-in-this-codebase.md) — per-feature inventory; in buffr's case, an honest "you don't do this, here's why" with the closest-shaped patterns named.
- [`01-reasoning-patterns/`](./01-reasoning-patterns/README.md) — one file: the chains-vs-agents boundary. The other reasoning patterns (plan-and-execute, reflexion, ToT, routing) are not exercised by buffr's shape, so no files.
- [`03-multi-agent-orchestration/`](./03-multi-agent-orchestration/README.md) — one file: the when-not-to-go-multi-agent boundary. The topology files (supervisor-worker, pipeline, fan-out, debate, swarm, graph) are skipped — buffr has no multi-agent surface.
- [`06-orchestration-system-design-templates/`](./06-orchestration-system-design-templates/README.md) — three templates: multi-agent research assistant, agentic support system, agentic coding system. Always generated regardless of shape; for buffr each one names the refactor that would adopt the architecture.

Sub-sections **not generated** (zero files) because buffr's shape doesn't reach them: `02-agentic-retrieval/`, `04-agent-infrastructure/`, `05-production-serving/`. Where one of those patterns might earn its keep later, the relevant SECTION F template names it.

## Reading order

1. [`00-overview.md`](./00-overview.md) — to see the shape laid out and the breakpoint named.
2. [`agent-patterns-in-this-codebase.md`](./agent-patterns-in-this-codebase.md) — to see how that maps onto the actual files in `src/services/`.
3. [`01-reasoning-patterns/01-chains-vs-agents.md`](./01-reasoning-patterns/01-chains-vs-agents.md) — the load-bearing defense of buffr's chain choice + the breakpoint that flips it.
4. [`03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md`](./03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md) — the boundary one step further out: when single-agent is enough.
5. [`06-orchestration-system-design-templates/`](./06-orchestration-system-design-templates/README.md) — three worked architectures to recognise interview prompts that match.

## What you'll find here vs in the sibling guides

This guide cross-references rather than duplicates. Mechanics live one place:

- **`study-ai-engineering/`** owns the single-agent + single-call mechanics (ReAct internals, tool-calling protocol, RAG mechanics, agent-memory shape, single-call caching/retry/circuit-breaker).
- **`study-agent-architecture/` (this guide)** owns the architectural placement: where each pattern sits in the family of shapes, what the topology costs vs buys, when the breakpoint flips, and how the orchestrator code changes when you adopt the next shape.

When a file here references mechanics, it links into `study-ai-engineering/`. A file that re-teaches those mechanics is a generation failure per the spec.
