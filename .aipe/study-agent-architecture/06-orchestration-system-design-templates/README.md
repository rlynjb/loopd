# 06 — Orchestration system design templates

Three interview-prompt reframes covering the canonical multi-agent / agentic architectures. The 9-labelled-bullet shape (not the per-concept template) — interviewer's question verbatim → standard architecture → data model → key components → scale concerns → eval framing → failure modes → applies to this codebase → how to make it apply.

These templates are **always generated** regardless of the codebase's shape. Their value is interview-prep more than codebase-defense: when an interviewer asks "design X," you walk the standard architecture. When the architecture doesn't apply to your codebase (as is the case for buffr on all three here), you say so plainly and name what shape your real feature would take instead. Stretching a non-matching codebase to fit a template is a failure mode in itself.

## Templates

1. **[Multi-agent research assistant](./01-multi-agent-research-assistant.md)** — planner → supervisor → workers (fan-out) → synthesizer. Applies: **no** (buffr is a journal, not a research-assistant).
2. **[Agentic support system](./02-agentic-support-system.md)** — intent router → support agent (ReAct + KB tools) → HITL escalation → feedback loop. Applies: **no** (buffr is single-user; no support surface).
3. **[Agentic coding system](./03-agentic-coding-system.md)** — repo intake → coding agent (ReAct + file/test tools) → patch. Applies: **no** (buffr is not a dev tool).

## Reading order

If you came from interview prep: read all three. They're the three most common 2024–2026 agentic architecture questions, and walking them is what an interview wants. The "applies to this codebase" bullets are honest: buffr doesn't match any of them, and the senior move is naming that without forcing a stretch.

If you came from "what would buffr look like if it adopted agents?": the answer is none of these. buffr's most-realistic agent-adoption path is a single-agent upgrade to the classifier (classify → if low-confidence, retrieve similar past todos via RAG, re-classify) — and that's covered as the breakpoint in [`../01-reasoning-patterns/01-chains-vs-agents.md`](../01-reasoning-patterns/01-chains-vs-agents.md), not in these templates. None of these three architectures map onto buffr's product, and forcing a fit would be the exact failure mode the boundary files warn against.

## Why all three are "applies: no"

buffr is a **single-user daily-journaling app** with five single-purpose LLM chains. The three templates above are:
- **Research assistant:** plans + parallelises + synthesises. buffr has no question-decomposition or synthesis stage.
- **Support system:** routes + escalates + learns from resolved tickets. buffr has no tickets, no humans-in-the-loop, no escalation path.
- **Coding system:** reads code + runs tests + emits patches. buffr has no code-editing surface — it's a consumer app.

The architectures are good. They just describe a different category of product. Read them for the interview-prep value; for buffr's actual agent-architecture story, the boundary files in `01-reasoning-patterns/` and `03-multi-agent-orchestration/` are the load-bearing content.
