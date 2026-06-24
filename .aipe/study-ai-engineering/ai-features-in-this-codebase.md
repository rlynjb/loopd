# AI features in this codebase

Per-feature inventory of every LLM-powered surface in buffr, with cross-references to the concept files that describe each pattern.

---

### Feature: Daily summary (`summarize` chain)

**What it does for the user:** when the user composes or edits an entry for a date, buffr produces a structured `AISummary` — a JSON shape containing headline, narrative paragraph, tone tag, topic tags, and metadata — cached in `ai_summaries.summary_json` and surfaced on the home dashboard and editor.

**Files:** `src/services/ai/summarize.ts` (chain), `src/services/ai/validate.ts` (Zod-shaped runtime check), `src/services/ai/compose.ts` (orchestrator — cached read first, else trigger).

**Patterns used:**
- `01-llm-foundations/04-structured-outputs.md` — JSON-shaped response with runtime validation, not free-text parsing
- `01-llm-foundations/03-sampling-parameters.md` — temperature=0.3 for stable structured output
- `01-llm-foundations/06-token-economics.md` — input is the day's prose + last 3 days of context; cached after first generation per day to avoid re-paying
- `02-context-and-prompts/03-prompt-chaining.md` — output of `summarize` feeds `caption` as input (two-call pattern)
- `06-production-serving/01-llm-caching.md` — exact-match cache via `ai_summaries.summary_json` keyed on `(user_id, date)`

**Why these patterns:** the summary is the load-bearing artefact for the day — it's what the home dashboard renders, what the editor reads to reconstruct user context after a screen leave, and what the caption chain consumes downstream. A free-text response would force every consumer to re-parse; the Zod shape is the contract that makes downstream consumption safe.

---

### Feature: Caption variants (`caption` chain)

**What it does for the user:** generates 4 tonal caption variants per day (`clean`, `smoother`, `reflective`, `punchy`), each one sentence describing the day, surfaced as the swipeable caption card in the editor. Variants share a theme (carried in `variantsTheme`) so swapping doesn't change the day's meaning.

**Files:** `src/services/ai/caption.ts`, `src/services/ai/compose.ts`.

**Patterns used:**
- `01-llm-foundations/04-structured-outputs.md` — 4-keyed JSON object validated at parse time
- `01-llm-foundations/03-sampling-parameters.md` — temperature varies per variant (clean=0.4, punchy=0.85) as a deliberate sampling experiment
- `02-context-and-prompts/03-prompt-chaining.md` — consumes the `summarize` output as primary input plus `recentCaptions` (anti-repetition window)
- `06-production-serving/01-llm-caching.md` — same cache shape as `summarize`; stored under the `variants` key of `summary_json`

**Why these patterns:** the user reads the same day many times (drafting + revising + reviewing days later). Without anti-repetition input, variants collapse onto the same phrasing after a few generations. Without per-variant temperature variance, the four variants compress into near-duplicates of each other.

---

### Feature: Todo classifier (`classify` chain)

**What it does for the user:** when the user types a todo (`[]` prefix in prose), buffr classifies it into one of 5 thinking-mode types — `todo` (actionable, the non-expandable default), `idea` (an unproven possibility), `knowledge` (an absorbed insight), `study` (a learning intention), `reflect` (past-facing introspection) — so the per-type expansion has the right output shape. The classification appears as a colored chip and routes the four non-`todo` types into their typed expansion schema. (The set was reduced from an earlier engineering-flavored list in migrations 0006/0007/0008: `study` and `reflect` were added, then `bug`/`question`/`decision`/`content` were dropped.)

**Files:** `src/services/todos/heuristicClassify.ts` (regex first pass), `src/services/todos/classify.ts` (LLM fallback), `src/services/ai/config.ts` (model = Haiku 4.5 for cheap classifier).

**Patterns used:**
- `01-llm-foundations/07-heuristic-before-llm.md` — `heuristicClassify.ts` short-circuits on ~70% of inputs via regex patterns; the LLM only runs on the ambiguous remainder
- `01-llm-foundations/04-structured-outputs.md` — enum-constrained type field
- `01-llm-foundations/09-user-override-locks.md` — `todo_meta.user_overridden_type` blocks the LLM from re-classifying a todo the user manually corrected
- `01-llm-foundations/08-provider-abstraction.md` — runs against Haiku via Anthropic SDK OR `gpt-4o-mini` via raw fetch depending on `config.ts` setting

**Why these patterns:** classifier accuracy isn't the bottleneck — user trust is. Without the override lock, every re-classification erases the user's correction silently; the override lock is the canonical pattern any field with both AI and user write access needs.

---

### Feature: Per-type todo expansion (`expand` chain)

**What it does for the user:** when the user opens a todo detail screen, `expand` produces a per-type structured expansion (steps for `task`, decision-criteria for `decision`, references for `learning`, etc.) written into `todo_meta.expanded_md` as markdown.

