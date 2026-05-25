# Tool calling — not used in buffr

**Industry name(s):** Tool calling, function calling
**Type:** Industry standard

> The codebase deliberately does not implement tool calling, agents, or any loop where the LLM asks the app to do something and read the result back.

**See also:** → [01-what-an-llm-is](./01-what-an-llm-is.md) · → [12-why-no-agents](./12-why-no-agents.md)

---

## Why care

You're calling a function that returns a value, but the value depends on data that lives in a DB. Option one: the function takes the data as an argument — the caller fetches everything upfront and passes it in, the function runs once with every input present. Option two: the function is a generator (`function*`) that yields `{ fetch: 'todos' }`, your loop runs the fetch and `next()`s with the result, the generator maybe yields another fetch, you run that, you `next()` again — back and forth until the generator returns the final value. Same final answer; option one is one synchronous call, option two is N round-trips with the function deciding what to ask for next. LLM tool calling is option two — the model yields tool calls instead of generator values, and an orchestrator runs them and feeds the results back.

That's the shape of tool calling — model as the generator, application code as the loop driver, every step another round-trip. The pattern is documented here precisely because this codebase doesn't use it. Naming what's *not* in play is the load-bearing distinction; every chain in `src/services/ai/` is single-shot, prompt-in-JSON-out, no orchestrator, no loop.

**What depends on getting this right:** the cost, latency, and debuggability of every AI feature. The codebase pre-fetches everything inline via per-chain `buildContext` (in [03-context-window](./03-context-window.md)) — `expand(todoId)` reads the todo text, the last 3 days of summaries, and the 5 sibling todos from SQLite *before* the prompt is built, calls Claude once, parses ~400 tokens of JSON via `validate.ts`, persists. One round-trip, predictable cost, deterministic shape. The agentic version would have the model say "give me todos from the past week" → orchestrator runs SQL → "give me yesterday's summary" → orchestrator runs SQL → "give me sibling todos" → orchestrator runs SQL → final answer. Four round-trips for the same data; four points the loop can fail, get stuck, or run away. The codebase ships zero agentic chains because zero features today need open-ended queries the prompt builder can't pre-fetch for.

Without one-shot discipline:
- `expand` says "give me todos from the past week"; orchestrator runs SQL, model decides to ask for more
- 3-5 iterations per call; 3-5× cost and latency
- Debugging means "what did the model see at iteration 3?" — buffer replay, not curl replay

With one-shot discipline:
- `expand` gets todo text + 3 days of summaries + 5 sibling todos in one inline prompt
- One round-trip, one `validate.ts` pass, one `upsertAISummary`
- Same prompt twice = same problem twice; replayable via curl, fixable in `prompt.ts`

The cheapest agent is no agent — pre-fetch the data deterministically and let the model do the LLM-shaped work.

---

## How it works

A loop where the model emits tool calls and your code runs them and feeds the results back — same shape as driving a JavaScript generator (`function*`) with `next()`, except the `yield` points come from an LLM emitting `{ tool: 'X', input: { ... } }` instead of a `yield` keyword, and the loop driver decides when to stop. Buffr's AI calls don't do this — every call is one-shot, prompt-in-JSON-out, no orchestrator, no loop. The pattern is documented here because understanding what buffr *doesn't* do is the load-bearing distinction.

The loop the codebase DOES NOT use, side by side with the one it does:

```
       Tool-calling loop (NOT buffr)              One-shot (buffr today)
   ┌────────────────────────────────┐         ┌────────────────────────────────┐
   │ prompt + tool schemas           │         │ prompt with all data inlined   │
   │           │                      │         │ (buildContext fetched it       │
   │           ▼                      │         │  before the call)              │
   │      ┌────────┐                  │         │           │                    │
   │      │  LLM    │                  │         │           ▼                    │
   │      └────┬───┘                  │         │      ┌────────┐                 │
   │           │ yields                │         │      │  LLM    │                 │
   │           ▼                       │         │      └────┬───┘                 │
   │   { tool: 'query_todos',          │         │           │                    │
   │     input: {…} }                  │         │           ▼                    │
   │           │                       │         │      final answer              │
   │           ▼  orchestrator         │         └────────────────────────────────┘
   │   run SQL / HTTP                  │             one round-trip, always
   │           │                       │
   │           ▼                       │
   │   feed observation back ──┐       │
   │                            │       │
   │           ▲────── loop ────┘       │
   │                                    │
   │   3–5 iterations typical;          │
   │   3–5× cost and latency            │
   └────────────────────────────────┘
```

