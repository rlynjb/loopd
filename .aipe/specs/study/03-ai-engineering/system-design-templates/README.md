# System design templates — AI engineering

IK-style interview-prompt reframes. Each template is a 9-bullet system design for a canonical AI engineering prompt, generated regardless of whether the current codebase exemplifies it — the templates are interview-prep artifacts more than codebase-specific docs.

These templates use the **9 labelled-bullet shape**, not the per-concept structure. Each file's body is: the prompt → the standard architecture → data model → key components → scale concerns → eval framing → common failure modes → applies to this codebase (yes/partially/no) → how to make it apply.

## Templates

| # | Template | Applies to loopd | One-line |
|---|---|---|---|
| 01 | [Search ranking](./01-search-ranking.md) | `partially` | Hybrid retrieval + optional rerank over a corpus. loopd's Phase 2A delivers this at small scale. |
| 02 | [Tech support chatbot](./02-tech-support-chatbot.md) | `no` | RAG-grounded support assistant with escalation gate. Thought-experiment for loopd; loopd isn't a support product. |

## Applies-to-loopd table

Quick scan for which templates the codebase can defend as built or partially-built:

```
Template                      Applies      Notes
─────────────────────────     ───────      ─────────────────────────────────
01-search-ranking             partially    Phase 2A ships small-scale shape
02-tech-support-chatbot       no           Thought-experiment; wrong product
```

## How to use

For interview prep:
1. Read the prompt aloud. Could you whiteboard the architecture in 60 seconds?
2. Read the standard architecture. Could you sketch it from memory?
3. Read the failure modes. Could you name three the interviewer might probe for?
4. Read the "applies to this codebase" — that's how you bridge the template to your real work.

The 9-bullet shape is the interview-spoken format. The architectural diagrams are the whiteboard format. Both work; both are practice.

---

Generated: 2026-05-11 — initial v1.29.0 templates.
