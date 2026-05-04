# Curriculum: the entire codebase and system itself — for a student learning practical knowledge

A structured learning path through **loopd** — a solo-built native Android daily-vlogging app written in React Native + Expo + TypeScript, backed by on-device SQLite + Supabase cloud sync, threaded with two LLM providers for classify / expand / summarize / caption. Each concept is grounded in a specific file or function in `/Users/rein/Public/loopd/`.

## Files in this curriculum

- **[00-overview.md](./00-overview.md)** — Why this curriculum exists, how to study it (read → find → explain back), and what to expect from each chapter.
- **[01-agentic-ai.md](./01-agentic-ai.md)** — How loopd uses LLMs: stateless calls (no agents), heuristic-before-LLM, two-stage classification, prompt chaining, validation + retry, in-flight caps, caching, bounded context. Plus what it deliberately *doesn't* do (no tool calling, no conversation memory).
- **[02-systems-thinking.md](./02-systems-thinking.md)** — The richest chapter. Single source of truth, derived state, two-pass matching, idempotent reconciliation, the sync orchestrator, LWW conflict, server-time RPC, bootstrap decisions, debounced batching, race-safe focus cleanup, dynamic imports, schema migration, boundary discipline.
- **[03-thinking-in-code.md](./03-thinking-in-code.md)** — Code-shape patterns: type-driven design, discriminated unions, schema-first dev, pure functions for testability, fire-and-forget side effects, optimistic updates, lazy singletons, discriminated result types, event bus, stable sort orders, defensive parsing.
- **[04-ai-product-engineering.md](./04-ai-product-engineering.md)** — Product-side decisions: cost-per-call awareness, user-controlled triggers for expensive ops, spec-driven dev, memory bank patterns (`.aipe/`), tonal continuity, anti-repetition prompts, graceful degradation, latency budgets, the "AI augments, doesn't replace" principle.
- **[05-language-agnostic.md](./05-language-agnostic.md)** — Patterns that transfer to any stack: documenting principles, naming deviations, making invariants explicit at multiple layers, lazy init with sentinels, eventual consistency, idempotent backfills, separating data from metadata, self-healing systems, the lock-on-override pattern.
- **[06-curriculum-path.md](./06-curriculum-path.md)** — The ordered learning path. Six phases, dependency-sorted, with difficulty markers and links back to each concept. Read this last; use it as your map.

## How to use it

Don't read end-to-end. Pick one concept per session, read it (5–10 min), open the referenced file, then **close the file and re-explain the concept in your own words**. If you can't, you don't know it yet. That's the whole study method.

Start at `00-overview.md`. When you're ready to commit to an order, jump to `06-curriculum-path.md` and follow Phase 1 → Phase 6.

---

## Concept index (flat, by category)

The full set of concepts covered, alphabetical within each category, with difficulty marks.

