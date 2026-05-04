# Chapter 06 — The ordered learning path

The chapter files are organized by category. This file is the **reading order** — what to study first, what each step assumes you've absorbed, and where the natural pause-points are.

The path is shaped around the user's stated focus: **system design, DSA, AI**. Anything that compounds across all three pillars is foundational and goes first.

---

## How to use this path

- Pick one concept per session. Do the **read → find → explain back** loop from `00-overview.md`.
- The "blocks" below are pause-points: get all the foundational ones in a block under your belt before moving to the next.
- Concepts marked **(★)** are the highest-leverage; if you only do half the curriculum, do these.
- Difficulty: `F` = foundational, `I` = intermediate, `A` = advanced.

---

## Block 1 — anchors you build everything else on

These four concepts give you the vocabulary for the rest of the curriculum. None depends on the others. Pick one and start.

| # | Concept | Difficulty | Chapter |
|---|---|---|---|
| 1 | **(★) Local-first architecture: SQLite as canonical, cloud as mirror** | F | [02 §2.1](./02-systems-thinking.md#21-local-first-architecture-sqlite-as-canonical-cloud-as-mirror--foundational) |
| 2 | **(★) Single source of truth — DB-first, prose-canonical** | F | [02 §2.2](./02-systems-thinking.md#22-single-source-of-truth--db-first-prose-canonical--foundational) |
| 3 | **(★) Functional core, imperative shell** | F | [05 §5.1](./05-language-agnostic.md#51-functional-core-imperative-shell--foundational) |
| 4 | **(★) Heuristic-before-LLM gating** | F | [01 §1.1](./01-agentic-ai.md#11-heuristic-before-llm-gating--foundational) |

After this block you should be able to defend, in two sentences each: "what owns the truth in this app and why?" and "when is the model called and when isn't it?"

---

## Block 2 — the algorithms hiding inside the features

This block is the **DSA core**. Every concept here maps to an interview-style question.

| # | Concept | Difficulty | Chapter |
|---|---|---|---|
| 5 | Multi-key comparator with priority enum (todo ranking) | F | [03 §3.1](./03-thinking-in-code.md#31-multi-key-comparator-with-priority-enum-todo-ranking--foundational) |
| 6 | **(★) Two-pass alignment for record identity through edits** | I | [03 §3.2](./03-thinking-in-code.md#32-two-pass-sequence-alignment-the-scanner--intermediate) — the canonical "DSA hiding in plain sight" example |
| 7 | De-duplication via composite key set | F | [03 §3.9](./03-thinking-in-code.md#39-de-duplication-via-composite-key-set--foundational) |
| 8 | Bucketed threshold function (staleness compute) | F | [03 §3.8](./03-thinking-in-code.md#38-bucketed-threshold-function-staleness-compute--foundational) |
| 9 | Code-span masking before regex (length-preserving) | I | [03 §3.10](./03-thinking-in-code.md#310-code-span-masking-before-regex-length-preserving--intermediate) |
| 10 | ISO week boundary computation | I | [03 §3.7](./03-thinking-in-code.md#37-iso-week-boundary-computation--intermediate) |
| 11 | Cadence engine: enum dispatch over schedule types | F | [03 §3.6](./03-thinking-in-code.md#36-cadence-engine-enum-dispatch-over-schedule-types--foundational) |
| 12 | Discriminated unions for domain modeling | F | [03 §3.12](./03-thinking-in-code.md#312-discriminated-unions-for-domain-modeling--foundational) |

After this block you should be able to walk the two-pass scanner from `scanTodos.ts` line by line, explain the Big-O, and name an edit case that *neither* pass catches.

---

## Block 3 — the system-design backbone

This block is the **system design core**. It assumes Block 1's anchors and grows them into a working sync layer.

| # | Concept | Difficulty | Chapter |
|---|---|---|---|
| 13 | Soft delete + tombstone propagation | I | [02 §2.5](./02-systems-thinking.md#25-soft-delete--tombstone-propagation--intermediate) |
| 14 | **(★) Last-write-wins conflict resolution by `updated_at`** | I | [02 §2.6](./02-systems-thinking.md#26-last-write-wins-conflict-resolution-by-updated_at--intermediate) |
| 15 | Idempotent SecureStore-gated migrations | F | [02 §2.4](./02-systems-thinking.md#24-idempotent-securestore-gated-migrations--foundational) |
| 16 | Debounced background dispatch with re-queue | I | [02 §2.10](./02-systems-thinking.md#210-debounced-background-dispatch-with-re-queue--intermediate) |
| 17 | Read-DB-before-deleting safety check | F | [02 §2.13](./02-systems-thinking.md#213-read-db-before-deleting-safety-check--foundational) |
| 18 | Don't-auto-delete-during-sync invariant | F | [02 §2.12](./02-systems-thinking.md#212-dont-auto-delete-during-sync-invariant--foundational) |
| 19 | Topologically-ordered table sync (parents before children) | I | [02 §2.9](./02-systems-thinking.md#29-topologically-ordered-table-sync-parents-before-children--intermediate) |
| 20 | Generic interface as table-pluggability contract | A | [03 §3.15](./03-thinking-in-code.md#315-generic-interface-as-table-pluggability-contract--advanced) |
| 21 | Single aggregate query for derived dashboard data (N+1 collapse) | I | [02 §2.14](./02-systems-thinking.md#214-single-aggregate-query-for-derived-dashboard-data--intermediate) |

After this block you should be able to draw the sync flow on a whiteboard end-to-end: write → debounce → push → pull → conflict → upsert → stamp.

---

## Block 4 — advanced sync mechanics

These are the gotchas. Every one corresponds to a real bug class. Get them under your belt and you can speak credibly about distributed-systems mechanics on a phone.

| # | Concept | Difficulty | Chapter |
|---|---|---|---|
| 22 | Clock-skew-safe pull cursor via server time RPC | A | [02 §2.7](./02-systems-thinking.md#27-clock-skew-safe-pull-cursor-via-server-time-rpc--advanced) |
| 23 | Paginated incremental pull with monotonic cursor | A | [02 §2.8](./02-systems-thinking.md#28-paginated-incremental-pull-with-monotonic-cursor--advanced) |
| 24 | Race-condition-aware bootstrap state machine | A | [02 §2.11](./02-systems-thinking.md#211-race-condition-aware-bootstrap-state-machine--advanced) |
| 25 | Dynamic import to break circular dependencies | I | [03 §3.13](./03-thinking-in-code.md#313-dynamic-import-to-break-circular-dependencies--intermediate) |

---

## Block 5 — the AI pipeline (deeper than block 1's first taste)

You did `heuristic-before-LLM` in block 1. Now wire the rest of the AI workflow.

| # | Concept | Difficulty | Chapter |
|---|---|---|---|
| 26 | **(★) Two-stage classifier → expander pipeline** | I | [01 §1.2](./01-agentic-ai.md#12-two-stage-classifier--expander-pipeline--intermediate) |
| 27 | Cost-aware model routing (cheap classifier vs primary expander) | F | [04 §4.1](./04-ai-product-engineering.md#41-cost-aware-model-routing-cheap-classifier-vs-primary-expander--foundational) |
| 28 | Provider abstraction for swappable models | F | [01 §1.8](./01-agentic-ai.md#18-provider-abstraction-for-swappable-models--foundational) |
| 29 | Provider-agnostic config storage | F | [04 §4.10](./04-ai-product-engineering.md#410-provider-agnostic-config-storage--foundational) |
| 30 | Structured-output prompting with per-type JSON schemas | I | [01 §1.3](./01-agentic-ai.md#13-structured-output-prompting-with-per-type-json-schemas--intermediate) |
| 31 | Validate-and-retry on malformed JSON | I | [01 §1.4](./01-agentic-ai.md#14-validate-and-retry-on-malformed-json--intermediate) |
| 32 | Chain-of-thought reasoning preambles | I | [01 §1.5](./01-agentic-ai.md#15-chain-of-thought-reasoning-preambles--intermediate) |
| 33 | Two-pass LLM chain (structured summary → relatable caption) | I | [01 §1.6](./01-agentic-ai.md#16-two-pass-llm-chain-structured-summary--relatable-caption--intermediate) |
| 34 | One prompt, one job (chain instead of cram) | I | [05 §5.16](./05-language-agnostic.md#516-one-prompt-one-job-chain-instead-of-cram--intermediate) |
| 35 | Concurrency-capped fire-and-forget | I | [01 §1.9](./01-agentic-ai.md#19-concurrency-capped-fire-and-forget--intermediate) |
| 36 | Module-level semaphore via `Set` | I | [03 §3.11](./03-thinking-in-code.md#311-module-level-semaphore-via-set--intermediate) |

After this block you should be able to draw the full AI flow for a single todo: heuristic → cheap classifier (fire-and-forget) → user reads `?` → user picks type → user-overridden lock → user taps expand → expensive expander → validate → retry-once → serialize → DB write.

---

## Block 6 — AI product polish

The "what makes the AI feel good in product" patterns. Lower urgency, higher leverage in interviews about *applied* AI.

| # | Concept | Difficulty | Chapter |
|---|---|---|---|
| 37 | Context-window budgeting via per-source caps | I | [04 §4.2](./04-ai-product-engineering.md#42-context-window-budgeting-via-per-source-caps--intermediate) |
| 38 | Memory pattern: cached AI summaries as conversational context | I | [01 §1.7](./01-agentic-ai.md#17-memory-pattern-cached-ai-summaries-as-conversational-context--intermediate) |
| 39 | Tonal-continuity context injection | I | [04 §4.9](./04-ai-product-engineering.md#49-tonal-continuity-context-injection--intermediate) |
| 40 | User-overridable AI output with permanent lock | F | [04 §4.7](./04-ai-product-engineering.md#47-user-overridable-ai-output-with-permanent-lock--foundational) |
| 41 | Surfacing AI uncertainty to the user | I | [04 §4.12](./04-ai-product-engineering.md#412-surfacing-ai-uncertainty-to-the-user--intermediate) |
| 42 | Graceful degradation around model failures | I | [04 §4.5](./04-ai-product-engineering.md#45-graceful-degradation-around-model-failures--intermediate) |
| 43 | Boot-time catch-up vs. live-write reconciliation | I | [04 §4.6](./04-ai-product-engineering.md#46-boot-time-catch-up-vs-live-write-reconciliation--intermediate) |
| 44 | Two-call chain with structured handoff | I | [04 §4.8](./04-ai-product-engineering.md#48-two-call-chain-with-structured-handoff--intermediate) |
| 45 | Spec-driven AI development | I | [04 §4.3](./04-ai-product-engineering.md#43-spec-driven-ai-development--intermediate) |
| 46 | Memory bank pattern: externalized context via `.aipe/` | I | [04 §4.4](./04-ai-product-engineering.md#44-memory-bank-pattern-externalized-context-via-aipe--intermediate) |
| 47 | Evaluation by inspection (no automated AI evals) — the honest gap | A | [04 §4.11](./04-ai-product-engineering.md#411-evaluation-by-inspection-no-automated-ai-evals--advanced) |

---

## Block 7 — advanced DSA-flavored tricks

Higher-difficulty algorithm patterns. Not gating for the rest of the curriculum, but each is worth a session.

| # | Concept | Difficulty | Chapter |
|---|---|---|---|
| 48 | Sparse-then-dense integer ordering for manual reorder | I | [03 §3.3](./03-thinking-in-code.md#33-sparse-then-dense-integer-ordering-for-manual-reorder--intermediate) |
| 49 | Hash-join + group-by aggregator (dashboard threads) | I | [03 §3.4](./03-thinking-in-code.md#34-hash-join--group-by-aggregator-dashboard-threads--intermediate) |
| 50 | Sliding-window compute (14-day heatmap strip) | I | [03 §3.5](./03-thinking-in-code.md#35-sliding-window-compute-14-day-heatmap-strip--intermediate) |
| 51 | Pure function as the unit of testability | F | [03 §3.14](./03-thinking-in-code.md#314-pure-function-as-the-unit-of-testability--foundational) |

---

## Block 8 — meta-patterns and engineering taste

These are the principles that make a senior engineer. Read them, apply them — they don't have a discrete "exercise" but they recur across every PR you'll write.

| # | Concept | Difficulty | Chapter |
|---|---|---|---|
| 52 | Documented deviation as a first-class artifact | I | [02 §2.15](./02-systems-thinking.md#215-documented-deviation-as-a-first-class-artifact--intermediate) / [05 §5.14](./05-language-agnostic.md#514-documented-deviation-as-a-first-class-artifact--intermediate) |
| 53 | Idempotent operations as a safety property | F | [05 §5.6](./05-language-agnostic.md#56-idempotent-operations-as-a-safety-property--foundational) |
| 54 | What this codebase is *not* doing — agent loops | A | [01 §1.10](./01-agentic-ai.md#110-what-this-codebase-is-not-doing-and-why-thats-a-learning-opportunity--advanced) |

---

## Suggested next steps — beyond the curriculum

When you finish this curriculum and want to go deeper:

1. **Read one open-source local-first sync layer** — for example, [Replicache](https://replicache.dev) or [PowerSync](https://www.powersync.com). Compare their conflict resolution, cursor strategy, and bootstrap path to this codebase's.
2. **Read Hillel Wayne's "What is a CRDT?" series** — gives you the next tier above LWW. You'll see why the manual-touch deviation in `touch.ts` is structurally fine but a multi-device collaborative edit would not be.
3. **Implement an automated eval for the classifier** — dump the last 200 classifications, label them by hand, compute precision/recall, store as a baseline. Re-run after a prompt change. This is the missing piece in §4.11.
4. **Add a third AI provider** — try wiring Gemini or local Ollama into the provider abstraction. The exercise is finding *every* place provider choice shows up. You'll discover seam quality the hard way.
5. **Convert pass 1 of the scanner to a Map lookup** — measure with synthetic 1000-todo entries before and after. Decide whether the optimization is worth the readability cost. This is the kind of micro-decision senior engineers make weekly.
6. **Build the missing 30-day vacuum for soft-deletes** — write the spec first (when does it run? what does it preserve? what about cloud?). Then implement it. You'll touch sync, soft-delete, and idempotency all at once.
7. **Read the Notion sync history** — `git log --all --oneline -- src/services/notion/` will show you the recently-deleted Notion sync layer (M7 in the cloud-sync plan). Compare its design to the Supabase replacement. Why was Notion replaced? The diff is a free architecture lesson.