**Files:** `src/services/todos/expand.ts`, type schemas in `src/types/todoMeta.ts`.

**Patterns used:**
- `01-llm-foundations/04-structured-outputs.md` — schema varies by `type` (4 distinct schemas, switched by the classified type)
- `01-llm-foundations/06-token-economics.md` — input includes sibling todos + last 3 days of entries (hand-picked, ≤1000 chars each — the principle-#11 documented exception to RAG)
- `02-context-and-prompts/02-lost-in-the-middle.md` — the most relevant sibling is placed last in context, since the model attends most strongly to the end (cited as the reason the `prompt.ts` constructor orders inputs this way)

**Why these patterns:** the hand-picked retrieval is the principle-#11 design decision — at current corpus size (one user's journal), the cost of building an embedding index, keeping it fresh, and serving cosine queries exceeds the recall benefit. The "above-threshold" version (vector search for week-scope interpret + thread `related-entries`) is in the Phase 2A spec for a future build.

---

### Feature: Long-form day interpretation (`interpret` chain)

**What it does for the user:** opens a long-form markdown reflection on a day (or week, eventually) — the "what does this day mean" reading rather than the "what happened" reading of `summarize`. Surfaced as the "interpret" action in the editor menu.

**Files:** `src/services/ai/interpret.ts`.

**Patterns used:**
- `01-llm-foundations/04-structured-outputs.md` — markdown is the single output mode (not JSON); validated by length + non-empty check only
- `01-llm-foundations/03-sampling-parameters.md` — temperature=0.7 (higher than `summarize`'s 0.3) because the output is reflective prose, not structured fields
- `02-context-and-prompts/03-prompt-chaining.md` — consumes the day's `AISummary` plus the day's prose; no chained downstream consumer
- `06-production-serving/01-llm-caching.md` — same `ai_summaries`-keyed cache; no semantic cache (the `interpret` output is too high-stakes for fuzzy matches)

**Why these patterns:** `interpret` is the only chain with a single output mode mismatch with the other four (markdown, not JSON) — the chain emits prose because the consumer is a markdown renderer in the editor, not a typed downstream caller. The mismatch is intentional and isolated; the chain doesn't feed any other chain.

---

### Feature: Provider toggle (cross-cutting)

**What it does for the engineer:** flips the active provider between Anthropic (Claude Sonnet 4.6 + Haiku 4.5) and OpenAI (GPT-4o + 4o-mini) via a single config in `src/services/ai/config.ts`. All 5 chains route through the same toggle.

**Files:** `src/services/ai/config.ts`, plus per-chain provider-dispatch blocks at the top of each `src/services/ai/*.ts` chain file.

**Patterns used:**
- `01-llm-foundations/08-provider-abstraction.md` — factory-style dispatch on the `provider` field; same chain interface regardless of provider
- `06-production-serving/02-llm-cost-optimization.md` — the classifier uses Haiku (cheap) while the day-summary uses Sonnet (more capable); model-per-task is the cost discipline
- `06-production-serving/05-retry-and-circuit-breaker.md` — **Case B** — toggle exists for capability swap, not for failover; no circuit breaker yet

**Why these patterns:** the toggle exists because Anthropic SDK and raw-fetch-to-OpenAI have different ergonomics, retry semantics, and cost shapes — abstracting at the chain boundary lets every chain swap without rewriting. The toggle has been used twice in production (once to A/B Sonnet vs GPT-4o on summary quality, once to switch the classifier from GPT-4o-mini to Haiku for cost).

---

### What this codebase does NOT do (Case B at the feature level)

These features are described in the per-concept files as "Not yet implemented" with the build target named:

- **No RAG.** Above the principle-#11 threshold — week-scope `interpret`, thread `related-entries` — RAG would justify itself; below it, hand-picked retrieval is correct.
- **No agents.** Every chain is single-shot. No tool calling, no ReAct, no agent loop. A potential build (path B from the curriculum) is upgrading the classifier into a mini-agent that retrieves similar todos when confidence is low.
- **No eval harness.** No golden set, no LLM-as-judge runner, no regression suite. The Phase 3 spec defines a 7-suite harness (5 chains + 2 RAG retrievals) once those are built.
- **No production observability.** No `ai_call_log` table, no traces, no spans, no cost dashboard. The Phase 5 spec defines `app/more/ai-ops.tsx` as the surfacing screen.
- **No retry/circuit-breaker on provider calls.** Errors surface as throws and fall through to the UI as a silent fallback. The Phase 5 spec defines the queue + retry + circuit-breaker layer.
- **No prompt-injection guards on user-generated text.** The chains interpolate `entries.text` directly into prompts. Buffr's input source is the user's own private journal (single-user app), so the threat model is narrow — but the Phase 5 spec defines the sanitization layer as an exercise.

---