The three sub-sections below trace the loop itself, why buffr opted out, and what one-shot gives up that an agent could provide.

### The tool-calling loop — model emits a tool call, orchestrator runs it, re-prompts

The model is given a list of "tools" with their input schemas as part of the prompt. Its output may include a tool call: `{ tool: "search_entries", input: { query: "sickest" } }`. The orchestrator (application code surrounding the model) detects this output shape, runs the tool (a SQL query, an HTTP fetch, a calculation), packages the result as an "observation," and re-prompts the model with the original conversation + the observation. The model can then issue another tool call or a final answer. This loops until the model emits a final answer or the orchestrator gives up. If you're coming from frontend, this is the same shape as React's effect-driven control flow — the component renders a request to "do X," some effect handler does X and feeds the result back as state, the next render decides what to do next. The model owns "what to ask for"; the orchestrator owns "how to fulfill." Concrete consequence: a hypothetical agent asked "what was my sickest workout last month?" would emit `{ tool: "query_workouts", input: { from: "...", filter: "intensity_high" } }`, the orchestrator runs the SQL, returns the rows, the model reads them and emits the final answer. The model never touched the database; the orchestrator never reasoned. Boundary: each loop iteration is another LLM round-trip — 3-5 iterations is typical for an agent, which means 3-5× the cost and latency of a one-shot call.

Walking the loop on a hypothetical "what was my sickest workout last month?" agent:

```
   iteration 1:
     prompt:    user query + tool schemas (query_workouts, ...)
     model →    { tool: 'query_workouts',
                  input: { from: '2026-04-14', filter: 'intensity_high' } }
     orchestrator runs SQL → returns 12 rows
                              │
                              ▼
   iteration 2:
     prompt:    conversation so far + observation (12 rows)
     model →    { tool: 'get_workout_details',
                  input: { id: 'w-7' } }
     orchestrator runs SQL → returns details for w-7
                              │
                              ▼
   iteration 3:
     prompt:    conversation so far + observation
     model →    final answer: "Your sickest workout was on
                  May 3, intensity 9.4, heart rate 178..."

   total: 3 LLM round-trips for one user question
   (3× the cost and latency of a one-shot call)
```

The model owns "what to ask for"; the orchestrator owns "how to fulfill." Neither one alone is enough.

### Why buffr doesn't do this — every chain is one-shot

Every AI chain in this codebase is single-shot: build a prompt with all the data the model needs, call the LLM once, parse the response, persist. No tool-calling loop, no orchestrator, no "let me check on that." The data the chain needs is fetched from SQLite *before* the prompt is built — see `buildContext` per chain in [03-context-window](./03-context-window.md). The model sees the data inline; it doesn't ask for it. Think of it like the difference between a stateless backend handler that gets everything it needs in the request body vs an agentic handler that calls out to other services mid-request. The codebase deliberately picks the former. Concrete consequence: when `expand(todoId)` runs, the codebase reads the todo text, the last 3 days of summaries, the 5 sibling todos — all from SQLite — packs them into a prompt, calls Claude once, parses ~400 tokens of expansion JSON. One round-trip, predictable cost, deterministic shape. An agentic version would have the model say "give me todos from the past week" → orchestrator runs SQL → "give me yesterday's summary" → orchestrator runs SQL → "give me sibling todos" → orchestrator runs SQL → final answer. Four round-trips for the same data the one-shot version assembled deterministically in code. Boundary: the one-shot pattern works because the codebase knows in advance what data the chain needs. When the data needed depends on the input in unpredictable ways (e.g. an open-ended Q&A), agentic shapes become unavoidable.

The `expand(todoId)` call under both arrangements:

```
       One-shot (buffr today)                Agentic (NOT buffr)
   ┌───────────────────────────────┐    ┌───────────────────────────────┐
   │ expand(todoId)                 │    │ expand(todoId)                 │
   │   ▼                             │    │   ▼                             │
   │ buildContext:                   │    │ prompt with tool schemas only   │
   │   getTodoText(id)               │    │   ▼                             │
   │   getRecent3DaysSummaries()     │    │ LLM → 'query_todo(id)'          │
   │   getSibling5Todos(id)          │    │ SQL → todo text                 │
   │   ▼                             │    │   ▼                             │
   │ build full prompt               │    │ LLM → 'query_summaries(3)'      │
   │   ▼                             │    │ SQL → summaries                 │
   │ LLM call (one round-trip)       │    │   ▼                             │
   │   ▼                             │    │ LLM → 'query_siblings(id, 5)'   │
   │ parse + validate + persist      │    │ SQL → siblings                  │
   │                                 │    │   ▼                             │
   │ predictable cost,               │    │ LLM → final expansion JSON      │
   │ deterministic shape             │    │                                 │
   │                                 │    │ 4 LLM round-trips for the same  │
   │                                 │    │ data the one-shot prefetched    │
   └───────────────────────────────┘    └───────────────────────────────┘
```

When the codebase knows what data the chain needs in advance, fetching it deterministically wins every time on cost, latency, and debuggability.

### What the one-shot path gives up — open-ended queries

The cost of one-shot is that the codebase can't support "ask the AI anything about your journal" features. The model can only see what the prompt builder chose to include; novel cross-cutting queries ("show me the days where I mentioned both `buffr` and `gym`") need their own chain with their own data-fetch logic. An agentic shape would let the model improvise the data fetch — `query_entries(filter: "mentions thread X AND thread Y")` — without a new chain. If you've worked with the difference between typed REST endpoints and a GraphQL backend that lets the client compose queries, this is the same shape — typed endpoints are predictable and cheap; GraphQL is flexible and harder to constrain. Concrete consequence: the codebase has 5 chains for 5 specific jobs. A user who wants a 6th job (e.g. "summarise my last 3 trips") would need either a new chain or an interpret-like generic chain. The agentic version could handle ad-hoc queries without code changes — but at 4× the cost-per-call and a much wider failure surface (the model picks the wrong tool, the orchestrator dispatches wrong, the loop never terminates). Until then, one-shot wins.

The cost ledger for adding a 6th capability — typed chain vs agentic:

```
        Typed chain (buffr's pattern)              Agentic chain
   ┌──────────────────────────────────────┐   ┌──────────────────────────────────────┐
   │ writer's time:                        │   │ writer's time:                        │
   │   build one new chain file            │   │   define tool schemas + dispatcher    │
   │   (buildContext + prompt + parse)     │   │   wire orchestrator loop              │
   │                                       │   │                                       │
   │ cost per call:                        │   │ cost per call:                        │
   │   one round-trip; predictable          │   │   3–5 round-trips; variable           │
   │                                       │   │                                       │
   │ failure modes:                        │   │ failure modes:                        │
   │   prompt malformed (1 surface)         │   │   model picks wrong tool              │
   │                                       │   │   orchestrator dispatches wrong       │
   │                                       │   │   loop never terminates               │
   │                                       │   │   observation parse fails              │
   │                                       │   │   (4+ surfaces)                       │
   │                                       │   │                                       │
   │ adds support for:                     │   │ adds support for:                     │
   │   one job                             │   │   any job whose data the tools can    │
   │                                       │   │   reach (open-ended)                  │
   │                                       │   │                                       │
   │ right call when:                      │   │ right call when:                      │
   │   the job is known in advance         │   │   the user needs ad-hoc Q&A           │
   └──────────────────────────────────────┘   └──────────────────────────────────────┘
```

Agents earn their cost when you don't know in advance what data is needed; until you cross that threshold, the deterministic prompt-builder is the right call.

This is what people mean by "the cheapest agent is no agent." Tool-calling loops are powerful, expensive, and hard to debug — every iteration is another LLM decision the codebase has to defend. One-shot calls trade flexibility for predictability: if you know the data the model needs, fetch it deterministically and let the model do the LLM-shaped work (reasoning over typed inputs). Agents earn their cost when you don't know in advance what data is needed; until you cross that threshold, the deterministic prompt-builder is the right call. The full picture is below.

---

## Tool calling — diagram

