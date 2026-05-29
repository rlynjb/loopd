# 03 — Multi-agent orchestration

One file: the when-not-to-go-multi-agent boundary. The other multi-agent topologies (supervisor-worker, sequential-pipeline, parallel-fan-out, debate-verifier-critic, swarm-handoff, graph-orchestration) and the multi-agent infrastructure topics (shared-state-and-message-passing, coordination-failure-modes) get no files here because buffr's shape doesn't reach them — and the spec is explicit: patterns from a shape the codebase doesn't match are skipped.

## Files

1. **[When not to go multi-agent — the boundary](./01-when-not-to-go-multi-agent.md)** — the two real walls (context window, sub-domain split) that justify a multi-agent topology, the four rungs to try before climbing to the multi-agent ladder, and the five hidden costs that internet folklore underestimates. For buffr the boundary is doubly distant: the codebase hasn't crossed into the single-agent shape yet, so the multi-agent question is moot.

## Why no other files

Each multi-agent topology (supervisor-worker, pipeline, fan-out, debate, swarm, graph) has a distinctive shape and tradeoff profile, but they're all variations of "multi-agent coordination" — and buffr exercises none of them. Generating "Not yet implemented" files for each would be busywork. The [SECTION F templates](../06-orchestration-system-design-templates/README.md) walk a full architecture for the three canonical multi-agent use cases (research, support, coding) when an interviewer asks about them — and for buffr each one is honestly marked "applies: no."

For multi-agent **mechanics** when you do hit the walls — handoff payload shape, supervisor routing prompts, coordination failure recovery — the production frameworks (LangGraph, CrewAI, AutoGen) are the canonical sources, called out in the boundary file's Tech reference.

## What you'd read this for

The boundary file is for engineers being pulled toward multi-agent before they've hit the walls. The most useful single sentence in it: "Single agent + better tools beats multi-agent until one of the two walls is measured." If you can't name which wall you've hit and how you measured it, the topology isn't justified yet — try the four rungs first.