### Agentic AI (chapter 01)
- **[LLM call vs. agent](./01-agentic-ai.md#11-llm-call-vs-agent--and-why-loopd-is-the-former)** — foundational
- **[Heuristic-before-LLM (cheapest model path)](./01-agentic-ai.md#12-heuristic-before-llm-cheapest-model-path)** — foundational
- **[Two-stage classification (cheap → expensive)](./01-agentic-ai.md#13-two-stage-classification-cheap-model--expensive-model-split)** — intermediate
- **[Provider abstraction (Anthropic vs OpenAI)](./01-agentic-ai.md#14-provider-abstraction-anthropic-vs-openai)** — intermediate
- **[Prompt chaining (summary → caption)](./01-agentic-ai.md#15-prompt-chaining-structured-summary--relatable-caption)** — intermediate
- **[Chain-of-thought reasoning preambles](./01-agentic-ai.md#16-chain-of-thought-reasoning-preambles)** — intermediate
- **[Output validation + retry-with-stricter-instruction](./01-agentic-ai.md#17-output-validation--retry-with-stricter-instruction)** — intermediate
- **[In-flight concurrency cap + progress events](./01-agentic-ai.md#18-in-flight-concurrency-cap--progress-events)** — intermediate
- **[Caching LLM output (per-date AI summary cache)](./01-agentic-ai.md#19-caching-llm-output-per-date-ai-summary-cache)** — foundational
- **[Bounded context windows](./01-agentic-ai.md#110-bounded-context-windows-cap-context-inputs-by-length)** — intermediate
- **[Boot-time catch-up loop](./01-agentic-ai.md#111-boot-time-catch-up-loop-reprocess-incomplete-state)** — intermediate
- **[Concepts not present (and why)](./01-agentic-ai.md#112-concepts-not-present-and-why)** — foundational

### Systems thinking (chapter 02)
- **[Single source of truth (SQLite is canonical)](./02-systems-thinking.md#21-single-source-of-truth-sqlite-is-canonical)** — foundational
- **[Derived state vs. canonical state (prose-as-canonical for drops)](./02-systems-thinking.md#22-derived-state-vs-canonical-state-prose-as-canonical-for-drops)** — foundational
- **[Two-pass matching (preserve identity through edits)](./02-systems-thinking.md#23-two-pass-matching-preserve-identity-through-edits)** — intermediate
- **[Idempotent reconciliation](./02-systems-thinking.md#24-idempotent-reconciliation-commit-can-re-run-safely)** — intermediate
- **[Soft delete with tombstones](./02-systems-thinking.md#25-soft-delete-with-tombstones)** — foundational
- **[The sync orchestrator (push/pull as ordered passes)](./02-systems-thinking.md#26-the-sync-orchestrator--pushpull-as-separate-ordered-passes)** — intermediate
- **[Last-write-wins conflict resolution](./02-systems-thinking.md#27-last-write-wins-conflict-resolution-by-updated_at)** — intermediate
- **[Server-time RPC for clock-skew safety](./02-systems-thinking.md#28-server-time-rpc-for-clock-skew-safety)** — advanced
- **[Bootstrap decision tree](./02-systems-thinking.md#29-bootstrap-decision-tree-initial-push-vs-first-pull-vs-no-op)** — intermediate
- **[Debounced batching (5s push debounce)](./02-systems-thinking.md#210-debounced-batching-5s-push-debounce)** — intermediate
- **[Race-safe focus cleanup](./02-systems-thinking.md#211-race-safe-focus-cleanup-the-never-clear-live-refs-rule)** — advanced
- **[Dynamic import to break circular dependencies](./02-systems-thinking.md#212-dynamic-import-to-break-circular-dependencies)** — advanced
- **[Migration-safe schema evolution](./02-systems-thinking.md#213-migration-safe-schema-evolution)** — intermediate
- **[The deletion queue (deferred delete propagation)](./02-systems-thinking.md#214-the-deletion-queue-deferred-delete-propagation)** — intermediate
- **[Boundary discipline (DB layer responsibility)](./02-systems-thinking.md#215-boundary-discipline--what-the-db-layer-does-and-doesnt)** — intermediate

### Thinking in code (chapter 03)
- **[Type-driven design](./03-thinking-in-code.md#31-type-driven-design-let-the-types-tell-you-whats-possible)** — foundational
- **[Discriminated unions (TodoExpansion shape)](./03-thinking-in-code.md#32-discriminated-unions-the-todoexpansion-shape)** — intermediate
- **[Schema-first development](./03-thinking-in-code.md#33-schema-first-development-db-schema--ts-types--runtime-validators)** — intermediate
- **[Pure functions for testability](./03-thinking-in-code.md#34-pure-functions-for-testability-cadence-staleness-ranking)** — foundational
- **[Orchestration via custom hooks](./03-thinking-in-code.md#35-orchestration-via-custom-hooks-useentries-usedatabase)** — intermediate
- **[Fire-and-forget for non-blocking side effects](./03-thinking-in-code.md#36-fire-and-forget-for-non-blocking-side-effects)** — intermediate
- **[Optimistic updates (round-trip via prose rewrite)](./03-thinking-in-code.md#37-optimistic-updates-round-trip-via-prose-rewrite)** — intermediate
- **[Lazy loading + module-scope singletons](./03-thinking-in-code.md#38-lazy-loading--module-scope-singletons)** — intermediate
- **[Discriminated result types (`{ ok: true } | { ok: false, reason }`)](./03-thinking-in-code.md#39-discriminated-result-types--ok-true----ok-false-reason---)** — intermediate
- **[Event bus for cross-component progress signals](./03-thinking-in-code.md#310-event-bus-for-cross-component-progress-signals)** — intermediate
- **[Stable sort orders + tiebreakers](./03-thinking-in-code.md#311-stable-sort-orders--tiebreakers)** — intermediate
- **[Defensive parsing of JSON columns](./03-thinking-in-code.md#312-defensive-parsing-of-json-columns)** — intermediate
- **[What the type system isn't doing yet](./03-thinking-in-code.md#313-what-the-type-system-isnt-doing-yet-and-why)** — advanced

### AI product engineering (chapter 04)
- **[Cost-per-call as a first-class design constraint](./04-ai-product-engineering.md#41-cost-per-call-as-a-first-class-design-constraint)** — foundational
- **[User-controlled triggers for expensive operations](./04-ai-product-engineering.md#42-user-controlled-triggers-for-expensive-operations)** — foundational
- **[Spec-driven development](./04-ai-product-engineering.md#43-spec-driven-development-the-spec-is-the-source-of-truth)** — intermediate
- **[Memory bank patterns (.aipe + project context)](./04-ai-product-engineering.md#44-memory-bank-patterns-aipe--project-context)** — intermediate
- **[Tonal continuity via prior-output context](./04-ai-product-engineering.md#45-tonal-continuity-via-prior-output-context)** — advanced
- **[Auto-generation on intent surfaces](./04-ai-product-engineering.md#46-auto-generation-on-intent-surfaces-vlog-editor-mount)** — intermediate
- **[Anti-repetition + voice rules in system prompts](./04-ai-product-engineering.md#47-anti-repetition--voice-rules-in-system-prompts)** — intermediate
- **[The AI feature gracefully degrades (no-key path)](./04-ai-product-engineering.md#48-the-ai-feature-gracefully-degrades-no-key-path)** — intermediate
- **[Cost vs. capability tradeoff (model escalation)](./04-ai-product-engineering.md#49-cost-vs-capability-tradeoff-when-to-escalate-models)** — advanced
- **[Evaluation by hand, not by metric](./04-ai-product-engineering.md#410-evaluation-by-hand-not-by-metric)** — advanced
- **[Latency budget vs. perceived performance](./04-ai-product-engineering.md#411-latency-budget-vs-perceived-performance)** — intermediate
- **[The product principle: AI augments the user](./04-ai-product-engineering.md#412-the-product-principle-ai-augments-the-user-doesnt-replace-them)** — foundational

### Language-agnostic (chapter 05)
- **[Document architectural principles, then cite them in code](./05-language-agnostic.md#51-document-architectural-principles-then-cite-them-in-code)** — foundational
- **[Document the deviations explicitly](./05-language-agnostic.md#52-document-the-deviations-explicitly)** — intermediate
- **[Make invariants explicit (in code, in CHECKs, in types)](./05-language-agnostic.md#53-make-invariants-explicit-in-code-in-checks-in-types)** — intermediate
- **[Lazy initialization with a sentinel value](./05-language-agnostic.md#54-lazy-initialization-with-a-sentinel-value)** — foundational
- **[Eventual consistency over strong consistency](./05-language-agnostic.md#55-eventual-consistency-over-strong-consistency)** — advanced
- **[Idempotent backfills with a one-time gate flag](./05-language-agnostic.md#56-idempotent-backfills-with-a-one-time-gate-flag)** — intermediate
- **[The `null` vs. `undefined` distinction](./05-language-agnostic.md#57-the-null-vs-undefined-distinction-semantic-optionality)** — intermediate
- **[Compose pure functions with thin effectful glue](./05-language-agnostic.md#58-compose-pure-functions-with-thin-effectful-glue)** — foundational
- **[Heuristic-before-LLM as deterministic-before-probabilistic](./05-language-agnostic.md#59-heuristic-before-llm-as-a-general-deterministic-before-probabilistic-rule)** — foundational
- **[The "lock on user override" pattern](./05-language-agnostic.md#510-the-lock-on-user-override-pattern)** — intermediate
- **[Separate "the thing" from "metadata about the thing"](./05-language-agnostic.md#511-separate-the-thing-from-metadata-about-the-thing)** — intermediate
- **[Self-healing systems (fix on next encounter)](./05-language-agnostic.md#512-self-healing-systems-fix-on-next-encounter)** — advanced
- **[Pattern recognition across the chapters](./05-language-agnostic.md#513-pattern-recognition-across-the-chapters)** — advanced
