# Agent memory

**Industry name(s):** Agent memory, short-term context, long-term retrieval
**Type:** Industry standard

> Two layers: short-term = the conversation so far in context window; long-term = past sessions/decisions/facts retrieved via vector search. Short-term is bounded by the window; long-term is unbounded but retrieval-shaped.

**See also:** → [`02-context-and-prompts/01-context-window`](../02-context-and-prompts/01-context-window.md) · → [`03-retrieval-and-rag/11-rag`](../03-retrieval-and-rag/11-rag.md) · → [`01-llm-foundations/01-what-is-an-llm`](../01-llm-foundations/01-what-is-an-llm.md)

---

## Why care

### Move 1 — The grounded scenario

Imagine buffr with a chat-style "ask your journal" agent. The user converses across multiple turns: "what did I do this week?" → response → "and last week?" → response. The agent needs to remember the conversation so far (short-term — fits in context). Across sessions, user reopens the app a week later: "what was that thing about auth?" The agent needs to find what was discussed last session (long-term — retrieved from past conversations).

### Move 2 — Name the question the pattern answers

That what-the-agent-remembers question is what agent memory answers. Not "do LLMs have memory" (no — the LLM is stateless, concept `01-llm-foundations/01`); just *where does the agent's apparent memory live, and how is it injected into each call*.

### Move 3 — Why answering that question matters

**What breaks without explicit memory layers:** the agent has the conversation so far (short-term, fits in window), but past sessions are inaccessible unless you retrieve them. Without retrieval, every session starts from scratch — bad UX, especially for personal-data agents.

### Move 4 — Concrete before/after

Without long-term memory:
- Agent only remembers the current session
- User: "what was that thing about auth?" → "I don't have prior context"
- Annoying

With long-term memory:
- Past conversations stored in a vector DB
- On each turn, retrieve relevant past content + add to context
- User: "what was that thing about auth?" → retrieve relevant prior turn → respond grounded

### Move 5 — The one-line summary

Short-term = context window (the LLM "sees" this); long-term = vector retrieval (your code injects this). Both lives in your code; the model has nothing.

---

## How it works

### Move 1 — The mental model

```
   ┌─ Short-term (in-context) ────────────────────┐
   │  The conversation so far, fitted into the    │
   │  context window. Disappears when the          │
   │  conversation ends.                           │
   │  Capacity: limited by window size.            │
   └───────────────────────────────────────────────┘

   ┌─ Long-term (retrieved) ──────────────────────┐
   │  Past conversations, decisions, facts stored │
   │  in a vector DB. Retrieved per turn by        │
   │  relevance to the current query.              │
   │  Capacity: unbounded.                         │
   └───────────────────────────────────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — short-term mechanics.** Pass the conversation history as messages array. Trim oldest messages when the array exceeds budget. Optionally summarize older messages into a "previously…" preamble.

```
   Short-term: trim or summarise
   ─────────────────────────────
   recent 20 turns: full text in messages array
   older turns: summarised into "previously the user asked about..." preamble
   total budget: under 30% of context window
```

**Layer 2 — long-term mechanics.** Past conversations / facts stored in a vector DB with embeddings. On each turn, embed the user's current query, retrieve top-k relevant past content, include in the prompt as "relevant past context." The retrieval is RAG (concept `03/11`) applied to conversation history.

**Layer 3 — when each earns its place.** Short-term: always — required for conversational continuity. Long-term: when the agent needs to remember across sessions (personal-data agents, customer-support history, journal-as-context).

### Move 3 — The principle

Short-term is in the window; long-term is in retrieval; the model has no memory. Both layers live in your code.

---

## Agent memory — diagram

```
┌─ Agent turn with memory layers ────────────────────────────────────────┐
│                                                                        │
│   user query                                                           │
│         │                                                              │
│         ▼                                                              │
│   ┌─ Build prompt context ───────────────────────────────────┐        │
│   │                                                          │        │
│   │  1. system prompt                                        │        │
│   │  2. retrieved long-term memory (vector search)           │        │
│   │  3. short-term: recent conversation turns                │        │
│   │  4. user query (current turn)                            │        │
│   │                                                          │        │
│   └──────────────────────┬───────────────────────────────────┘        │
│                          │                                             │
│                          ▼                                             │
│                    LLM call                                            │
│                          │                                             │
│                          ▼                                             │
│                    response                                            │
│                          │                                             │
│                          ▼                                             │
│   append to short-term + maybe store in long-term                      │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not have an agent or memory system today.**

Buffr's data is already personal-journal long-term data; a future chat-style agent (Phase 4 hypothetical) would naturally retrieve from the existing `entries` table plus an additional `agent_conversations` table for prior chat sessions.

---

## Elaborate

### The deeper principle

Memory is your code's responsibility — the model has none. Two layers: in-context (cheap, small) and retrieved (unbounded, but retrieval-shaped).

### Where this breaks down

Long-term memory has the same failure mode as RAG: bad retrieval → confidently wrong responses based on irrelevant past content. Eval retrieval quality independently.

### What to explore next

- [`03-retrieval-and-rag/11-rag`](../03-retrieval-and-rag/11-rag.md) — long-term memory IS RAG
- [`02-context-and-prompts/01-context-window`](../02-context-and-prompts/01-context-window.md) — the short-term budget

---

## Tradeoffs

The breakpoint: short-term is mandatory for conversation; long-term is mandatory for cross-session continuity.

---

## Tech reference

- **Short-term:** trim oldest turns; summarize as preamble.
- **Long-term:** vector retrieval over a conversation history table.

---

## Project exercises

### B4-agent-memory — Hypothetical buffr chat agent memory shape

- **What to build:** if buffr ever ships a chat agent, design the memory layers: per-session messages (short-term), conversation history table with embeddings (long-term).
- **Done when:** the design is documented; cross-session continuity demonstrated.
- **Estimated effort:** depends on scope.

---

## Summary

- Short-term: context window; trim oldest.
- Long-term: vector retrieval over past content.
- Both live in your code.
- Buffr: Case B; future chat agent.

---

## Interview defense

**Q [mid]:** What's the difference between short-term and long-term agent memory?

**A:** Short-term is the conversation history fitted into the context window; bounded by the window; ephemeral. Long-term is past content stored in a vector DB and retrieved by relevance on each turn; unbounded; persistent across sessions. The LLM itself has no memory — both layers live in your code.

### One-line anchors

- Short-term: in window; trim or summarise.
- Long-term: vector retrieval; RAG-shaped.
- Both live in your code; model is stateless.

---

## Validate

### Quick check
- Where does short-term memory live?
- Where does long-term memory live?
- What's the failure mode of long-term memory?
