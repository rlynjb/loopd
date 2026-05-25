# What an LLM actually is

**Industry name(s):** Large language model, autoregressive transformer, next-token predictor
**Type:** Industry standard

> An LLM is a function: text in, text out. Not a database, not a reasoner, not a planner — those are systems built around it. Treating it as more than a function is the root of most LLM bugs.

**See also:** → [02-tokenization](./02-tokenization.md) · → [03-sampling-parameters](./03-sampling-parameters.md) · → [04-structured-outputs](./04-structured-outputs.md) · → [`ai-features-in-this-codebase`](../ai-features-in-this-codebase.md)

---

## Why care

### Move 1 — The grounded scenario

You're looking at `src/services/ai/summarize.ts`. The function takes a day's entries (prose, habits, todos, clips) and returns an `AISummary` object: headline, narrative, tone, tags. Your mental model says "the LLM reads the entries and *understands* them." But what actually happens at the API call boundary is this: you serialize the day into a string, send the string to Anthropic's endpoint, and a string comes back. Your code parses that returned string into JSON. There is no "understanding" anywhere — there's text in, text out, and your code doing the rest.

### Move 2 — Name the question the pattern answers

That what-is-this-thing-I-just-imported question is what the function-not-an-entity framing answers. Not "how do transformers work internally" (orthogonal — interesting but not load-bearing for production engineering); the answer is the operational shape: an LLM is `f(string) → string`. Treating it as anything more — a memory, an agent, a tool that can take action — is the design error that produces unrecoverable systems.

### Move 3 — Why answering that question matters

**What breaks without the discipline:** the most expensive bugs in LLM systems are the ones where the engineer assumed the model knew something it doesn't. "The model knows the user's previous entries" — no, it knows what's in the prompt. "The model remembers what we discussed last session" — no, it has no memory across calls. "The model verified the JSON is valid" — no, it produced text that *looked like* JSON, and your parser is what verified it. In buffr today, every chain in `src/services/ai/` is a pure `string → string` function at the call site (with one input serialization step and one output parse step around it); when a chain returns garbage, the bug is always in the serialization, the prompt, or the parser — never in "the model misunderstood."

### Move 4 — Concrete before/after

