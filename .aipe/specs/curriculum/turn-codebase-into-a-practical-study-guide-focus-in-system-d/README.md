# Curriculum: turn the loopd codebase into a practical study guide for system design, DSA, and AI

A real, shipping native-Android daily-vlogging app (Expo + React Native + TypeScript + SQLite + Supabase + Anthropic/OpenAI) used as the worked example for **system design**, **data structures + algorithms**, and **AI engineering** — every concept grounded in a specific file and line in `/Users/rein/Public/loopd/`.

## How to read this curriculum

1. Start with `00-overview.md` — explains what the codebase is and the read → find → explain back loop.
2. Then `06-curriculum-path.md` — the ordered learning path across all five categories, with prerequisites first.
3. Use the per-category chapters (`01–05`) as references when the path points at a concept.

## Files in order

- **[00-overview.md](./00-overview.md)** — why this curriculum exists for THIS codebase, the three-pillar framing (system design / DSA / AI), and how to actually study the chapters instead of skimming them.
- **[01-agentic-ai.md](./01-agentic-ai.md)** — the AI workflow without the agent framework: heuristic-before-LLM gating, classifier→expander pipeline, structured output with validate-and-retry, two-pass LLM chain (summary→caption), provider abstraction, and an honest section on what this app is *not* doing (no ReAct, no tool calling).
- **[02-systems-thinking.md](./02-systems-thinking.md)** — the system-design backbone: local-first SQLite + Supabase mirror, last-write-wins by `updated_at`, soft delete + tombstones, debounced writes with re-queue, clock-skew-safe pull cursor, paginated incremental pull, idempotent SecureStore-gated migrations, race-condition-aware bootstrap state machine.
- **[03-thinking-in-code.md](./03-thinking-in-code.md)** — the DSA chapter in disguise: multi-key sorts, two-pass sequence-alignment scanners, sparse-then-dense integer reordering, hash-join + group-by aggregator (N+1 collapse), sliding-window heatmap compute, ISO week math, bucketed thresholds, discriminated unions, dynamic imports to break cycles.
- **[04-ai-product-engineering.md](./04-ai-product-engineering.md)** — the engineering decisions *around* AI calls: cost-aware model routing, context-window budgets, spec-driven AI dev, the `.aipe/` memory-bank pattern, graceful degradation, boot-time catch-up vs live reconcile, user-overridable AI output with permanent locks, surfacing model uncertainty, and the honest gap on automated evals.
- **[05-language-agnostic.md](./05-language-agnostic.md)** — interview-portable distillations: functional core / imperative shell, source-of-truth + projections, two-pass alignment, last-write-wins, soft delete, idempotency, provider abstraction, debounce, discriminated unions, N+1 collapse, sliding windows, spec-driven dev.
- **[06-curriculum-path.md](./06-curriculum-path.md)** — the ordered reading path in 8 blocks: anchors → DSA core → system-design backbone → advanced sync mechanics → AI pipeline → AI product polish → advanced DSA tricks → meta-patterns. Plus a "next steps beyond the curriculum" section.

---

## Concept index

Every concept covered in the curriculum, with category, difficulty, and a link to its chapter section. Use this as a quick-reference when an interviewer or PR review surfaces one of the patterns and you want to jump straight to the reference.

### Agentic AI

