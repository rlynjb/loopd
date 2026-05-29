# 01 — Reasoning patterns

One file: the chains-vs-agents boundary. For a workflow/chain codebase like buffr, this is *the* load-bearing concept in the whole guide — it defends the chain shape and names the breakpoint that would flip it.

## Files

1. **[Chains vs agents — the boundary](./01-chains-vs-agents.md)** — when buffr's chain shape is the right call (always, currently) and when an autonomous loop would earn its complexity (a feature whose path is data-dependent in a way no structured output or pre-encoded branch covers).

## Why no other files

The other reasoning patterns the spec lists — plan-and-execute, reflexion / self-critique, tree-of-thoughts, LLM-routed dispatch — all live above the single-agent shape. buffr hasn't crossed into the single-agent shape, so generating files for each pattern would be busywork: they'd all be "Not yet implemented" with no genuine codebase content. The spec is explicit: patterns from a shape the codebase doesn't match are skipped.

For ReAct loop **mechanics** (the standard single-agent shape), the canonical file lives in the sibling guide: [`../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`](../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md). For LLM-routed dispatch mechanics: [`../../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md`](../../study-ai-engineering/04-agents-and-tool-use/04-tool-routing.md). This guide cross-references; it doesn't re-teach.

## What you'd read this for

If you're trying to decide whether a feature needs an agent, [`01-chains-vs-agents.md`](./01-chains-vs-agents.md) is the file. The three-question test inside it is the framework you apply; the four pre-agent rungs (structured output, smaller chains, better tools, deterministic orchestration) cover most of what gets called "we need an agent" in production conversations.
