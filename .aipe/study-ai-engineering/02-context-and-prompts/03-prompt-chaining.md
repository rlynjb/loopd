# Prompt chaining

**Industry name(s):** Prompt chaining, multi-step LLM pipeline, chained calls
**Type:** Industry standard

> Break a multi-step task into single-purpose chains, pipe outputs into inputs. Each chain has one job; errors isolate; cheaper models can run earlier steps. The tradeoff: more latency, more cost, more complexity.

**See also:** → [`01-llm-foundations/01-what-is-an-llm`](../01-llm-foundations/01-what-is-an-llm.md) · → [`01-llm-foundations/04-structured-outputs`](../01-llm-foundations/04-structured-outputs.md) · → [`ai-features-in-this-codebase`](../ai-features-in-this-codebase.md)

---

## Why care

### Move 1 — The grounded scenario

You're building buffr's day-summary feature. The end product is 4 tonal caption variants for a day. You could do it in one LLM call: "given this day, produce a structured summary AND 4 captions in 4 tones." The prompt is complex. The output schema is big. Two failure modes mix: schema mismatch on the summary part, tone-confusion on the captions part. When one fails, both are unusable. You can't selectively retry — you re-run everything. Buffr instead splits into two chains: `summarize` produces the AISummary (the "tone-agnostic gist"); `caption` consumes that summary and produces 4 tone-variants. Each chain has one job. When `caption` produces a bad variant, you re-run `caption` only. Sonnet handles the summary; the caption chain could run on Haiku if cost mattered enough.

### Move 2 — Name the question the pattern answers

That one-call-or-many question is what prompt chaining answers. Not "what's the prompt for this complex task" (you can write one); just *should I write one big prompt or several smaller ones that pipe into each other*. The answer: split when (a) the task has distinguishable sub-jobs, (b) errors should isolate to one step, (c) different steps could use different models.

### Move 3 — Why answering that question matters

**What breaks without chaining (one big prompt):** complex schema validation tangled with content quality; one bad output mode masks another; re-runs are expensive (re-do everything to fix one part); harder to compose with other chains. In buffr today, `summarize → caption` is the live two-step chain (documented in `src/services/ai/compose.ts`). The pattern is also exercised in `classify → expand` for todos (classifier produces the type; expander consumes the type to switch its output schema).

### Move 4 — Concrete before/after

Without chaining:
- One prompt: "summarize and caption this day in 4 tones, return as nested JSON"
- 500 lines of prompt + complex schema
- 5-10% fail rate (one of the two jobs misbehaves)
- Retry cost: re-run everything

With chaining:
- `summarize` → AISummary (~150 lines of prompt, ~20-field schema)
- `caption` → 4 variants (~80 lines of prompt, simple 4-key schema)
- Each step <2% fail rate; combined ~3-4% somewhere in the pipeline
- Selective retry: failed step only

### Move 5 — The one-line summary

Split multi-purpose tasks into chains; each chain has one job; errors isolate; different steps can use different models. The cost is more latency and more orchestration code.

---

## How it works

### Move 1 — The mental model

```
   ┌──────────────────────────┐
   │  Chain 1: summarize      │  ← Sonnet 4.6 (more capable)
   │  tone-agnostic gist       │     temperature 0.3
   └────────────┬─────────────┘
                │  output 1 (AISummary)
                ▼
   ┌──────────────────────────┐
   │  Chain 2: caption        │  ← Sonnet 4.6 (could be Haiku at higher scale)
   │  apply tone + structure   │     per-variant temperatures
   │  + summary + recent       │
   └────────────┬─────────────┘
                │
                ▼
        4 caption variants
```

