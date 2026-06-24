# Single-purpose chains

**Industry name(s):** Single-purpose chains, prompt pipeline pattern, one-chain-one-job
**Type:** Industry standard · Language-agnostic

> One chain, one job. Pipeline them. When a multi-step flow fails, you know which step failed; when a model upgrade lands, you can swap one chain without affecting the others.

**See also:** → [01-anatomy](./01-anatomy.md) · → [07-output-mode-mismatch](./07-output-mode-mismatch.md) · → [09-chain-of-thought](./09-chain-of-thought.md)

---

## Why care

### Move 1 — The grounded scenario

You have a prompt that takes a user's journal entry and (1) classifies its dominant mood, (2) extracts any `[]` todos, (3) generates a 4-variant caption for vlog use, (4) decides whether the entry is "interesting enough" to surface in tomorrow's prompts. It works most of the time. But: the caption variants started sounding off last week. You don't know if the model decided differently about which entry-features to highlight, or if the mood classification changed and that changed which framing the caption used, or if the todo extraction got more aggressive and a `[]` line is now inside the caption text. The prompt is 400 lines. You can't isolate the failing step because nothing IS a step.

### Move 2 — Name the question the pattern answers

That which-step-failed question is what single-purpose chains answer. Not "is the prompt too long" (length is symptom), not "should we add more rules" (more rules makes it worse) — just *one chain per concern, composed into a pipeline, with the output of one chain becoming the input of the next.* The pattern is functional decomposition applied to LLM calls: each chain has one input shape, one output shape, one prompt that addresses one job, and the pipeline is where they connect.

### Move 3 — Why answering that question matters

**What breaks without it:** every regression is a 4-D problem and every model upgrade is a 4-D risk. Buffr today has 5 chains, each doing one thing: `summarize` (structured daily summary), `caption` (4 tonal variants), `expand` (per-todo typed expansion), `classify` (thinking-mode classifier with heuristic-first short-circuit), `interpret` (long-form markdown reflection). Add the mood/todo/caption/decide chain as one mega-prompt and any regression debug requires holding all four jobs in your head simultaneously.

### Move 4 — Concrete before/after

Without single-purpose chains (one mega-prompt for the journal pipeline):
- Prompt is 400 lines: mood instructions, todo extraction instructions, caption variants, "interesting" decision rules
- Caption variant 2 starts sounding off
- Diagnosis: read all 400 lines, mentally simulate the model's path
- Can't isolate: maybe a tweak to "todo extraction" three weeks ago changed the model's framing of the entry, which the caption section consumed
- Fix: try a tweak, ship, see if it helps, iterate

With single-purpose chains:
- 4 chains: `classifyMood(entry) → mood`, `extractTodos(entry) → todo[]`, `generateCaptions(entry, mood) → caption[4]`, `decideInteresting(entry, mood, todos, captions) → bool`
- Caption variant 2 starts sounding off
- Diagnosis: run `generateCaptions` alone with the affected entry; bisect by chain, not by prompt-line
- Fix: tweak `generateCaptions`'s prompt; verify with eval; ship; other 3 chains untouched

### Move 5 — The one-line summary

Single-purpose chains are the same shape as the Unix-pipe principle applied to LLM calls — small composable tools each doing one thing well, piped together, debuggable by step.

---

## How it works

### Move 1 — The mental model

A pipeline of N small chains, each consuming the previous chain's output and producing input for the next. Each chain has its own prompt, its own model choice (small for classifiers, large for generation), its own eval set, its own observability — all of which are tractable because the chain has one job.

```
   user input
        │
        ▼
   ┌──────────┐
   │ chain 1  │  classify     ◄── small/cheap model
   └────┬─────┘
        │  classification
        ▼
   ┌──────────┐
   │ chain 2  │  extract      ◄── small/cheap model
   └────┬─────┘
        │  todos[]
        ▼
   ┌──────────┐
   │ chain 3  │  generate     ◄── large/capable model
   └────┬─────┘
        │  captions[]
        ▼
   ┌──────────┐
   │ chain 4  │  decide       ◄── small + structured output
   └────┬─────┘
        │
        ▼  bool
   downstream consumer
```

Each chain is its own [01-anatomy](./01-anatomy.md), its own [02-structured-outputs](./02-structured-outputs.md), its own [05-eval-driven-iteration](./05-eval-driven-iteration.md). The composition lives in application code; the chains don't know they're in a pipeline.

### Move 2 — The layered walkthrough

