# 06 — The ordered learning path

This chapter sequences every concept across the five category chapters into a **single dependency-ordered reading path**. Concepts come in the order that maximizes "the next thing builds on what you just read." Difficulty markers help you pace yourself; section links jump back to the full explanation.

The path has four phases:

- **Phase 1 — Foundations.** The mental models and primitives. Read these first; the rest leans on them.
- **Phase 2 — System mechanics.** How loopd's specific architecture (DB, sync, scanners, principles) actually fits together.
- **Phase 3 — AI as a typed component.** How the AI features are wired in as small, validated, chained calls.
- **Phase 4 — Product and engineering judgment.** The decisions that distinguish "code that works" from "code you'd actually ship."

You don't have to follow the path strictly — feel free to skip ahead to a concept that interests you, then circle back when you hit a prerequisite you don't recognize. But for a first pass, the order is calibrated to minimize confusion.

---

## Phase 1 — Foundations (foundational tier)

These concepts give you the vocabulary and shape of the system. None of the rest will land until you have these.

| # | Concept | Chapter | Difficulty |
|---|---|---|---|
| 1 | [Single source of truth (SQLite is canonical)](./02-systems-thinking.md#21-single-source-of-truth-sqlite-is-canonical) | 02 | foundational |
| 2 | [Derived state vs. canonical state (prose-as-canonical for drops)](./02-systems-thinking.md#22-derived-state-vs-canonical-state-prose-as-canonical-for-drops) | 02 | foundational |
| 3 | [Type-driven design (let the types tell you what's possible)](./03-thinking-in-code.md#31-type-driven-design-let-the-types-tell-you-whats-possible) | 03 | foundational |
| 4 | [Pure functions for testability (cadence, staleness, ranking)](./03-thinking-in-code.md#34-pure-functions-for-testability-cadence-staleness-ranking) | 03 | foundational |
| 5 | [Compose pure functions with thin effectful glue](./05-language-agnostic.md#58-compose-pure-functions-with-thin-effectful-glue) | 05 | foundational |
| 6 | [Document architectural principles, then cite them in code](./05-language-agnostic.md#51-document-architectural-principles-then-cite-them-in-code) | 05 | foundational |
| 7 | [Lazy initialization with a sentinel value](./05-language-agnostic.md#54-lazy-initialization-with-a-sentinel-value) | 05 | foundational |

**Phase 1 checkpoint.** You should now be able to name the canonical store, explain why prose is canonical (not the structured records), and describe what a "pure function" buys you in a codebase with no test suite.

---

## Phase 2 — System mechanics (intermediate tier)

These concepts walk you through loopd's specific architecture. They lean on the foundational ideas — derived state, single SoT — and add the mechanisms that make them practical.

| # | Concept | Chapter | Difficulty |
|---|---|---|---|
| 8 | [Two-pass matching (preserve identity through edits)](./02-systems-thinking.md#23-two-pass-matching-preserve-identity-through-edits) | 02 | intermediate |
| 9 | [Idempotent reconciliation (commit can re-run safely)](./02-systems-thinking.md#24-idempotent-reconciliation-commit-can-re-run-safely) | 02 | intermediate |
| 10 | [Migration-safe schema evolution](./02-systems-thinking.md#213-migration-safe-schema-evolution) | 02 | intermediate |
| 11 | [Soft delete with tombstones](./02-systems-thinking.md#25-soft-delete-with-tombstones) | 02 | foundational |
| 12 | [Idempotent backfills with a one-time gate flag](./05-language-agnostic.md#56-idempotent-backfills-with-a-one-time-gate-flag) | 05 | intermediate |
| 13 | [Separate "the thing" from "metadata about the thing"](./05-language-agnostic.md#511-separate-the-thing-from-metadata-about-the-thing) | 05 | intermediate |
| 14 | [Defensive parsing of JSON columns](./03-thinking-in-code.md#312-defensive-parsing-of-json-columns) | 03 | intermediate |
| 15 | [Discriminated unions (the `TodoExpansion` shape)](./03-thinking-in-code.md#32-discriminated-unions-the-todoexpansion-shape) | 03 | intermediate |
| 16 | [Discriminated result types (`{ ok: true, ... } \| { ok: false, reason: ... }`)](./03-thinking-in-code.md#39-discriminated-result-types--ok-true----ok-false-reason---) | 03 | intermediate |
| 17 | [Schema-first development (DB schema → TS types → runtime validators)](./03-thinking-in-code.md#33-schema-first-development-db-schema--ts-types--runtime-validators) | 03 | intermediate |
| 18 | [Fire-and-forget for non-blocking side effects](./03-thinking-in-code.md#36-fire-and-forget-for-non-blocking-side-effects) | 03 | intermediate |
| 19 | [Optimistic updates (round-trip via prose rewrite)](./03-thinking-in-code.md#37-optimistic-updates-round-trip-via-prose-rewrite) | 03 | intermediate |

**Phase 2 checkpoint.** You should be able to walk through a single entry-commit lifecycle end-to-end: user types → DB write → scanners run → derived rows reconciled → fire-and-forget classifier scheduled. Bonus: explain what would go wrong if the scanners weren't pure.

---

## Phase 3 — Sync, concurrency, and convergence (intermediate to advanced)

These concepts introduce the cloud-sync layer and the patterns that keep distributed-ish systems sane. Hardest material in the curriculum; do it after Phase 2 lands.

| # | Concept | Chapter | Difficulty |
|---|---|---|---|
| 20 | [The sync orchestrator — push/pull as separate ordered passes](./02-systems-thinking.md#26-the-sync-orchestrator--pushpull-as-separate-ordered-passes) | 02 | intermediate |
| 21 | [Last-write-wins conflict resolution by `updated_at`](./02-systems-thinking.md#27-last-write-wins-conflict-resolution-by-updated_at) | 02 | intermediate |
| 22 | [Server-time RPC for clock-skew safety](./02-systems-thinking.md#28-server-time-rpc-for-clock-skew-safety) | 02 | advanced |
| 23 | [Bootstrap decision tree (initial-push vs first-pull vs no-op)](./02-systems-thinking.md#29-bootstrap-decision-tree-initial-push-vs-first-pull-vs-no-op) | 02 | intermediate |
| 24 | [Debounced batching (5s push debounce)](./02-systems-thinking.md#210-debounced-batching-5s-push-debounce) | 02 | intermediate |
| 25 | [Eventual consistency over strong consistency](./05-language-agnostic.md#55-eventual-consistency-over-strong-consistency) | 05 | advanced |
| 26 | [Race-safe focus cleanup (the "never clear live refs" rule)](./02-systems-thinking.md#211-race-safe-focus-cleanup-the-never-clear-live-refs-rule) | 02 | advanced |
| 27 | [Dynamic import to break circular dependencies](./02-systems-thinking.md#212-dynamic-import-to-break-circular-dependencies) | 02 | advanced |
| 28 | [Self-healing systems (fix on next encounter)](./05-language-agnostic.md#512-self-healing-systems-fix-on-next-encounter) | 05 | advanced |
| 29 | [The deletion queue (deferred delete propagation)](./02-systems-thinking.md#214-the-deletion-queue-deferred-delete-propagation) | 02 | intermediate |
| 30 | [Boundary discipline — what the DB layer does (and doesn't)](./02-systems-thinking.md#215-boundary-discipline--what-the-db-layer-does-and-doesnt) | 02 | intermediate |

**Phase 3 checkpoint.** You should be able to trace a single user keystroke from journal input → DB write → debounced push → cloud upsert → other-device pull. Bonus: describe what `chooseWinner` does when both sides have the same timestamp, and why the asymmetric tiebreak is correct.

---

## Phase 4 — AI as a typed component (foundational to intermediate)

These concepts cover how AI fits into the codebase as a small set of well-defined calls. Read after Phase 1; many concepts here lean on type-driven design and discriminated results.

| # | Concept | Chapter | Difficulty |
|---|---|---|---|
| 31 | [LLM call vs. agent — and why loopd is the former](./01-agentic-ai.md#11-llm-call-vs-agent--and-why-loopd-is-the-former) | 01 | foundational |
| 32 | [Heuristic-before-LLM (cheapest model path)](./01-agentic-ai.md#12-heuristic-before-llm-cheapest-model-path) | 01 | foundational |
| 33 | [Heuristic-before-LLM as a general "deterministic-before-probabilistic" rule](./05-language-agnostic.md#59-heuristic-before-llm-as-a-general-deterministic-before-probabilistic-rule) | 05 | foundational |
| 34 | [Caching LLM output (per-date AI summary cache)](./01-agentic-ai.md#19-caching-llm-output-per-date-ai-summary-cache) | 01 | foundational |
| 35 | [Two-stage classification (cheap model → expensive model split)](./01-agentic-ai.md#13-two-stage-classification-cheap-model--expensive-model-split) | 01 | intermediate |
| 36 | [Provider abstraction (Anthropic vs OpenAI)](./01-agentic-ai.md#14-provider-abstraction-anthropic-vs-openai) | 01 | intermediate |
| 37 | [Prompt chaining (structured summary → relatable caption)](./01-agentic-ai.md#15-prompt-chaining-structured-summary--relatable-caption) | 01 | intermediate |
| 38 | [Chain-of-thought reasoning preambles](./01-agentic-ai.md#16-chain-of-thought-reasoning-preambles) | 01 | intermediate |
| 39 | [Output validation + retry-with-stricter-instruction](./01-agentic-ai.md#17-output-validation--retry-with-stricter-instruction) | 01 | intermediate |
| 40 | [In-flight concurrency cap + progress events](./01-agentic-ai.md#18-in-flight-concurrency-cap--progress-events) | 01 | intermediate |
| 41 | [Bounded context windows (cap context inputs by length)](./01-agentic-ai.md#110-bounded-context-windows-cap-context-inputs-by-length) | 01 | intermediate |
| 42 | [Boot-time catch-up loop (reprocess incomplete state)](./01-agentic-ai.md#111-boot-time-catch-up-loop-reprocess-incomplete-state) | 01 | intermediate |
| 43 | [Concepts not present (and why)](./01-agentic-ai.md#112-concepts-not-present-and-why) | 01 | foundational |

**Phase 4 checkpoint.** You should be able to explain the three-stage lifecycle of a journal todo: write → heuristic → (eventual) LLM classify → (manual) LLM expand. Bonus: defend the choice to fire-and-forget the classifier instead of awaiting it.

---

## Phase 5 — Product judgment + portable patterns (foundational to advanced)

These concepts are about *why* the previous decisions are right (or wrong) for this product. Read last — you need the technical mental models to evaluate the tradeoffs.

| # | Concept | Chapter | Difficulty |
|---|---|---|---|
| 44 | [The product principle: AI augments the user, doesn't replace them](./04-ai-product-engineering.md#412-the-product-principle-ai-augments-the-user-doesnt-replace-them) | 04 | foundational |
| 45 | [Cost-per-call as a first-class design constraint](./04-ai-product-engineering.md#41-cost-per-call-as-a-first-class-design-constraint) | 04 | foundational |
| 46 | [User-controlled triggers for expensive operations](./04-ai-product-engineering.md#42-user-controlled-triggers-for-expensive-operations) | 04 | foundational |
| 47 | [The AI feature gracefully degrades (no-key path)](./04-ai-product-engineering.md#48-the-ai-feature-gracefully-degrades-no-key-path) | 04 | intermediate |
| 48 | [Stable sort orders + tiebreakers](./03-thinking-in-code.md#311-stable-sort-orders--tiebreakers) | 03 | intermediate |
| 49 | [Orchestration via custom hooks (`useEntries`, `useDatabase`)](./03-thinking-in-code.md#35-orchestration-via-custom-hooks-useentries-usedatabase) | 03 | intermediate |
| 50 | [Lazy loading + module-scope singletons](./03-thinking-in-code.md#38-lazy-loading--module-scope-singletons) | 03 | intermediate |
| 51 | [Event bus for cross-component progress signals](./03-thinking-in-code.md#310-event-bus-for-cross-component-progress-signals) | 03 | intermediate |
| 52 | [Auto-generation on intent surfaces (vlog editor mount)](./04-ai-product-engineering.md#46-auto-generation-on-intent-surfaces-vlog-editor-mount) | 04 | intermediate |
| 53 | [Spec-driven development (the spec is the source of truth)](./04-ai-product-engineering.md#43-spec-driven-development-the-spec-is-the-source-of-truth) | 04 | intermediate |
| 54 | [Memory bank patterns (.aipe + project context)](./04-ai-product-engineering.md#44-memory-bank-patterns-aipe--project-context) | 04 | intermediate |
| 55 | [Tonal continuity via prior-output context](./04-ai-product-engineering.md#45-tonal-continuity-via-prior-output-context) | 04 | advanced |
| 56 | [Anti-repetition + voice rules in system prompts](./04-ai-product-engineering.md#47-anti-repetition--voice-rules-in-system-prompts) | 04 | intermediate |
| 57 | [Cost vs. capability tradeoff (when to escalate models)](./04-ai-product-engineering.md#49-cost-vs-capability-tradeoff-when-to-escalate-models) | 04 | advanced |
| 58 | [Latency budget vs. perceived performance](./04-ai-product-engineering.md#411-latency-budget-vs-perceived-performance) | 04 | intermediate |
| 59 | [Evaluation by hand, not by metric](./04-ai-product-engineering.md#410-evaluation-by-hand-not-by-metric) | 04 | advanced |

---

## Phase 6 — Engineering wisdom (intermediate to advanced)

The "lessons from running the system in production" tier. Read these last; they're meaningless without the technical foundation.

| # | Concept | Chapter | Difficulty |
|---|---|---|---|
| 60 | [Document the deviations explicitly](./05-language-agnostic.md#52-document-the-deviations-explicitly) | 05 | intermediate |
| 61 | [Make invariants explicit (in code, in CHECKs, in types)](./05-language-agnostic.md#53-make-invariants-explicit-in-code-in-checks-in-types) | 05 | intermediate |
| 62 | [The `null` vs. `undefined` distinction (semantic optionality)](./05-language-agnostic.md#57-the-null-vs-undefined-distinction-semantic-optionality) | 05 | intermediate |
| 63 | [The "lock on user override" pattern](./05-language-agnostic.md#510-the-lock-on-user-override-pattern) | 05 | intermediate |
| 64 | [What the type system isn't doing yet (and why)](./03-thinking-in-code.md#313-what-the-type-system-isnt-doing-yet-and-why) | 03 | advanced |
| 65 | [Pattern recognition across the chapters](./05-language-agnostic.md#513-pattern-recognition-across-the-chapters) | 05 | advanced |

---

## Suggested next steps

You finished the curriculum. Now what?

1. **Pick three concepts you found surprising and re-read them**, with the source files open, until you can explain them without looking. The "without looking" is the test — knowing of a concept and being able to wield it are different skills.

2. **Implement one of the named exercises.** From the curriculum:
   - **Build a shared `callLLM(provider, system, user)` helper** (§1.4) and migrate one of the four AI modules to it. Notice what you have to give up. Decide whether the trade-off is worth it.
   - **Build the Phase B "pick which side wins" dialog** for the bootstrap decision tree (§2.9 / §sync `bootstrap.ts:88-91`). Even just a console-prompt mock teaches you the shape.
   - **Build a 30-day vacuum job** for soft-deleted rows (§2.5). Run it on boot. Add a SecureStore flag so it only runs once a week. Add metrics to log how many rows it cleaned up.
   - **Build an LLM-as-judge evaluator for the caption feature** (§4.10). Pick 20 sample inputs from your own journal. Run the caption generator against each. Have a separate Sonnet call score each output 1–5 against the spec's "FORMULAS" and "NEVER" rules.

3. **Apply the patterns to a different codebase.** The next time you start a project, ask:
   - "Where's my single source of truth?"
   - "What's my heuristic-before-expensive-call?"
   - "What invariants do I need to enforce in CHECKs vs types vs comments?"
   - "What's my eventual-consistency convergence path?"

   These questions transfer everywhere.

4. **Read one more codebase using this same lens.** Pick a small open-source app you respect. Read it the way you read loopd: identify its derived-vs-canonical split, its conflict-resolution model, its cost guardrails on AI (if any). The curriculum's value is *the lens*, not loopd.

5. **Re-read the deviations chapter (§5.2) and the war-story chapters (§2.11).** Engineering judgment is the ability to say "I'm breaking the rule on purpose, and here's why." The deviations are where that judgment lives.

That's the curriculum. Go build something.