```
  Every buffr AI call:                  An agent with tools (NOT buffr):
  ────────────────────────              ────────────────────────────────

  ┌─ App layer ──────────┐              ┌─ App / orchestrator ──────────────┐
  │  prompt → JSON       │              │  prompt → dispatch → observation  │
  │  → done              │              │     ▲                  │          │
  └──────────┬───────────┘              └─────┼──────────────────┼──────────┘
             │                                │                  ▼
             ▼                          ┌─ Provider (LLM) ──┐  ┌─ Tool (SQL/HTTP) ─┐
  ┌─ Provider (LLM) ─────┐              │  emits tool call  │  │  runs the call    │
  │  one-shot response   │              └────────┬──────────┘  └─────────┬─────────┘
  └──────────────────────┘                       │                       │
                                                 └────────── loop ───────┘
```

---

## When tools would matter

If the user asked "find me the day I was sickest last month" and the answer required searching entries, that's where tool calling fits. The model emits `{tool: "search_entries", input: {query: "sickest"}}`, the app runs SQL, replies, the model summarises. Buffr doesn't have that surface today.

The closest cousin buffr does have is `scheduleClassify` — but that's app code firing an LLM call, not the LLM asking the app to do work.

---

## In this codebase

_Not implemented — intentionally absent._ The five AI services all return on the first response. The closest reference points showing the single-call shape:

**No tool loop:**           `src/services/ai/summarize.ts` → `summarize()` L42–L105 — single Anthropic SDK call (`callClaude` L12–L22) or OpenAI fetch (`callOpenAI` L24–L40); the return is final
**No tool dispatch:**       `src/services/todos/expand.ts` → `expandTodo()` L191+ — even when validation fails, the retry pattern is a re-call of the same chain with a stricter prompt, not a model-chosen tool invocation
**No tool loop (interpret):** `src/services/ai/interpret.ts` → `interpretEntry()` L114–L149 — markdown out, single call, no observation step (the 5th chain, added 2026-05-10)
**No agent loop file:**     no `src/services/ai/agent.ts`, no `orchestrator.ts`, no graph anywhere in `src/services/ai/` or `src/services/todos/`
**Architectural anchor:**   the rule is documented in [02-single-purpose-chains](./02-single-purpose-chains.md) and [12-why-no-agents](./12-why-no-agents.md) — adding tool-calling means a new service file, not a modification

---

## Elaborate

### Where this pattern comes from
Tool calling came out of the ReAct paper (2022) and was popularised by ChatGPT plugins, then formalised in Claude's tool-use API and OpenAI's `tools` parameter. The pattern: let the model decide which tool to invoke, run it, give it back the result, repeat.

### The deeper principle
**Tools turn an LLM from a "function" into a "loop."** That's a major capability upgrade and a major reasoning-about-cost downgrade. Tool loops can run unboundedly, can call expensive operations, can hallucinate tool names. Add them deliberately, not by default.

### Where this breaks down
- Without tools, the model can't navigate large data. Stuffing everything into the prompt fails at scale.
- Tool loops without budget caps can run away. Production tool agents need timeouts, max iterations, cost ceilings.

### What to explore next
- [12-why-no-agents](./12-why-no-agents.md) → buffr's explicit decision against multi-step.
- [07-rag](./07-rag.md) → the alternative when context is too big.

---

## Tradeoffs

We traded the capability ceiling of tool loops (model navigates, app responds) for predictable single-call cost and trivial debuggability — every chain is one prompt, one parse, one persist, and the app stays in control of every dollar spent.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (no tool calling)   │ Alternative (tool-loop agent)  │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Money            │ 1 call/chain at $0.0001-$0.04  │ N iterations × $0.04 each;     │
│ ($/call)         │ predictable per-feature cost   │ runaway loop costs $1+/call    │
│                  │                                │ without iteration cap          │
│ Latency          │ 1 round-trip ~800ms-5s         │ N round-trips × ~1.5s = 5-30s  │
│                  │ per chain; bounded             │ per query; unpredictable       │
│ Failure mode     │ JSON parse fails → validator   │ tool-name hallucination,       │
│                  │ rejects → soft skip            │ runaway loop, mid-loop network │
│                  │                                │ drop, stuck "thinking" state   │
│ Debuggability    │ one request, one response —   │ N requests + N tool responses; │
│                  │ trace lives in one log line    │ replay requires full state log │
│ Capability       │ ceiling: data must fit in     │ unbounded — model navigates    │
│ ceiling          │ prompt at call time            │ corpus, calls APIs, iterates   │
│ Provider features│ structured outputs (OpenAI),   │ tool-use blocks (Anthropic),   │
│ used             │ prompt rules (Claude) — both   │ function calling (OpenAI) —    │
│                  │ available to all 5 chains      │ would unlock both              │
│ Cost ceiling     │ implicit: one call per fire,   │ explicit cap required — max   │
│ control          │ no loop                        │ iterations + per-call timeout  │
│                  │                                │ + total $ ceiling per request  │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

