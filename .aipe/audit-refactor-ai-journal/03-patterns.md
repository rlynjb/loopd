# Chapter 03 — Patterns

Design patterns are named structural solutions to recurring problems. The discipline is to apply them when the underlying problem matches the pattern — not because the pattern is "good design." A pattern applied without the underlying problem is just added complexity, and small codebases get over-engineered exactly this way.

## Map of the territory

- **Strategy** — DEEP. The AI provider switch (also Chapter 01's dispatch table, also Chapter 02's boundary). Viewed as a pattern, it's the textbook example: swap algorithms at runtime via interchangeable units sharing an interface.
- **Facade** — BRIEF. The sync orchestrator already plays this role over the 10-table push/pull registry; worth naming and worth leaving alone.
- **Adapter** — NOT FOUND as a primary pattern. Each AI chain is technically a per-chain adapter from app needs to provider API, but formalizing those is the Strategy work, not separate Adapter work.
- **State Machine** — NOT FOUND. UI state in this codebase is React-style (effects + setState + derived values). Sync state is "dirty vs synced" gated by SQL predicates, not a state machine. Transcode state is binary (in-flight or done) with a typed cancellation. Nothing in the codebase is a tangled `if (isLoading && !hasError && !isDone)` chain that wants explicit states.
- **Observer / Pub-Sub** — NOT FOUND. The closest thing is `schedulePush()` as a debounced trigger from every DB write, but the producer (`database.ts`) calls the consumer (`pushAll()`) directly with no subscription model. That's fine — the codebase has one producer and one consumer.
- **Command** — NOT FOUND. The sync engine queues dirty rows via SQL predicates, not via wrapped operations. No undo, no replay log, no batching of distinct operations.
- **Template Method** — NOT FOUND in the OO sense. The closest functional shape is `pushTable<T>` + `pullTable<T>` as parameterized algorithms over a `SyncableTable` interface — already in place; the per-table mappers are the "variable steps."
- **Iterator** — NOT FOUND as a refactor. JavaScript's native iteration is used directly; nothing to formalize.
- **Decorator** — NOT FOUND. No "wrap a unit to add logging/caching/auth" candidates of meaningful scope.
- **Proxy** — NOT FOUND.
- **Composite** — NOT FOUND. No tree-shaped data with uniform treatment of nodes and leaves.
- **Factory** — NOT FOUND as a primary pattern. The provider switch produces calls, not objects; treating it as a Factory ("create the right provider instance") is misframing — the chains don't hold provider instances, they fire one call and return.
- **Builder** — NOT FOUND.
- **Dependency Injection** — NOT FOUND as a target. Module-level singletons (`getSupabase()`, `getDatabase()`) are the current pattern; switching to DI would be a re-architecture, not a refactor, and the testability problem DI usually solves is mostly solved by the Chapter 02 Separate Pure from Effectful work.

---

### Strategy — AI provider selection

**Where it shows up** (neutral)

Five chain files (`summarize`, `caption`, `expand`, `classify`, `interpret`) call `await getProvider()` to read the user's saved preference (`'anthropic' | 'openai'`), then branch on the value to choose API endpoint, request shape, model constant, and response-parse shape. The branch repeats across all five files with cosmetic differences. The Strategy diagnosis: the variable behaviour is "which provider executes the call"; the invariant is "the chain's verb produces its typed result." Two interchangeable units (Anthropic-call, OpenAI-call) sharing one interface (request-in, response-text-out).

**Why it's like this** (neutral)

This is Chapter 01's dispatch-table take viewed through the pattern lens. Strategy was the named pattern that would have applied at chain #2 — the moment the OpenAI branch was added by copy-paste. By chain #5 the cost-of-not-doing-it had compounded into "five files of mostly-identical branching."

**Take**

Strategy is the right pattern for this exact problem. The two provider calls are interchangeable, the interface is small (request → response text + a couple of typed pieces like model name and want-json flag), the consumer (each chain) wants to choose at runtime without knowing which it picked. Implement it as a dispatch table per Chapter 01 — that's the functional equivalent of Strategy in TypeScript, and it's lighter than the class-based version.

The reason this gets its own treatment in the patterns chapter (instead of being folded entirely into Chapter 01) is that the *pattern frame* clarifies what to do with two specific edge cases that the dispatch-table frame leaves vague:

1. **Per-chain provider overrides.** Right now every chain reads the same global `getProvider()`. If you want one chain (say, `classify`) to use a cheaper model regardless of the user's preference, you have to add a parameter or branch. With Strategy named explicitly, the right shape is `chain.call({ provider: 'anthropic', model: HAIKU })` — the chain holds a reference to its strategy choice, not a global read.