| Concept | Difficulty | Link |
|---|---|---|
| Heuristic-before-LLM gating | foundational | [01 §1.1](./01-agentic-ai.md#11-heuristic-before-llm-gating--foundational) |
| Two-stage classifier → expander pipeline | intermediate | [01 §1.2](./01-agentic-ai.md#12-two-stage-classifier--expander-pipeline--intermediate) |
| Structured-output prompting with per-type JSON schemas | intermediate | [01 §1.3](./01-agentic-ai.md#13-structured-output-prompting-with-per-type-json-schemas--intermediate) |
| Validate-and-retry on malformed JSON | intermediate | [01 §1.4](./01-agentic-ai.md#14-validate-and-retry-on-malformed-json--intermediate) |
| Chain-of-thought reasoning preambles | intermediate | [01 §1.5](./01-agentic-ai.md#15-chain-of-thought-reasoning-preambles--intermediate) |
| Two-pass LLM chain (structured summary → relatable caption) | intermediate | [01 §1.6](./01-agentic-ai.md#16-two-pass-llm-chain-structured-summary--relatable-caption--intermediate) |
| Memory pattern: cached AI summaries as conversational context | intermediate | [01 §1.7](./01-agentic-ai.md#17-memory-pattern-cached-ai-summaries-as-conversational-context--intermediate) |
| Provider abstraction for swappable models | foundational | [01 §1.8](./01-agentic-ai.md#18-provider-abstraction-for-swappable-models--foundational) |
| Concurrency-capped fire-and-forget | intermediate | [01 §1.9](./01-agentic-ai.md#19-concurrency-capped-fire-and-forget--intermediate) |
| What this codebase is *not* doing (no ReAct, no tool-call planner) | advanced | [01 §1.10](./01-agentic-ai.md#110-what-this-codebase-is-not-doing-and-why-thats-a-learning-opportunity--advanced) |

### Systems thinking

| Concept | Difficulty | Link |
|---|---|---|
| Local-first architecture: SQLite as canonical, cloud as mirror | foundational | [02 §2.1](./02-systems-thinking.md#21-local-first-architecture-sqlite-as-canonical-cloud-as-mirror--foundational) |
| Single source of truth — DB-first, prose-canonical | foundational | [02 §2.2](./02-systems-thinking.md#22-single-source-of-truth--db-first-prose-canonical--foundational) |
| Two-pass scanner pattern (alignment-style) | intermediate | [02 §2.3](./02-systems-thinking.md#23-two-pass-scanner-pattern-alignment-style-record-identity-preservation--intermediate) |
| Idempotent SecureStore-gated migrations | foundational | [02 §2.4](./02-systems-thinking.md#24-idempotent-securestore-gated-migrations--foundational) |
| Soft delete + tombstone propagation | intermediate | [02 §2.5](./02-systems-thinking.md#25-soft-delete--tombstone-propagation--intermediate) |
| Last-write-wins conflict resolution by `updated_at` | intermediate | [02 §2.6](./02-systems-thinking.md#26-last-write-wins-conflict-resolution-by-updated_at--intermediate) |
| Clock-skew-safe pull cursor via server time RPC | advanced | [02 §2.7](./02-systems-thinking.md#27-clock-skew-safe-pull-cursor-via-server-time-rpc--advanced) |
| Paginated incremental pull with monotonic cursor | advanced | [02 §2.8](./02-systems-thinking.md#28-paginated-incremental-pull-with-monotonic-cursor--advanced) |
| Topologically-ordered table sync (parents before children) | intermediate | [02 §2.9](./02-systems-thinking.md#29-topologically-ordered-table-sync-parents-before-children--intermediate) |
| Debounced background dispatch with re-queue | intermediate | [02 §2.10](./02-systems-thinking.md#210-debounced-background-dispatch-with-re-queue--intermediate) |
| Race-condition-aware bootstrap state machine | advanced | [02 §2.11](./02-systems-thinking.md#211-race-condition-aware-bootstrap-state-machine--advanced) |
| Don't-auto-delete-during-sync invariant | foundational | [02 §2.12](./02-systems-thinking.md#212-dont-auto-delete-during-sync-invariant--foundational) |
| Read-DB-before-deleting safety check | foundational | [02 §2.13](./02-systems-thinking.md#213-read-db-before-deleting-safety-check--foundational) |
| Single aggregate query for derived dashboard data (N+1 collapse) | intermediate | [02 §2.14](./02-systems-thinking.md#214-single-aggregate-query-for-derived-dashboard-data--intermediate) |
| Documented deviation as a first-class artifact | intermediate | [02 §2.15](./02-systems-thinking.md#215-documented-deviation-as-a-first-class-artifact--intermediate) |

### Thinking in code (DSA)

| Concept | Difficulty | Link |
|---|---|---|
| Multi-key comparator with priority enum (todo ranking) | foundational | [03 §3.1](./03-thinking-in-code.md#31-multi-key-comparator-with-priority-enum-todo-ranking--foundational) |
| Two-pass sequence alignment (the scanner) | intermediate | [03 §3.2](./03-thinking-in-code.md#32-two-pass-sequence-alignment-the-scanner--intermediate) |
| Sparse-then-dense integer ordering for manual reorder | intermediate | [03 §3.3](./03-thinking-in-code.md#33-sparse-then-dense-integer-ordering-for-manual-reorder--intermediate) |
| Hash-join + group-by aggregator (dashboard threads) | intermediate | [03 §3.4](./03-thinking-in-code.md#34-hash-join--group-by-aggregator-dashboard-threads--intermediate) |
| Sliding-window compute (14-day heatmap strip) | intermediate | [03 §3.5](./03-thinking-in-code.md#35-sliding-window-compute-14-day-heatmap-strip--intermediate) |
| Cadence engine: enum dispatch over schedule types | foundational | [03 §3.6](./03-thinking-in-code.md#36-cadence-engine-enum-dispatch-over-schedule-types--foundational) |
| ISO week boundary computation | intermediate | [03 §3.7](./03-thinking-in-code.md#37-iso-week-boundary-computation--intermediate) |
| Bucketed threshold function (staleness compute) | foundational | [03 §3.8](./03-thinking-in-code.md#38-bucketed-threshold-function-staleness-compute--foundational) |
| De-duplication via composite key set | foundational | [03 §3.9](./03-thinking-in-code.md#39-de-duplication-via-composite-key-set--foundational) |
| Code-span masking before regex (length-preserving) | intermediate | [03 §3.10](./03-thinking-in-code.md#310-code-span-masking-before-regex-length-preserving--intermediate) |
| Module-level semaphore via `Set` | intermediate | [03 §3.11](./03-thinking-in-code.md#311-module-level-semaphore-via-set--intermediate) |
| Discriminated unions for domain modeling | foundational | [03 §3.12](./03-thinking-in-code.md#312-discriminated-unions-for-domain-modeling--foundational) |
| Dynamic import to break circular dependencies | intermediate | [03 §3.13](./03-thinking-in-code.md#313-dynamic-import-to-break-circular-dependencies--intermediate) |
| Pure function as the unit of testability | foundational | [03 §3.14](./03-thinking-in-code.md#314-pure-function-as-the-unit-of-testability--foundational) |
| Generic interface as table-pluggability contract | advanced | [03 §3.15](./03-thinking-in-code.md#315-generic-interface-as-table-pluggability-contract--advanced) |

### AI product engineering

| Concept | Difficulty | Link |
|---|---|---|
| Cost-aware model routing (cheap classifier vs primary expander) | foundational | [04 §4.1](./04-ai-product-engineering.md#41-cost-aware-model-routing-cheap-classifier-vs-primary-expander--foundational) |
| Context-window budgeting via per-source caps | intermediate | [04 §4.2](./04-ai-product-engineering.md#42-context-window-budgeting-via-per-source-caps--intermediate) |
| Spec-driven AI development | intermediate | [04 §4.3](./04-ai-product-engineering.md#43-spec-driven-ai-development--intermediate) |
| Memory bank pattern: externalized context via `.aipe/` | intermediate | [04 §4.4](./04-ai-product-engineering.md#44-memory-bank-pattern-externalized-context-via-aipe--intermediate) |
| Graceful degradation around model failures | intermediate | [04 §4.5](./04-ai-product-engineering.md#45-graceful-degradation-around-model-failures--intermediate) |
| Boot-time catch-up vs. live-write reconciliation | intermediate | [04 §4.6](./04-ai-product-engineering.md#46-boot-time-catch-up-vs-live-write-reconciliation--intermediate) |
| User-overridable AI output with permanent lock | foundational | [04 §4.7](./04-ai-product-engineering.md#47-user-overridable-ai-output-with-permanent-lock--foundational) |
| Two-call chain with structured handoff | intermediate | [04 §4.8](./04-ai-product-engineering.md#48-two-call-chain-with-structured-handoff--intermediate) |
| Tonal-continuity context injection | intermediate | [04 §4.9](./04-ai-product-engineering.md#49-tonal-continuity-context-injection--intermediate) |
| Provider-agnostic config storage | foundational | [04 §4.10](./04-ai-product-engineering.md#410-provider-agnostic-config-storage--foundational) |
| Evaluation by inspection (no automated AI evals) — the honest gap | advanced | [04 §4.11](./04-ai-product-engineering.md#411-evaluation-by-inspection-no-automated-ai-evals--advanced) |
| Surfacing AI uncertainty to the user | intermediate | [04 §4.12](./04-ai-product-engineering.md#412-surfacing-ai-uncertainty-to-the-user--intermediate) |

### Language-agnostic

| Concept | Difficulty | Link |
|---|---|---|
| Functional core, imperative shell | foundational | [05 §5.1](./05-language-agnostic.md#51-functional-core-imperative-shell--foundational) |
| Source of truth + derived projections | foundational | [05 §5.2](./05-language-agnostic.md#52-source-of-truth--derived-projections--foundational) |
| Two-pass alignment for record identity through edits | intermediate | [05 §5.3](./05-language-agnostic.md#53-two-pass-alignment-for-record-identity-through-edits--intermediate) |
| Last-write-wins as default conflict resolution | intermediate | [05 §5.4](./05-language-agnostic.md#54-last-write-wins-as-default-conflict-resolution--intermediate) |
| Soft delete with tombstones | intermediate | [05 §5.5](./05-language-agnostic.md#55-soft-delete-with-tombstones--intermediate) |
| Idempotent operations as a safety property | foundational | [05 §5.6](./05-language-agnostic.md#56-idempotent-operations-as-a-safety-property--foundational) |
| Provider abstraction (abstract what changes) | foundational | [05 §5.7](./05-language-agnostic.md#57-provider-abstraction-abstract-what-changes--foundational) |
| Heuristic-before-LLM (cheap path before expensive path) | foundational | [05 §5.8](./05-language-agnostic.md#58-heuristic-before-llm-cheap-path-before-expensive-path--foundational) |
| Debounce as the default for write-heavy interactivity | intermediate | [05 §5.9](./05-language-agnostic.md#59-debounce-as-the-default-for-write-heavy-interactivity--intermediate) |
| Discriminated unions for closed-world modeling | foundational | [05 §5.10](./05-language-agnostic.md#510-discriminated-unions-for-closed-world-modeling--foundational) |
| N+1 collapse via per-metric aggregation | intermediate | [05 §5.11](./05-language-agnostic.md#511-n1-collapse-via-per-metric-aggregation--intermediate) |
| Sliding window over time-bucketed data | intermediate | [05 §5.12](./05-language-agnostic.md#512-sliding-window-over-time-bucketed-data--intermediate) |
| Spec-driven development | intermediate | [05 §5.13](./05-language-agnostic.md#513-spec-driven-development--intermediate) |
| Documented deviation as a first-class artifact | intermediate | [05 §5.14](./05-language-agnostic.md#514-documented-deviation-as-a-first-class-artifact--intermediate) |
| Read DB before destructive action | foundational | [05 §5.15](./05-language-agnostic.md#515-read-db-before-destructive-action--foundational) |
| One prompt, one job (chain instead of cram) | intermediate | [05 §5.16](./05-language-agnostic.md#516-one-prompt-one-job-chain-instead-of-cram--intermediate) |