We gave up the capability ceiling of tool loops. The five chains can only solve problems where the model has everything it needs in the prompt at call time — `buildContext()` for expand fetches the last 3 days plus 5 siblings, `buildCaptionInput()` grabs the last 5 captions, and that's the whole world the model sees. The day a user asks "find me every day I wrote about Project X over three years" or "look up the weather on the day I felt worst this month," there is no single-call shape that answers it. We'd have to ship that as a new service file with iteration caps and timeouts — not by modifying the existing chains.

We also gave up the architectural option of letting the model choose its own next step. Today the app decides: classify runs after every scan, summarize runs on user save, expand fires when the user taps "expand". A tool-loop agent would let the model decide "I need more context, let me search for similar entries first" — which is genuinely powerful for open-ended queries. We don't have any open-ended queries today.

The implicit cost is that future features needing navigation are forced into a new architectural shape (agent loop in a separate file) rather than incrementally extending the existing chains. That's a feature, not a bug — we want agent loops to be deliberately isolated, not creeping into chains designed to be one-shot.

### What the alternative would have cost

A tool-loop agent on top of the existing chains would have added three categories of cost. First, runaway-loop risk: without explicit max-iteration caps and per-call timeouts, a misbehaving model can spin for 20 iterations and rack up $20 of LLM bills on a single user query. The mitigation (iteration caps + cost ceilings + timeouts) is straightforward code, but it's code we don't have to write today because we don't have the loop.

Second, debugging cost. A single-call chain trace is "prompt + response + validation result" — three artifacts. An agent trace is "prompt + tool-call request + tool execution result + next-prompt + ... + final response" with N iterations of branching. Replaying a failed agent run requires the full intermediate state log. We've all seen LangChain Trace UIs; they exist because raw logs are unreadable.

Third, the failure modes balloon. Tool-name hallucination (the model invents `search_entries_v2` when only `search_entries` exists) is a real production failure mode in agents. Tool argument hallucination, mid-loop network drop, partial JSON in a tool response — every one of these has to be handled. The current codebase has none of them because there are no tools.

### The breakpoint

The pattern flips the day a single feature genuinely requires navigation — concretely, the day a feature can't be answered with "the entry text + the last 3 days + 5 siblings". "Find every day I wrote about Project X over three years" is the trigger shape. The fix isn't to retrofit tools into expand or summarize; it's a new service file (`src/services/ai/agent.ts` or similar) with explicit max iterations, per-call timeout, per-request cost ceiling, and a sanitized tool schema. The five existing chains stay untouched.

A secondary trigger: if the corpus grows past what fits in a prompt. Today the user is one person with sporadic use; the most context any chain assembles is ~3-5KB of text. The day a power user has hundreds of entries per day and "the last 3 days" no longer fits in a 200K-token context window, navigation becomes unavoidable — but that's also when [07-rag](./07-rag.md) becomes relevant, and RAG is the simpler answer than tool calling for "find relevant entries before answering."

### What wasn't actually a tradeoff

Function calling (the API mechanism) vs tool calling (the architectural pattern) wasn't a real choice. Both providers expose function-calling APIs, but using them in a single-shot way (one tool call, one tool response, one final answer) doesn't unlock anything the current single-chain pattern doesn't already give us. The interesting tradeoff is the *loop*, not the API.

---

## Tech reference (industry pairing)

### Anthropic tool use

- **Codebase uses:** not implemented — named as the provider-specific mechanism that would be used if tool calling were added (tool-use blocks in the Anthropic API).
- **Why it's here:** the file frames buffr's deliberate no-tools decision against Anthropic's tool-use API as the concrete alternative.
- **Leading today:** Anthropic tool use — `adoption-leading`, 2026.
- **Why it leads:** parallel tool calls, streaming tool results, multi-turn tool use with native SDK support; reliable structured tool-call parsing.
- **Runner-up:** OpenAI function calling — older, broader ecosystem; less reliable for parallel calls; both APIs now converge in feature surface.