**Layer 1 — one chain per concern.** Each concern (classify, extract, generate, decide) gets its own chain function: its own input shape, output shape, prompt, model, schema. The chain function is a small, typed wrapper around the SDK call.

```
   chain function signature
   ────────────────────────
   classify(text: string): Promise<{type: ThinkingMode}>
   extract(text: string): Promise<TodoItem[]>
   generateCaptions(text: string, mood: Mood): Promise<Caption[]>
   decide(text: string, mood: Mood, todos: TodoItem[], captions: Caption[]): Promise<{interesting: boolean}>
```

If you're coming from frontend, this is the same shape as one React hook per concern (`useUser`, `useNotifications`, `useThreads`) instead of one mega-hook that returns everything. Concrete consequence in buffr: `classify` is a Haiku/4o-mini call (~$0.0001 per call) because it's a simple classifier; `caption` is a Sonnet/4o call (~$0.005 per call) because it's generative. One mega-chain would have to use the more expensive model for everything → 50× cost increase for the classifier work.

**Layer 2 — pipeline composition in application code, not in the prompt.** The chains don't know they're in a pipeline. The composition is application TypeScript: `const mood = await classify(entry); const todos = await extract(entry); const captions = await generateCaptions(entry, mood); …`. This is the structural payoff — each chain stays self-contained, the application code reads as a series of typed function calls, and you can rearrange the pipeline (add a chain, remove one, parallelise two that don't depend on each other) without rewriting any chain's prompt.

```
   pipeline composition (application code, not in any prompt)
   ──────────────────────────────────────────────────────────
   async function processEntry(entry: string) {
     const mood = await classify(entry);                          // chain 1
     const todos = await extract(entry);                          // chain 2
     const captions = await generateCaptions(entry, mood);        // chain 3 (depends on 1)
     const { interesting } = await decide(entry, mood, todos, captions);  // chain 4 (all)
     return { mood, todos, captions, interesting };
   }
```

If you're coming from frontend, this is the same shape as composing React hooks at the component level rather than inside a custom hook. Boundary: chains that don't depend on each other can run in parallel (`Promise.all([classify(entry), extract(entry)])`); the dependency graph is in the application code, not implicit in the prompts.

**Layer 3 — per-chain model choice and observability.** Small models for classifiers (Haiku, 4o-mini), large models for generation (Sonnet, 4o). The per-chain split lets you make this choice per-chain instead of per-pipeline. Buffr's heuristic-first pattern (`heuristicClassify` before `classify`) is the extreme case: 0 model calls for the easy cases, 1 cheap model call for the ambiguous ones.

```
   per-chain model strategy
   ─────────────────────────
   classify:    Haiku (cheap, deterministic, structured-output)
   extract:     Haiku (cheap, deterministic, structured-output)
   generate:    Sonnet (capable, creative, structured-output for the 4 variants)
   decide:      Haiku (cheap, structured-output {interesting: bool})
   
   compared to mega-chain (one Sonnet call doing all four):
   cost: classify+extract+decide = 3× Haiku calls = ~$0.0003
         vs one Sonnet call doing the work = ~$0.005
         16× cost reduction by splitting
```

Per-chain observability is the [03-prompts-as-code](./03-prompts-as-code.md) point applied at chain granularity — `logChainCall('classify', ...)`, `logChainCall('caption', ...)`, etc. — gives you a per-chain success rate, latency, schema-fail rate, cost.

### Move 2.5 — Current state vs future state

Buffr today already has 5 single-purpose chains. This concept is the canonical example *fully implemented* in this codebase. The chains are:
- `summarize` — structured daily summary (`AISummary` shape)
- `caption` — 4 tonal variants of one entry (clean / smoother / reflective / punchy)
- `expand` — per-todo typed expansion (4 schemas: idea / knowledge / study / reflect)
- `classify` — thinking-mode classifier with heuristic-first short-circuit
- `interpret` — long-form markdown reflection

Each lives in its own file under `src/services/ai/`. Each has its own prompt, its own SDK call shape, its own consumer in the application code. The pipeline composition lives in `app/_layout.tsx` and in scattered call sites — not unified into one orchestrator, but the chains themselves are clean.

```
          Now (buffr)                          Later (orchestrator?)
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ chains called from multiple  │  │ chains called from multiple      │
│ call sites:                  │  │ call sites still (chains don't   │
│   summarize: _layout.tsx     │  │ care)                            │
│   caption:  editor.tsx       │  │                                  │
│   expand:   todos[id].tsx    │  │ NO ORCHESTRATOR NEEDED for buffr │
│   classify: scanTodos.ts     │  │ — chains aren't a pipeline; they │
│   interpret: journal.tsx     │  │ each respond to different events │
│                              │  │ in the app                       │
└──────────────────────────────┘  └──────────────────────────────────┘
   already correct                  no Phase B for this concept
```

What doesn't have to change: buffr's chain structure is already the right shape. The 5 chains are 5 separate files, 5 separate prompts, 5 separate concerns. The hypothetical mega-prompt scenario in Move 4 is a counterfactual, not a regression to fix.

### Move 3 — The principle

Single-purpose composition is the bedrock of debuggable software, and LLM chains aren't an exception. Pipelines of small typed functions debug per-function; monoliths debug by guessing. The discipline isn't about LLMs; it's the same discipline that makes Unix pipes, microservices, and React components readable. LLM chains are just another place where the principle applies.

The full picture is below.

---

## Single-purpose chains — diagram

```
┌─ User input layer ──────────────────────────────────────────────────────┐
│  journal entry text                                                      │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
┌─ Service layer (per-chain functions) ───────────────────────────────────┐
│                                                                          │
│  ┌───────────────────┐                                                   │
│  │ classify(text)    │  ── Haiku / 4o-mini                               │
│  │   returns: ThinkingMode                                               │
│  └─────────┬─────────┘                                                   │
│            │                                                              │
│  ┌─────────▼─────────┐                                                   │
│  │ extract(text)     │  ── Haiku / 4o-mini                               │
│  │   returns: TodoItem[]                                                 │
│  └─────────┬─────────┘                                                   │
│            │                                                              │
│  ┌─────────▼─────────────┐                                               │
│  │ generateCaptions(...) │  ── Sonnet / 4o                              │
│  │   returns: Caption[4]                                                 │
│  └─────────┬─────────────┘                                               │
│            │                                                              │
│  ┌─────────▼─────────────┐                                               │
│  │ decide(...)           │  ── Haiku / 4o-mini                          │
│  │   returns: {interesting: bool}                                       │
│  └─────────┬─────────────┘                                               │
│                                                                          │
└────────────┼─────────────────────────────────────────────────────────────┘
             │
             ▼
┌─ Provider layer ────────────────────────────────────────────────────────┐
│  Anthropic / OpenAI                                                      │
│  3 cheap calls + 1 expensive call                                        │
│  (vs 1 mega-call all on Sonnet — 16× more expensive for buffr's mix)    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**The 5 single-purpose chains, all in `src/services/ai/`:**

**File:** `src/services/ai/summarize.ts` · **Function:** `summarize(date)` · **Line range:** L43–L188
**File:** `src/services/ai/caption.ts` · **Function:** `caption(entryText, date, yesterdaySummary)` · **Line range:** L1–L223
**File:** `src/services/ai/expand.ts` · **Function:** `expandTodo(todo, type)` · **Line range:** L1–L150ish
**File:** `src/services/ai/classify.ts` · **Function:** `classify(todoText)` · **Line range:** L1–L160
**File:** `src/services/ai/interpret.ts` · **Function:** `interpret(entryText, framing)` · **Line range:** L1–L149

Plus the heuristic-first wrapper:

**File:** `src/services/todos/heuristicClassify.ts` · **Function:** `heuristicClassify(text)` · **Line range:** L1–~L120 — pre-LLM classification that short-circuits the LLM classify call when confident.

These are not composed into a single pipeline — they're called from different events in the app:
- `summarize` from `app/_layout.tsx` on cold start (yesterday's summary if missing)
- `caption` from the editor pipeline (`src/services/exportPipeline.ts` or similar)
- `expand` from `app/todos/[id].tsx` on user request
- `classify` from `src/services/todos/scanTodos.ts` on entry commit (after the heuristic short-circuit)
- `interpret` from `app/journal/[date].tsx` on modal open

---

## Elaborate

### Where this pattern comes from

The pattern is older than LLMs — Unix pipes, microservices, functional composition. LangChain (the framework, circa 2023) named the pattern for the LLM context with its `Chain` abstraction; the framework's prescriptive piece (the orchestration layer) isn't strictly necessary, but the pattern of "one chain, one job, composed" is industry-standard. The heuristic-first variant (buffr's `heuristicClassify` → `classify` cascade) came from production engineers realising that 80% of classifier calls are easy enough that a regex saves the LLM call.

### The deeper principle

Functional decomposition. Each chain is a pure function of `(input) → output` with one job; composition is the application's responsibility. The same principle that makes a `useEffect` chain debuggable in React or a Unix pipeline debuggable at the shell.

### Where this breaks down

Chains so trivial that the per-chain overhead (a function, a prompt file, an eval set) costs more than it saves. A one-off classification that runs once per app install probably doesn't earn its own chain file — inline it in the call site, accept the small mess. The pattern earns its keep at "this chain will be iterated more than once."

### What to explore next

- [07-output-mode-mismatch](./07-output-mode-mismatch.md) — the failure mode of pipelined chains when output types disagree.
- [09-chain-of-thought](./09-chain-of-thought.md) — within a chain, CoT is the alternative to pipelining short reasoning steps; the choice matters.
- [04-token-budgeting](./04-token-budgeting.md) — small chains have small budgets; large chains have large budgets; the per-chain split lets you allocate per-chain.

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬───────────────────────────┐
│ Cost dimension   │ Single-purpose chains     │ One mega-chain            │
├──────────────────┼───────────────────────────┼───────────────────────────┤
│ Latency          │ N sequential calls        │ 1 call (but longer)       │
│ Cost             │ Per-model: cheap/cheap/   │ All on expensive model    │
│                  │ expensive/cheap = lower   │ for everything            │
│ Debuggability    │ Per-chain logs + evals    │ One opaque prompt         │
│ Files            │ N files per pipeline      │ 1 mega file               │
│ Iteration speed  │ Touch one chain at a time │ Touch one mega-prompt;    │
│                  │                           │ every iteration risks all │
│ Model upgrades   │ Swap one chain's model;   │ Swap requires re-eval of  │
│                  │ others untouched          │ everything at once        │
│ Failure isolation│ Per-step: bisect easy     │ All-or-nothing            │
└──────────────────┴───────────────────────────┴───────────────────────────┘
```

### What we gave up

Single-purpose chains cost you N sequential LLM calls instead of 1, which adds latency (each chain has its own round-trip; pipelined chains have N round-trips serialised). For buffr's pipeline that would be ~4 × 300ms = 1.2s end-to-end vs ~1s for one Sonnet call. The cost is also files: 5 files per pipeline instead of 1. For buffr that's 5 chain files in `src/services/ai/` instead of 1 mega file — easily affordable.

### What the alternative would have cost

The mega-chain saves the per-call round trip but pays in three other dimensions. Cost: forced to use the most-capable model for the entire pipeline; buffr's classifier work would cost ~50× more than the cheap-Haiku version. Iteration speed: every change risks every output; you can't tweak the caption prompt without re-validating the classifier behaviour. Debuggability: one opaque prompt; regressions surface as "the AI feature is worse" without telling you which step regressed.

### The breakpoint

Single-purpose chains are correct from the start in any LLM codebase that ships to production. The breakpoint where you'd consider a mega-chain is "this pipeline runs at 10× the volume and the per-chain round-trip latency has become user-visible" — at that point a single call (with all the per-chain prompts merged into a CoT-style mega-prompt — see [09-chain-of-thought](./09-chain-of-thought.md)) can be faster end-to-end. Buffr is nowhere near that breakpoint.

### What wasn't actually a tradeoff

"Just parallelise the chains." Some chains can be parallelised when they don't depend on each other (`classify` and `extract` in the worked example); some can't (`generateCaptions` needs `mood` from `classify`). Parallelisation is an implementation detail of the pipeline composition, not an alternative to single-purpose chains. The chains themselves are independent regardless; whether they run in parallel or sequence is a separate decision in the application code.

---

## Tech reference (industry pairing)

### Application-level composition (no framework)

- **Codebase uses:** buffr composes its chains in application TypeScript (`app/_layout.tsx`, `src/services/exportPipeline.ts`, etc.). No LangChain, no orchestrator framework.
- **Why it's here:** the chains are independent units; the application code is where they connect. No framework needed for 5 chains called from 5 different events.
- **Leading today:** application-level composition — `adoption-leading` for production-grade prompt pipelines, 2026.
- **Why it leads:** no framework lock-in, no DAG abstraction tax, debugging is reading TypeScript not framework state. Frameworks earn their keep at 20+ chains in complex DAGs; below that, vanilla code is faster.
- **Runner-up:** LangChain — `innovation-leading` for complex agentic flows where the DAG itself is the load-bearing artifact; overkill for buffr-scale.

---

## Project exercises

### B3.12 — Add per-chain logging from concept #3

- **Exercise ID:** `[B3.12]`
- **What to build:** depends on [B3.5](./03-prompts-as-code.md) — once per-chain logging exists, the dashboard naturally surfaces per-chain metrics (calls/day, p99 latency, schema-fail rate, cost). This concept is what makes per-chain observability *actionable* — the chains are already separated; the observability follows the separation.
- **Why it earns its place:** the structural payoff of single-purpose chains is per-chain observability. Without it, the chains are separated but you can't tell which one is misbehaving.
- **Files to touch:** see [B3.5](./03-prompts-as-code.md).
- **Done when:** dashboard shows 5 rows, one per buffr chain, with per-chain metrics.
- **Estimated effort:** see [B3.5](./03-prompts-as-code.md).

### B3.13 — Document the chain dependency graph

- **Exercise ID:** `[B3.13]`
- **What to build:** in `docs/spec.md` (or a new `docs/ai-chains.md`), add a section that names each chain, its input shape, its output shape, its consumer call sites, and any dependencies on other chains' output. The current spec mentions the chains but doesn't draw the dependency picture.
- **Why it earns its place:** the chains are clean; the picture connecting them isn't documented. A new contributor wonders "which chain feeds which" — the answer is currently "grep for the chain name in the codebase."
- **Files to touch:** `docs/spec.md` or new `docs/ai-chains.md`.
- **Done when:** doc has a section listing each chain's input/output/consumers/dependencies, with an ASCII diagram of the dependency graph.
- **Estimated effort:** <1hr.

---

## Summary

### Part 1 — concept recap

Single-purpose chains are the pattern of one chain per concern (classify, extract, generate, decide), composed in application code rather than inside a mega-prompt, with each chain getting its own model choice, eval set, and observability. Buffr is the canonical example fully implemented: 5 chains in `src/services/ai/`, each in its own file, each called from a different event in the app, with the `heuristicClassify` short-circuit providing a free fast path before the LLM classify chain runs. The constraint forcing this pattern is debuggability: when a multi-step LLM flow fails, you need to know which step failed, and that's impossible without per-step boundaries. The cost being paid for buffr's current shape is small — 5 files instead of 1, N round-trips instead of one — and well-bought.

### Part 2 — key points to remember

- One chain, one job. The chain function has one input shape, one output shape, one prompt.
- Composition lives in application code, not inside any chain's prompt.
- Per-chain model choice: cheap models for classifiers, capable models for generation.
- Heuristic-first short-circuits (like buffr's `heuristicClassify`) skip the LLM entirely for easy cases.
- The pattern is Unix pipes applied to LLM calls — small composable tools each doing one thing well.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "how do you structure a multi-step LLM workflow," they're testing whether you've ever debugged a regression in such a flow. The answer that names per-chain decomposition, per-chain model choice, and per-chain observability is the answer of someone who has been there. The answer that says "one big prompt that does everything" is the answer of someone who hasn't.

### Likely questions

**Q [mid]:** Buffr has 5 chains. Why are they separate files instead of one shared `ai.ts` module?

**A:** Three reasons. (1) Each chain is one focused unit — one input shape, one output shape, one prompt — and conflating them into one file means every chain change is reviewed against the wrong context. (2) Per-chain observability needs per-chain identifiers; separate files make the "which chain logged this" question trivial. (3) Each chain is iterated independently — caption-prompt changes don't need to be reviewed alongside classify-prompt changes. The structure isn't aesthetic preference; it's load-bearing for the chains' independent evolution.

```
   one file (rejected)              5 files (chosen)
   ────────────────────             ────────────────────
   ai.ts                            summarize.ts
     export classify(...) {...}     caption.ts
     export caption(...)   {...}    expand.ts
     export expand(...)    {...}    classify.ts
     ...                            interpret.ts
   ─────                            ─────
   PR review: mixed contexts        PR review: one chain at a time
   per-chain iteration: collision   per-chain iteration: independent
   onboarding: grep + filter        onboarding: open the file you need
```

**Q [senior]:** What stops you from merging two of these chains into one mega-chain to reduce latency?

**A:** Three things, in order of importance. (1) The model-choice penalty: merging `classify` (Haiku, $0.0001/call) with `caption` (Sonnet, $0.005/call) means the merged chain has to run on Sonnet for both jobs — 50× cost increase on the classifier work, paid every call. (2) The iteration penalty: every prompt change to either job re-validates against both jobs' eval sets; iteration slows. (3) The observability penalty: per-chain metrics collapse into one "did the mega-chain succeed" metric, which tells you nothing useful when it didn't. The latency saving (one round-trip instead of two — maybe 300ms) is real but small compared to the costs. Single-purpose stays unless latency becomes the load-bearing constraint at high volume.

```
   what's picked                   what merging costs
   ────────────                    ──────────────────
   separate chains                 merged chain
   per-chain model:                forced model:
     classify Haiku                  classify on Sonnet (50× cost)
     caption Sonnet                  caption on Sonnet (same)
   per-chain iteration              shared iteration (slower)
   per-chain observability          collapsed metrics
   ─────                            ─────
   savings: -300ms                  costs: 50× classifier cost,
                                          slower iteration,
                                          worse observability
```

**Q [arch]:** At 100× the call volume, do you still keep chains separate?

**A:** Mostly yes, with one exception. The structural argument (debuggability, model choice, iteration independence) scales fine to high volume. The exception is: when a pipeline of N chains is hot-path AND the N round-trips become user-visible latency, you can merge two adjacent chains that always run together by combining their prompts into one structured-output call (one prompt, schema with both fields, one round-trip). This is structurally a CoT-style merge — the model "does both steps" in one call. Trades back debuggability and model choice for latency. Apply only to chain pairs whose round-trip latency is measured as user-visible; don't speculatively merge.

```
   today (buffr volume)              100× hot path
   ──────────────────                ─────────────
   chains: separate                  chains: separate by default
   round trips: not measured         round trips: measured per pipeline
                                     selective merging where hot:
                                       classify+extract → one structured call
                                     ─
                                     debuggability cost: real but acceptable
                                     for the selectively-merged pair
                                     other chains: still separate
```

### The question candidates always dodge

**Q:** Your `classify` chain has a heuristic-first short-circuit (`heuristicClassify`) that catches ~70% of cases before the LLM runs. Why isn't that a hack? Isn't the whole point of LLM chains to use the LLM?

**A:** It would be a hack if the heuristic and the LLM disagreed on the 80% the heuristic catches — that would mean the heuristic is overfitting and shipping wrong answers. The pattern only works because the heuristic and the LLM agree on the easy cases (verified empirically) and disagree only on the genuinely ambiguous ones. The 80% short-circuit is exactly the right move: zero LLM cost for the cases that don't need LLM judgment, full LLM cost for the cases that do. The candidates who reject this pattern as "not LLM" miss the point: LLM should be the tool of last resort for the cases that need it, not the tool of first resort for everything. Heuristic-first is the production engineer's answer to "stop spending on LLM calls that don't need LLM judgment."

```
   what was picked                   what LLM-for-everything costs
   ───────────────                   ────────────────────────────
   heuristic → LLM (when ambiguous)  LLM (always)
   80% zero-cost                     100% LLM cost
   20% LLM-cost (cases that need it) latency: 200-500ms always
   latency: ~0 for 80%               cost: ~$0.0001 × 100 = $0.01 per 100
   ─                                 ─
   defensible because: heuristic     defensible only if: every case
   and LLM agree on the easy ones    actually benefits from LLM judgment
   (verified empirically)            (not true for classifiers)
```

### One-line anchors

- One chain, one job. Compose in application code.
- Per-chain model choice: cheap for classifiers, capable for generation.
- Heuristic-first short-circuits skip the LLM entirely for easy cases.
- Single-purpose chains debug per-step; mega-chains debug by guessing.
- The pattern is Unix pipes applied to LLM calls.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the three-layer pipeline (user input → service layer with N chains → provider layer). Label each chain's model choice (cheap or capable) and the dependency edges between them.

### Level 2 — Explain it out loud

Explain single-purpose chains to a colleague. Under 90 seconds.

Checkpoints — did you:
- Name the one-chain-one-job rule?
- Name per-chain model choice and the cost savings?
- Name application-level composition (not in any chain's prompt)?

### Level 3 — Apply it to a new scenario

A new requirement: buffr should generate "tomorrow's prompts" — three suggested journal topics based on the user's recent entries and todos.

Without looking at the code: decompose this into chains. What's the input to each chain? What's the output? Which chains depend on which? Which need expensive models, which can use cheap ones?

Sketch your answer in 3–5 sentences with the chain names.

### Level 4 — Defend the decision you'd change

Defend or oppose: "buffr should merge `summarize` and `caption` into one chain — they both run on the day's entries and currently make two round trips. One Sonnet call would be faster."

### Quick check — code reference test

Without opening files:
- How many AI chains does buffr have?
- Where do they live (directory)?
- Which one has a heuristic-first short-circuit, and where does the heuristic live?

---
