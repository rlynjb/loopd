# Tool calling

**Industry name(s):** Tool calling, function calling, tool use
**Type:** Industry standard

> LLM emits structured "call this function with these args"; your code runs it and feeds the result back. The brain decides; the hands execute. The unit any agent is built on.

**See also:** → [01-agents-vs-chains](./01-agents-vs-chains.md) · → [03-react-pattern](./03-react-pattern.md) · → [`01-llm-foundations/04-structured-outputs`](../01-llm-foundations/04-structured-outputs.md)

---

## Why care

### Move 1 — The grounded scenario

Imagine extending buffr's classifier to look up similar past todos before deciding the type. The LLM doesn't have access to SQLite. It can't query. But if you give it a tool called `retrieve_similar_todos(query: string, limit: number)` and tell it about the tool's schema, the LLM can emit `{ tool: 'retrieve_similar_todos', input: { query: 'auth bug', limit: 5 } }`. Your code reads that, runs the SQLite query, hands the result back as the next message. The LLM continues with the retrieved data in context.

### Move 2 — Name the question the pattern answers

That how-do-I-give-the-LLM-actions question is what tool calling answers. Not "should the LLM access my DB directly" (no — your code does); just *what's the protocol that lets the LLM "request" an action while your code stays in control*.

### Move 3 — Why answering that question matters

**What breaks without tool calling:** any agent needs tools. Without the structured "tool requested" output, you're parsing free-text LLM output into intentions ("I think the model wants me to search…") — fragile, error-prone, and exactly the kind of bug structured outputs (concept 04) was invented to solve.

### Move 4 — Concrete before/after

Without tool calling (parse free text):
- LLM produces: "I'd like to search for auth-related todos."
- Your code: regex this to extract intent
- 30% of calls produce ambiguous intents
- Brittle

With tool calling (structured):
- LLM produces: `{ tool: "search", input: { query: "auth" } }`
- Your code: dispatch on `tool` field, run it
- 99% reliable

### Move 5 — The one-line summary

Tool calling = structured "call this with these args"; LLM is the brain, tools are the hands; your code runs the tools and feeds results back.

---

## How it works

### Move 1 — The mental model

```
   Tool definition (your code):
   ────────────────────────────
   {
     name: "retrieve_similar_todos",
     description: "Retrieve up to N todos similar to the query string",
     input_schema: {
       query: string,
       limit: number
     }
   }

   LLM output (when it decides to call the tool):
   ──────────────────────────────────────────────
   {
     tool: "retrieve_similar_todos",
     input: { query: "auth bug", limit: 5 }
   }

   Your code:
   ──────────
   if output.tool === "retrieve_similar_todos":
     result = retrieveSimilarTodos(output.input.query, output.input.limit)
     // send result back to LLM as next message
```

### Move 2 — The layered walkthrough

**Layer 1 — the loop.** LLM emits a tool call → your code runs the tool → your code sends the result back as the next message → LLM emits the next action (another tool call, or "done"). The loop continues until the LLM says it's done or the iteration cap is hit.

```
   The loop
   ────────
   LLM → tool call → your code runs tool → result back to LLM → next action
                                                                    │
                                                                    ▼
                                                         loop or terminate
```

**Layer 2 — provider mechanics.** Anthropic's `tool_use` content block: response includes `{ type: "tool_use", name, input }`. OpenAI's `tool_calls`: `{ function: { name, arguments } }` (arguments as JSON string). Both are schema-constrained via the tool definition you provide.

**Layer 3 — security boundary.** Tools are your code, not the LLM's code. The LLM requests an action; your code decides whether to run it. This is the security boundary: never let LLM output trigger side effects directly. Add a confirmation step for destructive tools (delete, send-email).

```
   Security boundary
   ─────────────────
   LLM output: tool call (just text/JSON)
        │
        ▼
   your code: dispatch, validate inputs, confirm if needed, run tool
        │
        ▼
   result back to LLM
```

### Move 3 — The principle

Tool calling is the protocol; your code runs the tools. The LLM is the planner; the tools are the executors. The boundary is non-negotiable.

---

## Tool calling — diagram

```
┌─ One agent turn ───────────────────────────────────────────────────────┐
│                                                                        │
│   user message + tool definitions                                      │
│         │                                                              │
│         ▼                                                              │
│   LLM call ──→ response                                                │
│                   │                                                    │
│              ┌────┴────┐                                               │
│              │         │                                               │
│              ▼ text    ▼ tool_use                                      │
│             done       {name, input}                                   │
│                              │                                         │
│                              ▼ your code dispatches                    │
│                       run tool, get result                             │
│                              │                                         │
│                              ▼                                         │
│                       new message: tool_result                         │
│                              │                                         │
│                              ▼                                         │
│                       LLM call (next turn) ...                         │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case B — buffr does not use tool calling.**

Phase 4 `B4B.1` defines the classifier-with-retrieval upgrade where tool calling enters: tools would be `retrieve_similar_todos` and `get_user_override_history`. Neither exists today.

---

## Elaborate

### Where this pattern comes from

OpenAI's `function_calling` API (2023) introduced the structured shape. Anthropic followed with `tool_use` content blocks. Both providers' APIs are tool-calling-first now.

### The deeper principle

Separating decision (LLM) from execution (code) is the agent design principle. The boundary makes systems debuggable.

### Where this breaks down

When tools are slow or unreliable, the agent's loop time is dominated by tool execution, not LLM time. Make tools fast or batch them.

### What to explore next

- [03-react-pattern](./03-react-pattern.md) — Thought / Action / Observation built on tool calling
- [04-tool-routing](./04-tool-routing.md) — when to use multiple tools
- [`01-llm-foundations/04-structured-outputs`](../01-llm-foundations/04-structured-outputs.md) — tool calling is structured outputs

---

## Tradeoffs

The breakpoint: any agent needs tool calling; there's no agent without tools.

---

## Tech reference

- **Anthropic:** `tool_use` content block, `tools` array in `messages.create()`.
- **OpenAI:** `tool_calls` field on the response message, `tools` array in request.

---

## Project exercises

### B4B.1 — Tool definitions for classifier agent

- **What to build:** define `retrieve_similar_todos` and `get_user_override_history` as Anthropic tools; wire to existing SQLite queries.
- **Done when:** tools work end-to-end in test fixtures.
- **Estimated effort:** 3 hours.

---

## Summary

- Tool calling = structured action request from LLM.
- Your code runs the tool; LLM doesn't.
- Security boundary: LLM output never triggers side effects directly.
- Buffr: Case B; Phase 4 build target.

---

## Interview defense

**Q [mid]:** Why is tool calling safer than parsing free-text intentions?

**A:** Structure. With tool calling, the LLM's output is constrained to match a schema (tool name + typed input). With free text, you're guessing intent from prose — ambiguous, brittle, every model upgrade breaks the parser. Same reason structured outputs (concept 04) beat "respond in JSON" prompting: provider enforcement at the token level is stronger than prompt-only.

### One-line anchors

- LLM is the brain; tools are the hands.
- Your code runs the tools.
- Schema-constrained tool calls are reliable; free-text intents aren't.

---

## Validate

### Quick check
- Who runs the tool — the LLM or your code?
- What's the security boundary?
- What's a buffr tool that would exist in a future agent?