### OpenAI function calling

- **Codebase uses:** not implemented — named as the alternative provider mechanism alongside Anthropic tool-use blocks.
- **Why it's here:** the file names both Anthropic tool-use and OpenAI function calling as the APIs that would unlock the loop pattern buffr deliberately avoids.
- **Leading today:** Anthropic tool use — `adoption-leading`, 2026.
- **Why it leads:** see the Anthropic tool use subsection above.
- **Runner-up:** OpenAI function calling (this tech) — broad ecosystem adoption, well-documented, JSON-schema-driven tool definitions; older but widely used in production agent systems.

---

## Project exercises

**Status:** `learn-only` for buffr. The curriculum's Phase 4 (Agents and tool use) recommends Path C anchored to contrl-mo, not buffr. buffr's existing Path B option (`[B4B.1]`–`[B4B.5]` — classifier → mini-agent loop) remains an option but is currently deferred; the buffr-side interview defense is "why no tool calls" (see [12-why-no-agents.md](./12-why-no-agents.md)).

### Optional — Path B: classifier mini-agent loop (deferred)

- **Exercise ID:** `[B4B.1]`–`[B4B.5]` *(Phase 4 — deferred for buffr; build only if interview targeting demands an agent surface in buffr specifically)*
- **What to build:** Wrap `classifyTodo` in a mini-loop — classify → if `classifier_confidence < 0.7`, retrieve via Phase 2A RAG → re-classify with retrieved context → finalize. Tools: `retrieve_similar_todos`, `get_user_override_history`. Termination: confidence ≥ 0.7 or 2 iterations.
- **Why it earns its place:** would turn buffr's heuristic-first cascade into a true agent loop with retrieval. Only earns its place after Phase 2A ships — otherwise there's nothing to retrieve.
- **Files to touch:** `src/services/todos/classify.ts` (wrap), new `src/services/todos/classifyAgent.ts`. Depends on the embedding pipeline from Phase 2A.
- **Done when:** confidence < 0.7 paths route through retrieval; eval on 50 ambiguous todos shows lift over single-shot classify; termination is bounded.
- **Estimated effort:** `≥1 week` (requires Phase 2A complete).

---

## Summary

Tool calling is the pattern that wires a stateless text model to a stateful outside world: the model emits a structured request, the app runs it, the result is fed back as an observation, and the loop continues until the model returns a final answer. This codebase deliberately does not implement it — every chain in `src/services/ai/` returns on the first response, the closest cousin being `scheduleClassify` which is app code firing an LLM call, not the model asking the app to do work. The constraint that drove it is that every buffr feature is a one-shot transformation (text → JSON for four chains, text → markdown for `interpret`) where the data the model needs is already in hand at call time via `buildContext()`. The cost is that features genuinely needing navigation — "find me the day I was sickest last month" — can't be expressed as a single chain and would require a new service file with iteration caps and timeouts.

Key points to remember:
- Every chain is one-shot: prompt → output → done. There is no observation step.
- No `src/services/ai/agent.ts`, no orchestrator, no graph anywhere in `src/services/ai/` or `src/services/todos/`.
- Control flow is always app-fires-LLM, never LLM-fires-app — the app stays in control of cost and iteration.
- A tool loop is a major control-flow upgrade (runaway cost, harder debugging, tool-name hallucination) — add deliberately, not by default.
- The cost is a ceiling on task complexity — when a feature genuinely needs navigation, tool calling goes in a new file, not into the existing chains.

---

## Interview defense

### What an interviewer is really asking
"Why no tool calling?" is the senior interviewer's tell that they want to see whether I can articulate when a feature *needs* tools versus when it doesn't. The answer they're checking for: do I understand that tool calling is a control-flow upgrade with a cost upgrade, and do I know what kind of feature would justify it? The trap is the candidate who says "I just didn't get to it" — that signals I haven't thought about the design space.

### Likely questions