2. **Provider-specific request features.** Anthropic supports prompt caching; OpenAI doesn't. Anthropic supports thinking-mode (extended thinking); OpenAI's `o1`/`o3` family has a different shape. A pure dispatch-table approach leaves these features unreachable (or forces them into the lowest-common-denominator interface, which is exactly the trap the dispatch-table refactor would walk into). A Strategy interface that exposes provider-specific options (`request.anthropic?.cacheControl`, `request.openai?.responseFormat`) lets each provider opt in without dragging the other along.

**The tradeoff**

What you give up: TypeScript-Strategy is verbose. Three files in a `providers/` directory + one interface + a `providerCall` map + per-chain refactor to call it. That's ~150 net lines and a half-day of work including the chain-by-chain validation pass.

What you avoid: every time a provider-specific feature lands, the current branch-based shape forces a choice between (a) "the feature is in one chain only, branched inline, like the others" — which is what'll keep happening — or (b) a proper provider abstraction, which gets harder to do the longer it's deferred. Right now the codebase has zero provider-specific feature usage; the moment it has one (Anthropic prompt caching is the most likely first), the refactor pays for itself in that PR.

The breakpoint where this stops being right: never functionally, but the breakpoint where it stops being worth doing right now is "neither provider gets a feature buffr would use, AND the second provider's chain count stays at 5, AND no third provider lands, for the next 12 months." Possible but unlikely — prompt caching alone is already a "would-be-useful" for the summarize and interpret chains, which are run repeatedly over similar inputs.

**What I'd watch for**

The Strategy interface design is where this refactor breaks if it's done carelessly. The wrong interface forces a lossy translation in both directions (provider-specific request fields get dropped on the way in; provider-specific response fields get lost on the way out). The right interface is small at the boundary and lets each provider type pass extras through:

```typescript
type ChainRequest = {
  systemPrompt: string;
  userPrompt: string;
  wantsJson: boolean;
  model?: string;          // override the provider's default model
  anthropic?: { cacheControl?: 'ephemeral' };
  openai?: { responseFormat?: 'json_object' | 'text' };
};
type ChainResponse = { text: string; provider: Provider };
```

The provider-specific blocks are nullable, the response is text-only (chains parse it), and the interface stays the same size as more provider features land — those go in the nullable blocks.

**Verdict:** *Worth doing.* Highest-leverage pattern refactor available in this codebase. Sequence: Chapter 01 dispatch table first (mechanical), then this Strategy frame (decides interface), then Chapter 02 pure/effectful split (decides testability).

---

### Facade — sync orchestrator

**Where it shows up** (neutral)

`src/services/sync/orchestrator.ts` exposes two functions: `pullAll()` and `pushAll()`. Each walks the 10-table `REGISTRY` (defined in the same file) and calls `pullTable(table)` / `pushTable(table)` per entry, aggregating results. Callers (`app/_layout.tsx`, `services/sync/bootstrap.ts`, `services/sync/devActions.ts`, `services/sync/schedulePush.ts`) never deal with individual tables — they call `pullAll()` or `pushAll()` and trust the orchestrator to know the registry, the order, and the per-table mappers.

**Take + verdict**

This is a textbook Facade and it's correctly in place. The complex subsystem (10 per-table mappers, push/pull algorithms, conflict resolution, server-time RPC, sync_meta ledger) is collapsed behind two well-named functions. Callers can replace the implementation entirely without touching the call sites, which is exactly the Facade payoff. *Nothing to refactor* — this is the chapter's positive example. The take is: when you're considering whether to introduce a Facade elsewhere, look at how the sync orchestrator does it (registry-driven, parameterized per table, single entry point) — that's the shape.

---

## Chapter close

**Take:** buffr is a codebase that needs almost no patterns. The sync layer already wears a Facade. The AI layer wants a Strategy and that's about it. The reason this chapter has only one DEEP section isn't that the codebase is poor pattern-fit territory — it's that small codebases shouldn't have many pattern applications, and applying patterns without the underlying problem is the #1 thing that breaks small codebases. The take to internalize is: when a future contributor asks "should we use the Command pattern for sync writes" or "should we use Observer for cross-feature notifications" or "should we use a State Machine for the editor," the answer is almost always no — those patterns solve problems this codebase doesn't have. The one place a pattern actually fits (AI providers, Strategy) has been deferred long enough to compound; the moment you act on it, the rest of the codebase keeps its pattern hygiene intact.
