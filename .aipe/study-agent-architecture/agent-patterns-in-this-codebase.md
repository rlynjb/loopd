# Agent patterns in this codebase

Per-feature inventory of buffr's AI-touching surface, framed through the agent-architecture lens (shape, loop or topology, control envelope, eval). The honest summary is short: **buffr does not currently exercise any autonomous-agent pattern. Every "agent-shaped" question — what runs next, which tool to use, when to stop — is answered in TypeScript, not by a model.**

The table and the per-feature blocks below describe what's there, what shape it most-nearly resembles in the agent-architecture taxonomy, and where the boundary would flip toward a real agent loop.

```
   Feature                 → Shape                    → Why this shape
   ─────────────────────────────────────────────────────────────────────────
   compose.ts orchestrator → workflow / chain         → steps are enumerable
   reconcileMeta.ts orch.  → workflow / chain         → classify then maybe
                                                        expand; no loop
   classify chain          → 2-stage deterministic    → cheap-then-expensive
                              router (not LLM router)   gate; not agentic
   single-shot chains      → workflow primitives      → input → output, done
   (summarize/caption/
    expand/classify/
    interpret)
   provider abstraction    → swap surface             → orthogonal to agency
```

Every row resolves to "this is a workflow, not an agent." The next sections explain each one.

---

### Feature: Day-summary composition (`compose.ts`)

**Shape:** workflow / chain.

**The orchestration loop or topology:**

```
   compose.ts (deterministic TypeScript)
   ─────────────────────────────────────

   read ai_summaries cache (user_id, date)
            │
       ┌────┴────┐
       │ cached? │      ◀── decision is in code, not the model
       └────┬────┘
            │ no
            ▼
   summarize chain  ──── single LLM call ──▶ AISummary
            │
            ▼
   caption chain    ──── single LLM call ──▶ 4 variants
            │
            ▼
   write to ai_summaries cache
```

**Control envelope:** Anthropic / OpenAI default retries (no app-level retry, no circuit breaker — flagged honestly in the study-ai-engineering guide). Per-day cache caps load to ~1 call per chain per user per day.

**Eval:** none today. The chains run on dev intuition; there is no eval harness.

**Why not an agent:** every step's existence and order are knowable at write time. The cache-or-compute decision is a `if (cached) return cached` in TS; the summarize → caption order is hardcoded; there's no input shape under which the orchestrator would need a model's help to decide what to run next. That's exactly the workflow shape. See [`01-reasoning-patterns/01-chains-vs-agents.md`](./01-reasoning-patterns/01-chains-vs-agents.md) for the boundary.

---

### Feature: Per-todo classify + typed expansion (`reconcileMeta.ts`)

**Shape:** workflow / chain, with a deterministic fast-path / slow-path inside the classify step.

**The orchestration loop or topology:**

```
   reconcileMeta.ts (deterministic TypeScript)
   ───────────────────────────────────────────

   for each new todo derived from prose:
        │
        ▼
   heuristicClassify(text)   ──▶ 'todo' | null   (regex; ~70%)
        │
        ▼ (if null)
   classify chain (Haiku 4.5) ──▶ idea | knowledge | study | reflect | todo
        │
        ▼
   if type ≠ 'todo':
     expand chain (schema switched by type) ──▶ expanded_md
   else: skip expansion (todo is non-expandable default)
```

**Control envelope:** the `user_overridden_type` lock blocks re-classification once a user has corrected a type (see [`../study-ai-engineering/01-llm-foundations/09-user-override-locks.md`](../study-ai-engineering/01-llm-foundations/09-user-override-locks.md)). Heuristic-first absorbs the cost of unambiguous cases (~70%, unmeasured estimate).

**Eval:** none today. The classifier has no golden set; iteration is by eye.

**Why not an agent:** the routing inside classify — heuristic first, LLM on miss — is a deterministic cost gate, not an agentic decision. The classifier itself just returns a label. It doesn't decide to "look at sibling todos" or "retrieve from history" or "loop until confident." A hypothetical Phase-2A upgrade (classifier with retrieval: classify → if confidence low, retrieve similar past todos, re-classify) would be the breakpoint into a single-agent loop — but it's not built. See [`01-reasoning-patterns/01-chains-vs-agents.md`](./01-reasoning-patterns/01-chains-vs-agents.md).

---

### Feature: Single-shot chains (`summarize`, `caption`, `expand`, `classify`, `interpret`)

**Shape:** workflow primitives. Each chain is a pure `f(serialized inputs) → parsed output` call (see [`../study-ai-engineering/01-llm-foundations/01-what-is-an-llm.md`](../study-ai-engineering/01-llm-foundations/01-what-is-an-llm.md)). No chain emits tool calls; no chain iterates; no chain decides its own next step. They're called by the orchestrators above.

**Control envelope:** per-chain temperature; provider toggle; schema validation via `validate.ts` for the four JSON chains; the `interpret` chain returns markdown with length/content checks only.

**Eval:** none.

**Why not an agent:** an agent's distinguishing trait is autonomous control flow — the model picks the next action. None of buffr's chains do that. They produce a typed output and return; the orchestrator is the brain. That's the textbook workflow.

---

### What this codebase does NOT do — the agent-architecture gaps

These are not gaps to *fix* — they are gaps that are *correct given buffr's shape*. The point of naming them is so the reader knows where to look for each one (in the sibling guide for mechanics, in the boundary files for "should I reach for this") and so the breakpoint is explicit.

```
   Pattern                       Why buffr doesn't have it (and where to look)
   ──────────────────────────────────────────────────────────────────────────
   ReAct loop                    no autonomous loop exists. See ../study-ai-
                                 engineering/04-agents-and-tool-use/03-react.
                                 Boundary: 01-reasoning-patterns/01-chains-
                                 vs-agents.md.

   Tool calling                  no chain emits tool requests; orchestrators
                                 do all I/O themselves. See ../study-ai-
                                 engineering/04-agents-and-tool-use/02.

   RAG                           principle #11 — hand-picked retrieval until
                                 provably needed. See ../study-ai-engineering/
                                 03-retrieval-and-rag/11-rag.md.

   Agent memory tier             chains are stateless; the user-override lock
                                 is the only persistent "memory" of model
                                 decisions. See ../study-ai-engineering/
                                 04-agents-and-tool-use/05-agent-memory.md.

   Multi-agent topology          there's nothing to coordinate. Boundary:
   (supervisor / pipeline /      03-multi-agent-orchestration/01-when-not-
    fan-out / debate / swarm /   to-go-multi-agent.md.
    graph)

   Agentic retrieval as a        retrieval is hand-picked (recency + siblings),
   control loop                  not embedded in any control loop.

   Cross-turn caching            no "turn" concept; per-day exact-match
                                 caching covers the same need at this shape.
                                 See ../study-ai-engineering/06-production-
                                 serving/01-llm-caching.md.

   Per-tool circuit breaking,    no tools, no fan-out. Single-call retry /
   agent-trajectory eval         circuit-breaker mechanics for the chains live
                                 in ../study-ai-engineering/06-production-
                                 serving/.
```

The closest thing buffr exercises to "agentic" behaviour is the heuristic-first routing inside the classifier — and that's a deterministic cost gate, not autonomous decision-making. The whole point of the boundary files in this guide is to keep the reader from upgrading to an agent shape *before the chain shape stops being enough*. Right now, the chain shape is enough.