[mid] Q: Concretely, what does "no tool calling" mean for the five chains in this codebase?
      A: It means every call returns on the first response. `summarize`, `caption`, `classify`, `expand`, and `interpret` all hand the model a prompt, get back a string (JSON for the first four, markdown for interpret), parse or clean it, and persist or render. Nowhere in the codebase does the model emit something like `{tool: "search_entries"}` and the app run a SQL query and feed the result back. The closest cousin is `scheduleClassify` — but that's app code firing an LLM call, not the LLM asking the app to do work. The control flow is always: app decides → LLM responds → app persists or renders.

```
[every buffr chain — uniform shape]

  app decides to call (commit / button tap / scan finishes null)
        │
        ▼  buildPrompt() / buildContext() / buildCaptionInput()
  single LLM call (Sonnet/Haiku/4o/4o-mini)
        │
        ▼  one response — string or markdown
  parseJson + validate  OR  cleanMarkdown
        │
        ├─ valid → persist to SQLite OR render in modal
        └─ invalid → soft skip (or 1 retry for expand)

  (no observation step, no tool dispatch, no loop)
```

[senior] Q: Is there a feature in buffr today where adding tool calling would be a clear win?
         A: Not today. Every feature is a one-shot transformation: "summarise this day", "caption this day", "classify this line", "expand this todo". The data the model needs is already in hand at call time, packed into the prompt by `buildContext()`. Tool calling pays off when the model needs to *navigate* — search a corpus, query a DB, hit an external API — and the cost of stuffing every possibility into the prompt is too high. Buffr's prompts are small and the corpus is one user's journal. Nothing to navigate.

```
                  Path taken (one-shot chains)         Alternative (tool loop available)
                  ──────────────────────────           ────────────────────────────────
data the model    everything in prompt at call time    model navigates — fetches what
needs                                                  it needs as it works
$ per query       $0.0001-$0.04 (one call)             $0.04 × N iterations; loops can
                                                       run 5-20 turns unchecked
latency           ~800ms-5s, bounded                   ~5-30s, unbounded without timeout
failure modes     parse fail / validation fail /       all of those PLUS tool-name
                  network — 3 categories               hallucination, runaway loop,
                                                       mid-loop network drop — ~7 cats
features served   summarize / caption / classify /     anything navigational: corpus
today             expand / interpret — all one-shot    search, multi-day synthesis,
                                                       external API lookups
new file needed?  no — fits existing service shape     yes — agent.ts with caps + log
```

[arch] Q: Suppose I add a feature: "find me every day I wrote about Project X." Would that be the moment for tool calling?
       A: That's exactly the moment. The model would emit `{tool: "search_entries", input: {query: "Project X"}}`, the app would run an FTS5 or pgvector search, return the rows as an observation, and the model would synthesise. I'd build it as a new service file — not a modification to the four existing chains. It would need a max-iteration cap, a per-tool-call timeout, and a cost ceiling (otherwise a runaway loop costs real money). Tool calling is a major control-flow upgrade and I'd want it isolated.

```
At "find me every day I wrote about Project X" (corpus query):

  ┌─ Existing chains (summarize/caption/classify/expand/interpret) ─┐
  │ unchanged — all one-shot, all stay in src/services/{ai,todos}/  │
  └────────────────────────────────────────────────────────────────┘
              │ (no modifications)
              ▼
  ┌─ NEW service: src/services/ai/agent.ts ────────────────────────┐
  │ tool registry: { search_entries, get_entry_text, ... }         │
  │ max_iterations: 5    ◀── BREAKS FIRST if uncapped — $$ runaway │
  │ per_call_timeout_ms: 8000                                       │
  │ total_cost_ceiling: $0.50/request                               │
  │ tool-name allowlist (reject hallucinated names)                 │
  └────────────────────────────────────────────────────────────────┘
              │
              ▼
  ┌─ Tool implementations ─────────────────────────────────────────┐
  │ search_entries → FTS5/pgvector SQL                              │
  │ get_entry_text → SELECT text FROM entries WHERE id=?            │
  └────────────────────────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: Tool calling and agents are the standard way to build AI apps in 2026. Are you sure you're not just behind on the tooling?

A: I'm not behind on the tooling — I read the Claude tool-use API and OpenAI's `tools` parameter and I deliberately didn't reach for them. Tool calling turns the LLM from a function into a loop, and a loop has runaway cost, harder debugging, and tool-name hallucination as failure modes. Adding it without a feature that needs it would burn budget for no quality gain. The five chains (four in `src/services/ai/` plus `src/services/todos/classify.ts`) work because the data they need fits in the prompt; the moment a feature genuinely needs to navigate (search across the archive, hit an external API, run code) I'd add tools — in a new service file, with iteration caps and timeouts. The decision isn't "tools are bad", it's "tools are the wrong tool for one-shot transformations". I'll grant the dodge though: if I'm wrong about a future feature, the day it ships will look like "we should have built the tool-loop sooner".

```
                  Path taken (no tools today)         Suggested (tool calling now)
                  ──────────────────────────          ───────────────────────────