Each chain takes the previous output as input plus its own context (recent captions for anti-repetition, in caption's case).

### Move 2 — The layered walkthrough

**Layer 1 — chain boundary is where schemas join.** The output schema of chain N is the input shape of chain N+1. For buffr, `AISummary` is the contract between `summarize` and `caption`. Both chains agree on the shape; if a field is added to `AISummary`, both sides update.

```
   buffr's summarize → caption boundary
   ────────────────────────────────────
   summarize output: AISummary {
     headline: string;
     narrative: string;
     tone: string;
     tags: string[];
     keyMoments: string[];
     ...
   }
                 │
                 ▼
   caption input: AISummary + recentCaptions: string[]
   caption output: { clean, smoother, reflective, punchy }
```

**Layer 2 — caching at chain boundaries.** Buffr caches the AISummary in `ai_summaries.summary_json` keyed by `(user_id, date)`. The cache is the chain boundary made persistent. `compose.ts` first reads the cache; if hit, skip `summarize` and only run `caption` (if captions are missing). This makes the day-load fast even when one of the two chains needs to re-run.

```
   compose.ts orchestration
   ────────────────────────
   read ai_summaries(user_id, date)
         │
    ┌────┴─────┐
    │  cached? │
    └────┬─────┘
         │
    ┌────┴─────┐
    │          │
    ▼ yes      ▼ no
   read       run summarize → AISummary
   variants    │
   from        ▼
   summary    cache to ai_summaries
   _json       │
              ▼
              run caption(AISummary, recentCaptions)
              cache variants under summary_json.variants
```

**Layer 3 — error isolation.** When a downstream chain errors, you don't have to re-run the upstream one (the cache is still good). When an upstream chain errors, you can't run the downstream one and the cache stays empty. Selective retry: only the failed step.

### Move 3 — The principle

Each chain has one job. Outputs become inputs. Cache at chain boundaries. The pattern composes: a 3-step chain (classify → expand → judge) works like a 2-step one; the boundary discipline is the same.

---

## Prompt chaining — diagram

```
┌─ Buffr's live chain (summarize → caption) ─────────────────────────────┐
│                                                                        │
│   day prose + history                                                  │
│         │                                                              │
│         ▼                                                              │
│   ┌───────────────────────┐                                            │
│   │   summarize chain      │                                            │
│   │   Sonnet 4.6, t=0.3   │                                            │
│   └──────────┬────────────┘                                            │
│              │  AISummary                                              │
│              ▼                                                          │
│   cache to ai_summaries.summary_json                                    │
│              │                                                          │
│              ▼                                                          │
│   ┌───────────────────────┐                                            │
│   │   caption chain        │                                            │
│   │   Sonnet 4.6,          │   inputs: AISummary + recentCaptions       │
│   │   per-variant t        │   output: 4 variants under summary_json   │
│   └──────────┬────────────┘                                            │
│              │                                                          │
│              ▼                                                          │
│   variants displayed in editor                                          │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

┌─ Buffr's other chain (classify → expand) ──────────────────────────────┐
│                                                                        │
│   todo text                                                            │
│         │                                                              │
│         ▼                                                              │
│   classify chain → ThinkingMode type                                    │
│         │                                                              │
│         ▼                                                              │
│   expand chain (schema switched by type) → typed expansion             │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case A — buffr exercises prompt chaining in two live pipelines.**

**Files:**
- `src/services/ai/summarize.ts` + `src/services/ai/caption.ts` — orchestrated by `src/services/ai/compose.ts`. The cache boundary is `ai_summaries.summary_json`.
- `src/services/todos/classify.ts` + `src/services/todos/expand.ts` — orchestrated by `src/services/todos/reconcileMeta.ts`. The boundary is `todo_meta.type` and `todo_meta.expanded_md`.

Both chains pair a "classifier-like" step (extract structure) with a "generator-like" step (use the structure to produce content). The cache makes re-runs cheap.

---

## Elaborate

### Where this pattern comes from

LangChain (2022) popularized the term "chain"; the underlying pattern (sequential LLM calls with intermediate outputs) predates LangChain. The closest cross-domain analog: classical pipelines (unix `|`), where each step has one job and the output is the next step's input.

### The deeper principle

Single-responsibility composes. Two simple chains beat one complex one. The cost is more orchestration code and more total latency.

### Where this breaks down

When the sub-tasks aren't really separable — a "summarize plus caption" task where the caption needs context the summary doesn't capture, forcing the second chain to re-read the original input. At that point, one chain is simpler. Also when latency matters more than error isolation — two sequential calls means 2× the latency.

### What to explore next

- [`01-llm-foundations/04-structured-outputs`](../01-llm-foundations/04-structured-outputs.md) — the schema is the chain-boundary contract
- [`04-agents-and-tool-use/01-agents-vs-chains`](../04-agents-and-tool-use/01-agents-vs-chains.md) — when the next step is decided by the model, you have an agent, not a chain
- [`06-production-serving/01-llm-caching`](../06-production-serving/01-llm-caching.md) — caching at chain boundaries is the practical win

---

## Tradeoffs

```
┌──────────────────┬──────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Chained                  │ Single big prompt            │
├──────────────────┼──────────────────────────┼──────────────────────────────┤
│ Total latency    │ Sum of step latencies    │ One round-trip               │
│ Total cost       │ Sum of per-step costs    │ Potentially less (one call)  │
│ Error isolation  │ Yes (selective retry)    │ No (re-run everything)       │
│ Schema complexity│ Smaller per chain        │ Nested, complex              │
│ Model routing    │ Different models per step│ One model for everything     │
│ Cache opportunity│ At every boundary        │ Only at the whole-task level │
└──────────────────┴──────────────────────────┴──────────────────────────────┘
```

### The breakpoint

Chain when sub-tasks are distinguishable AND you have a reason to isolate (different models, error isolation, caching). Single-prompt when the task is unitary or latency is critical.

---

## Tech reference

- **Chain boundary contract:** Zod schema (e.g., `AISummarySchema` in `src/types/ai.ts`)
- **Orchestration:** `src/services/ai/compose.ts` (summarize → caption) and `src/services/todos/reconcileMeta.ts` (classify → expand)
- **Boundary caching:** `ai_summaries.summary_json` and `todo_meta` columns

---

## Project exercises

### B-chain-extend — Extend the chain with a third step

- **What to build:** a third chain `validate` that runs after `caption` and assesses whether any variant repeats phrasing from `recentCaptions` (semantic match, not just string match). If a variant scores too high, request a regenerate of just that variant.
- **Why it earns its place:** turns the implicit anti-repetition (variants take `recentCaptions` as input but compliance isn't checked) into an explicit verification step.
- **Files to touch:** new `src/services/ai/validate-variants.ts`; orchestration in `compose.ts`.
- **Done when:** the third chain runs after caption; failed variants regenerate; cache stays correct.
- **Estimated effort:** 4 hours.

---

## Summary

### Part 1 — concept recap

Prompt chaining splits multi-step tasks into single-purpose chains with the output of one becoming the input of the next. Buffr exercises this in two live pipelines: `summarize → caption` (orchestrated by `compose.ts`, cached at the `ai_summaries.summary_json` boundary) and `classify → expand` (orchestrated by `reconcileMeta.ts`, cached on `todo_meta`). The chain boundaries are Zod-shaped contracts.

### Part 2 — key points to remember

- Each chain has one job; outputs become inputs.
- The chain boundary is a schema (Zod) — both sides agree on the shape.
- Cache at chain boundaries: that's the practical win.
- Cost: more latency, more orchestration. Benefit: error isolation, model routing, selective retry.
- Single-purpose chains compose into longer pipelines.

---

## Interview defense

**Q [mid]:** When do you chain vs use a single big prompt?

**A:** Chain when sub-tasks are distinguishable AND you have a reason to isolate them (errors, models, cache). Single prompt when the task is unitary or latency is critical. For buffr's day-summary feature, splitting `summarize` (Sonnet, t=0.3) from `caption` (Sonnet with per-variant temperatures) isolates failure modes — a bad caption variant doesn't invalidate the summary — and lets the cache live at the boundary.

**Q [senior]:** What's the cache pattern at chain boundaries?

**A:** Store the intermediate output keyed by some stable identifier. Buffr caches `AISummary` in `ai_summaries.summary_json` keyed by `(user_id, date)`. The orchestrator reads the cache first; if hit, skip the upstream chain. Only run downstream chains whose output is missing. The cache amplifies the value of chaining — without it, every re-run pays for every step.

### One-line anchors

- Single-purpose chains; outputs become inputs.
- Schema is the chain boundary contract.
- Cache at the boundary; that's the practical win.
- Selective retry on the failed step.
- Buffr: summarize → caption (live); classify → expand (live).

---

## Validate

### Level 1
Draw buffr's `summarize → caption` pipeline with cache boundary labeled.

### Level 2
Explain in under 60 seconds why chaining beats one big prompt for buffr's day-summary feature.

### Level 3
A new requirement: buffr should classify each entry's mood (positive/neutral/negative) before generating captions. Where would this fit in the chain?

### Level 4
Defend or oppose: "Buffr should merge summarize and caption into one chain to halve latency."

### Quick check
- What's the chain boundary between summarize and caption in buffr?
- Where's the cache stored?
- What two chains does buffr exercise today?
