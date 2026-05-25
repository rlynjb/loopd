# 07 — System design templates

Two interview-prompt reframes. The 9-labelled-bullet shape (not the per-concept template) — interviewer's question verbatim → standard architecture → data model → key components → scale concerns → eval framing → failure modes → applies to this codebase → how to make it apply.

The point of these templates is interview prep: when someone says "design X system," you walk through *this* codebase as that system (or honestly say it doesn't apply, naming what would have to change).

## Templates

1. **[Search ranking](./01-search-ranking.md)** — applies **partially**. Buffr's planned "find related entries" feature (Phase 2A `B2A.8`) is a small-scale search ranking system. Same shape; tiny scale.
2. **[Tech support chatbot](./02-tech-support-chatbot.md)** — does **not apply**. Buffr has no customer-support surface. Read for the pattern; recognise where it doesn't fit.

## Reading order

If you came from interview prep: read both. The first lets you walk buffr through a search-ranking question (Phase 2A's RAG plus reranking maps directly). The second lets you say "buffr isn't this kind of system; the shape would require X" — which is itself a senior answer.

If you came from "what's buffr's AI architecture": read template 1 only; that's the system shape Phase 2A is building.