features served   5 one-shot transformations           same 5 + nothing new today
                  fit current data model               (no feature needs it)
$ per chain       $0.0001-$0.04 fixed                  $0.04 × N — variable, capped
debug surface     prompt + response + validator        full agent trace with N-step
                  (3 artifacts)                        replay; needs Trace UI
failure modes     3 categories                         7+ categories — tool-name
                  caught by validator                  hallucination, runaway loop,
                                                       mid-loop network drop, etc.
when this flips   no feature needs navigation today    day a feature genuinely needs
                                                       corpus search or external API
isolation         no agent code → no agent failures    new service file with caps;
                  in the codebase                      existing 5 chains untouched
2026 industry     "behind the curve" criticism is      shipping LangGraph for problems
fit               framing — capability without a       that don't have it is the more
                  feature is liability                 expensive mistake
```

### One-line anchors
- "Tools turn an LLM from a function into a loop. Add them deliberately."
- "Every chain returns on the first response. There is no observation step."
- "App-fires-LLM, not LLM-fires-app. The app stays in control."
- "The day a feature needs to navigate, tools go in a new file."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory (the "buffr's call" vs "an agent with tools" contrast). Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain "no tool calling in buffr" to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/ai/summarize.ts` and the absence of any orchestrator/agent file
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

You're asked to add a feature: "expand this todo with context from any past entry that mentioned similar ideas." The naive shape would be a tool-call loop where the model emits `{tool: 'search_entries', input: {query}}`, the app runs FTS5/pgvector, returns hits, the model synthesises. Walk what files would change in the diff: `expand.ts`? A new service file? `validate.ts`? What max-iteration cap and timeout would you set, and where in the codebase would those constants live? Why is it not shipped today?

Write your answer. 3–5 sentences minimum. Then open `src/services/ai/summarize.ts` L42–L105 (current single-call shape) and `src/services/todos/expand.ts` L211–L266 to compare against the proposed loop.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/ai/summarize.ts` (no observation step) to support what exists
→ Point to where a new `src/services/ai/agent.ts` with iteration cap + timeout would land if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly (or correctly named that no such file exists)
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0). Tool calling is intentionally absent — anchored on the closest single-call sites.
Updated: 2026-05-10 — chain count bumped from 4 to 5 (interpret added; still no tool calling).
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block.
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram; added App / Provider / Tool layer labels to the contrast diagram since it crosses boundaries.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for Anthropic tool use, OpenAI function calling.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (telephone-hotline-with-callouts metaphor opening / 3 layered sub-sections — the tool-calling loop, why buffr doesn't, what one-shot gives up — each with frontend bridges and concrete consequences / principle paragraph on "the cheapest agent is no agent").

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (hotel-concierge-on-hold scenario → "model as concierge, app code as dispatcher, every step another round-trip" pattern naming → bolded stakes pivot to `buildContext` pre-fetching for `expand` vs 4-round-trip agentic alternative → before/after bullets on tool-loop vs one-shot → one-line "cheapest agent is no agent" metaphor).

---
Updated: 2026-05-14 — v1.32.0 pass: swapped Why care + How it works Move 1 anchors from physical-world analogies (hotel concierge / telephone hotline operator, both banned per v1.31.0/v1.32.0) to level-1 primitives (a JavaScript generator function `function*` driven by `next()`; tool calls are LLM-emitted `yield`s with a loop driver running the requested fetches). Added Move 1 mnemonic diagram (tool-loop vs one-shot side-by-side) + 3 Move 2 sub-section diagrams: hypothetical 3-iteration agent trace, expand() under one-shot vs agentic walkthroughs, sixth-capability cost ledger. Total: 4 new diagrams.
