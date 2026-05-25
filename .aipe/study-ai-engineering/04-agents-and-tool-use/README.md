# 04 — Agents and tool use

Six patterns covering agentic systems: when to use them, the protocol (tool calling), the canonical shape (ReAct), routing, memory, and error recovery. All Case B for buffr today — every chain in `src/services/ai/` is single-shot. Phase 4 of the curriculum defines the build paths.

## Concepts

1. **[Agents vs chains](./01-agents-vs-chains.md)** — chain = known steps; agent = LLM-decided loop. Default to chains.
2. **[Tool calling](./02-tool-calling.md)** — LLM emits structured "call this with these args"; your code runs it. Brain decides; hands execute.
3. **[ReAct pattern](./03-react-pattern.md)** — Thought / Action / Observation loop; externalises reasoning for debuggability.
4. **[Tool routing](./04-tool-routing.md)** — heuristic for predictable; LLM for free-form. Same shape as heuristic-before-LLM.
5. **[Agent memory](./05-agent-memory.md)** — short-term (context window); long-term (vector retrieval); both live in your code.
6. **[Error recovery](./06-error-recovery.md)** — five failure modes; explicit recovery for each; silent loops are the worst outcome.

## What buffr exercises today

- **Nothing.** No agents in `src/services/ai/`. Every chain is single-shot. The closest thing to an agent shape is `classify.ts` with its heuristic-before-LLM dispatch, but it's still a chain (fixed flow).

## What Phase 4 builds

Three paths (curriculum):
- **Path A:** aipe meta-agent (`/aipe:implement` slash command). Out of scope for buffr.
- **Path B:** buffr classifier upgrade — classify → if confidence < 0.7, retrieve similar todos via RAG → re-classify. ReAct shape. Tools: `retrieve_similar_todos`, `get_user_override_history`.
- **Path C:** contrl-mo coaching agent. Out of scope for buffr (different codebase).

Path B is the one that ships against buffr if Phase 4 advances.

## Reading order

Read 1–2 for grounding (chain vs agent, tool calling). Read 3 for the canonical shape (ReAct). Read 4–5 for the structural pieces (routing, memory). Read 6 for the operational discipline (error recovery). The order is foundation → mechanics → operational.