Without the discipline (treating LLM as more than a function):
- Engineer assumes the model "remembers" the user's preferences across calls
- Builds the caption chain without passing recent captions as input
- Variants converge to the same phrasing within 3 days because every call is stateless
- Debug time: weeks (mental model is wrong, so the symptom doesn't map to a cause)

With the discipline (LLM as `string → string`):
- Engineer treats every call as fully independent
- Passes `recentCaptions` array explicitly in every call to `caption.ts`
- Variants stay distinct because the anti-repetition signal is in the input
- Debug time when something goes wrong: minutes (look at the input string; look at the output string; the model didn't "decide" anything outside those)

### Move 5 — The one-line summary

An LLM is `f(string) → string`. Every state, every memory, every "knowledge" of context lives in your code or in the prompt — never inside the model between calls.

---

## How it works

### Move 1 — The mental model

```
   Input (a string)
        │
        ▼
   ┌─────────────────────────┐
   │       LLM API call       │
   │   (predicts next token   │
   │    repeatedly until      │
   │    stop condition)       │
   └─────────────────────────┘
        │
        ▼
   Output (a string)
```

The model has no state between calls. Every call is independent. The model "knows" only what you put in this call's input.

### Move 2 — The layered walkthrough

**Layer 1 — the I/O is text, the inside does math on tokens.** The string you send gets tokenized (concept 2). Each token becomes a vector. The model runs many layers of attention and feed-forward math on those vectors. The output is a probability distribution over the next token. Sample one token, append it, repeat. Stop when you hit a stop token, a length limit, or your timeout.

```
   "Summarize: today I built"
        │
        ▼ tokenize
   [4096, 318, 28, 1909, 257, 1813]
        │
        ▼ N transformer layers
        │
   distribution over next token
        │
        ▼ sample (per concept 3 — sampling parameters)
   token "auth"
        │
        ▼ append + repeat
   token "flow"
        │
        ▼ ... until stop token or length cap
        │
        ▼ detokenize
   "auth flow"
```

If you're coming from frontend, this is the same shape as a `fetch()` to any other API: serialize → request → response → parse. The model isn't more magical at the call site than `fetch('/api/users')` is — it just costs more, takes longer, and the response is non-deterministic.

**Layer 2 — what the model is NOT.** It is not a database. It cannot retrieve a specific journal entry from 6 months ago unless you put it in the prompt. It is not a planner. It does not "decide" to call a tool — your code does, after parsing the model's output (concept 4-tool-calling for agents). It is not a reasoner with verified steps. Its chain-of-thought text is more text it produces, with no guarantee any of it corresponds to an actual reasoning operation.

```
   Things engineers wrongly think the model does
   ──────────────────────────────────────────────
   "remembers our previous chat"      →  NO. Stateless every call.
   "knows the current date"            →  NO. Frozen at training cutoff.
   "verified the JSON is valid"        →  NO. Your parser did.
   "decided which tool to call"        →  NO. It wrote text; your code parsed.
   "knows facts about the user"        →  NO. Only what's in this prompt.
```

**Layer 3 — what the consequences are at the call site.** Every chain in buffr is built around this constraint. `caption.ts` takes a `recentCaptions: string[]` parameter because the model can't remember last week's captions. `expand.ts` takes a `siblingTodos: string[]` parameter because the model can't look up other todos on its own. `summarize.ts` takes the day's prose explicitly because the model can't query the database. The chain's job is to put *exactly* what the model needs into the prompt and parse exactly what comes back — nothing more.

If you're coming from frontend, this is the same as building a controlled `<input>`: every piece of state has to be explicitly passed in and explicitly read out. There is no implicit state.

### Move 3 — The principle

LLMs are functions over strings, not entities. Build every system as if the model is reset between calls (because it is). Anything that needs to persist — memory, retrieval, history, decisions — lives in your code or in the prompt. Never in the model.

The full picture is below.

---

## What an LLM is — diagram

```
┌─ Your code (where all state lives) ──────────────────────────────────┐
│                                                                      │
│   ┌─ Serialize ───┐    ┌─ LLM call ──┐    ┌─ Parse ─────────────┐    │
│   │ build prompt  │    │ HTTP POST   │    │ JSON.parse / regex  │    │
│   │ from your     │ ─→ │ to provider │ ─→ │ / Zod validate /     │    │
│   │ DB, history,  │    │ endpoint    │    │ markdown render      │    │
│   │ retrieved     │    │             │    │                      │    │
│   │ docs, schemas │    │             │    │                      │    │
│   └───────────────┘    └─────────────┘    └─────────────────────┘    │
│         │                    │                      │                │
│         │                    │                      │                │
│         └─ all state ───────┘    ←  stateless  →  └─ all logic ────┘ │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

   The boundary inside the LLM:
   ─────────────────────────────
   string in → tokens → N attention layers → distribution → token out → string out
   (nothing persists; every call is fresh)
```

---

## In this codebase

**Case A — every chain in `src/services/ai/` is built as `f(string) → string`.**

**Files:**
- `src/services/ai/summarize.ts` — `summarize(entry, lastNDays) → AISummary`
- `src/services/ai/caption.ts` — `generateCaption(summary, recentCaptions) → CaptionVariants`
- `src/services/ai/expand.ts` — `expandTodo(todo, type, siblings, recentDays) → ExpandedTodo`
- `src/services/ai/classify.ts` — `classifyTodo(text) → ThinkingMode`
- `src/services/ai/interpret.ts` — `interpretDay(date, summary, prose) → string` (markdown)

Each chain's function signature names exactly what gets serialized into the prompt. Nothing else gets in. No chain calls SQLite directly from inside its body — the orchestrator in `compose.ts` does the lookup and passes the result in. That's the discipline: the chain is a pure-ish function over its inputs.

**Line range to read:** roughly L40–L80 of each chain file — the parameter list is the I/O contract.

---

## Elaborate

### Where this pattern comes from

The "LLM as function" framing became canonical via Anthropic's own developer documentation and the early LangChain abstractions. Before this framing was widespread (~2022), engineers built apps where "the model" was treated as an entity with persistent state — those apps invariably failed in production when the model "forgot" things between calls.

### The deeper principle

State and capability live in your code, not in the model. The model is a powerful subroutine; the orchestration is your job.

### Where this breaks down

For very simple use cases (one-shot completions, simple Q&A), thinking of the model as an entity instead of a function isn't load-bearing — the input fits in one call, no state needed. The framing matters the moment you build anything with history, memory, retrieval, or multi-step flow. For agentic systems (concept 4-agents-vs-chains), the "model as function" framing is more important, not less — the loop is in your code.

### What to explore next

- [04-structured-outputs](./04-structured-outputs.md) — the contract pattern that turns the function's output into something safe to consume
- [08-provider-abstraction](./08-provider-abstraction.md) — when the function is `f`, swapping providers means swapping the implementation of `f`, nothing else
- [`04-agents-and-tool-use/01-agents-vs-chains`](../04-agents-and-tool-use/01-agents-vs-chains.md) — agents loop the function; the function itself stays stateless

---

## Tradeoffs

```
┌──────────────────┬─────────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Treating LLM as function    │ Treating LLM as entity       │
├──────────────────┼─────────────────────────────┼──────────────────────────────┤
│ Mental overhead  │ Every input must be         │ Implicit assumption that     │
│                  │ explicit; verbose call sites│ "the model knows"            │
│ Debug cost       │ Bugs map to input/output    │ Bugs feel mysterious; mental │
│                  │ in minutes                  │ model is wrong               │
│ Code shape       │ Pure functions, explicit    │ Stateful objects, hidden     │
│                  │ params, easy to test        │ couplings                    │
│ Provider swap    │ Trivial (swap f's impl)     │ Hard (per-provider state)    │
└──────────────────┴─────────────────────────────┴──────────────────────────────┘
```

### What we gave up

The function framing makes call sites verbose. Every chain takes 4–8 parameters explicitly because nothing is hidden. A "stateful agent" framing would let the orchestrator hide some of that behind opaque session objects.

### What the alternative would have cost

A stateful framing would make every chain a black box where the state is opaque. Debugging would require reconstructing what the agent thought it knew, instead of inspecting the literal input string. The cost compounds — every new chain has to be onboarded to the same opaque state machinery.

### The breakpoint

The function framing wins as long as the system is small enough that explicit state is manageable. For very large systems with many chains sharing context, an agent-with-state framing earns its keep — but the underlying calls to the LLM are still pure functions. The state lives in your agent, not in the model.

---

## Tech reference (industry pairing)

### LLM provider SDKs (Anthropic / OpenAI)

- **Codebase uses:** `@anthropic-ai/sdk` ^0.90.0 for Claude calls (primary), raw `fetch()` for OpenAI calls (no SDK dep). See `src/services/ai/config.ts` for the toggle.
- **Why it's here:** the SDKs are thin HTTP wrappers — they normalize request shape and retry handling. They do not add state.
- **Leading today:** Anthropic Claude Sonnet 4.6 + Haiku 4.5 for buffr's primary chains; OpenAI GPT-4o + 4o-mini as alternate. Both are pure function-call interfaces.
- **Why these lead:** strongest instruction-following at price point for buffr's chain sizes (under 2k input tokens per call).
- **Runner-up:** Google Gemini 2.x for very long context windows; not used in buffr because no chain exceeds 8k input tokens.

---

## Project exercises

### B-foundational — Audit every chain for hidden state assumptions

- **Exercise ID:** `audit-chain-state`
- **What to build:** walk all 5 chains in `src/services/ai/` and verify each is truly stateless. For each chain: list every parameter; trace where it comes from; confirm no chain reads from SQLite or globals inside its body. Document any leak in `docs/spec.md`.
- **Why it earns its place:** catches drift before it causes the kind of "the model knows" bug that's expensive to debug later.
- **Files to touch:** all `src/services/ai/*.ts` chain files; potentially `compose.ts` if a leak is found.
- **Done when:** each chain is documented in `docs/spec.md` with its full I/O signature, and any leak is either fixed (move the lookup into the orchestrator) or explicitly justified.
- **Estimated effort:** 1 hour.

---

## Summary

### Part 1 — concept recap

An LLM is `f(string) → string`. It has no state between calls; every piece of context — history, retrieval, schemas, recent outputs — has to be put into the prompt explicitly. Buffr's 5 chains are all built this way: each chain's signature names the inputs, the orchestrator in `compose.ts` does the lookup, the chain itself is pure. The discipline pays off in debugging speed (bugs map to specific input or output strings) and provider-swap freedom (the model is the function's implementation; swapping is local).

### Part 2 — key points to remember

- LLM = function, not entity. Stateless between calls.
- All state lives in your code or in the prompt. Never inside the model.
- Every chain in buffr is `f(serialized inputs) → parsed output`. The orchestrator is what makes it useful.
- Bugs in LLM systems almost always map to (a) wrong input, (b) wrong prompt, (c) wrong parser. Rarely to the model itself.
- The framing matters more for complex systems (agents), not less.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "what is an LLM" or "how do you architect an LLM-powered app," they're probing for the function framing. Engineers who treat the model as an entity build brittle systems; engineers who treat it as a function build systems that scale and survive provider changes.

### Likely questions

**Q [mid]:** What does the model "know" between calls?

**A:** Nothing. Every call is stateless from the model's side. Anything that needs to persist — conversation history, user preferences, retrieval results — lives in your code and gets passed in as part of the prompt. In buffr, every chain takes explicit inputs (e.g., `caption(summary, recentCaptions)`); the orchestrator in `compose.ts` is responsible for collecting those inputs from SQLite before the call.

```
   Stateless model + stateful orchestrator
   ───────────────────────────────────────
   orchestrator (compose.ts)
     ├─ reads SQLite              ← state lives here
     ├─ assembles prompt
     └─ calls chain ──→ chain (pure: prompt in, output out)
                          ├─ HTTP POST to provider
                          └─ parse + return
```

**Q [senior]:** How does the function framing change how you debug?

**A:** Every bug maps to the input string, the output string, or the parser. Reproducing requires only the input — no session state, no environment state, no order-of-calls. In buffr, when a chain returns garbage, I copy the literal request body into a test fixture and replay; if the model returns the same garbage, the bug is the prompt; if it returns valid output, the bug is the parser. The whole debug loop is minutes, not days. Compare to a stateful-agent framing where reproducing requires reconstructing the agent's accumulated context — that's hours of detective work per bug.

**Q [arch]:** When does this framing stop being load-bearing?

**A:** It doesn't. It changes shape as systems grow. For an agent (concept 4-agents-vs-chains), the loop has state, but each call inside the loop is still a pure function — the agent's state lives in your loop, not in the model. For a long-running conversation, the conversation history is your code's responsibility to maintain and trim; the model doesn't remember anything across the calls in the conversation. The framing scales because it correctly models the abstraction boundary; entity-style framings break down the moment you exceed the simplest single-call use case.

### The question candidates always dodge

**Q:** Give me a real bug from a system you shipped where you got the function framing wrong.

**A:** Early in buffr's caption chain, I built `caption(date)` and had the chain look up the day's `AISummary` from SQLite internally. The chain "worked" — until I tried to test it. The test required spinning up SQLite, seeding it, then asserting on the output. When I needed to add the `recentCaptions` anti-repetition input, I had to add another SQLite lookup inside the chain. The chain became a tangled mess of database calls disguised as an LLM function. I refactored: pulled all lookups into `compose.ts`, made `caption(summary, recentCaptions)` a pure function. Tests dropped from 80 lines of setup to 5 lines of fixture input. Adding the next input (themes vector, for variant theme consistency) was trivial. That refactor is the principle in code.

### One-line anchors

- LLM = `f(string) → string`. Stateless every call.
- All state lives in code or prompt. Never in the model.
- Chains are pure functions; orchestrator is what holds state.
- Bugs map to input / prompt / parser. Three places to look.
- The framing scales with system size — it doesn't stop being load-bearing.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the LLM I/O flow: serialize → HTTP call → parse, with "state lives here" labels on the orchestrator and "stateless" labels on the LLM boundary.

### Level 2 — Explain it out loud

Explain in under 60 seconds why every state and capability lives in your code, not the model.

Checkpoints — did you:
- Name "stateless between calls" as the load-bearing fact?
- Give a concrete example of state your code carries (history, retrieval, schema)?
- Name how the framing helps with debugging?

### Level 3 — Apply it to a new scenario

A new requirement: buffr should support a "chat with your last 7 days" feature. The user types a question; buffr responds based on the week's entries. Sketch the I/O signature of the chain and name where the state (conversation history, retrieved entries) lives. What's NOT inside the chain?

Reference: compare your sketch against the existing pattern in `src/services/ai/compose.ts` — the orchestrator does the lookup; the chain takes the inputs.

### Level 4 — Defend the decision you'd change

Defend or oppose: "Buffr should add a `conversationId` parameter to each chain so the model can maintain state across calls." Why or why not?

### Quick check — code reference test

Without opening files:
- What state lives inside `caption.ts`?
- Where does `caption.ts` get its `recentCaptions` input from?
- If the caption chain breaks, what are the three places to look?
