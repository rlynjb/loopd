# Chapter 01 — Composition

Composition refactors are the smallest, safest category: Fowler-style behaviour-preserving operations that pull, push, rename, or restructure code inside a single function or across a small handful of files. They're the most common kind of cleanup work and usually the easiest to verify because the blast radius is tight.

## Map of the territory

- **Replace Conditional with Dispatch Table** — DEEP. The `provider === 'openai' ? … : …` branch repeats five times across the AI chain files. Pattern is identical; cost is one-place-to-change-now.
- **Extract Function** — BRIEF. `app/_layout.tsx` has eleven boot useEffects orchestrating one-time backfills + cloud bootstrap + AI auto-summary. Extracting `useBootSequence()` is honest but not load-bearing.
- **Rename** — BRIEF. `clip_uri` and `clip_duration_ms` columns on `entries` are named for the single-clip era; `clips_json` is the actual primary path. The names lie about which column is canonical.
- **Move Function** — MENTION. `repairBareClipUris()` lives in `database.ts` but operates on clip-storage concerns. Move it next to `fileManager.ts` or into a new `services/clips/` module — see Chapter 02 for the structural treatment.
- **Split Phase** — NOT FOUND. Scanners (`scanTodos` → `reconcileMeta`, `scanNutrition` → `reconcileNutrition`, `scanThreads` → `reconcileThreadMentions`) already split parse from persist cleanly.
- **Inline Function / Inline Variable** — NOT FOUND. No accidental indirection of consequence.
- **Extract Variable** — NOT FOUND in a way worth listing.
- **Decompose Conditional** — NOT FOUND. The conditional in `chooseWinner()` (last-write-wins by `updated_at`) is already as decomposed as the logic permits.
- **Replace Magic Number with Named Constant** — NOT FOUND. `BATCH_SIZE = 50`, `PAGE_SIZE = 200`, `PROXY_MAX_LONG_EDGE = 1920`, `PROXY_CRF = 23` are already named.
- **Parameterize Function** — NOT FOUND as a primary diagnosis. The AI chain parameterization is the dispatch-table angle, handled above.
- **Remove Dead Parameter** — NOT FOUND.

---

### Replace Conditional with Dispatch Table — AI provider switch

**Where it shows up** (neutral)

Five files under `src/services/ai/` carry the same provider-routing shape. In each, after acquiring `provider = await getProvider()` and `apiKey`, the code branches on `provider === 'openai'` to choose API endpoint, request shape, response-parse shape, and (sometimes) model constant. Sample line ranges:

- `src/services/ai/summarize.ts` L43–L69 — `getProvider()` + apiKey selection + model selection + branch on provider to call Anthropic SDK vs raw `fetch` to OpenAI's chat completions endpoint, then branch on provider again to extract the JSON response from the differing response shapes.
- `src/services/ai/caption.ts` L204–L223 — same shape, plus a `provider === 'openai'` ternary for `response_format: { type: 'json_object' }`.
- `src/services/ai/interpret.ts` L166–L210 — same shape, with a twist: this chain wants markdown out, not JSON, so the OpenAI branch omits `response_format` entirely (the Anthropic branch doesn't need to think about it). Three places in the same function check `provider === 'openai'`.
- `src/services/ai/compose.ts` and `src/services/ai/validate.ts` carry the same pattern at smaller scale.

The shared pieces across all five: dynamic `await import('@anthropic-ai/sdk')` (so the SDK isn't bundled into JS that needs it on cold start), `fetch('https://api.openai.com/v1/chat/completions', …)` for OpenAI, model constants defined per-file (`CLAUDE_MODEL` / `OPENAI_MODEL`), and the response shape difference between Anthropic's `messages.create()` and OpenAI's `choices[0].message.content`.

**Why it's like this** (neutral)

The first AI chain shipped against a single provider (Anthropic). The second provider arrived later — almost certainly the OpenAI branch was added by copy-pasting the existing chain and bolting in a branch. By the time the third, fourth, and fifth chains existed, the cost of refactoring to a Strategy was unclear and the cost of keeping the pattern was small per-file. Five files × ~30 lines of branch-related boilerplate = ~150 lines of duplication that nobody notices because no single file looks heavy.

**Take**

This is the one. The dispatch table is small, the verification is mechanical (every chain returns the same shape it did before), and the next time a third provider lands the cost goes from "edit five files" to "add one entry to a map." Replace the branch with a per-provider record:

```typescript
type Provider = 'anthropic' | 'openai';
const providerCall: Record<Provider, (req: ProviderRequest) => Promise<string>> = {
  anthropic: callAnthropic,
  openai:    callOpenAI,
};
```

Each chain file calls `providerCall[provider](req)` and stops thinking about the difference. The two call functions live in a new `services/ai/providers.ts` and own the request-shape + response-parse details. Chain files keep their prompt construction, their response validation, and their domain-specific logic — they just stop dispatching.

This is also the cleanest path to making the AI layer testable in the future. Right now you cannot mock a provider without monkey-patching the SDK; with the dispatch table, the test substitutes a `providerCall.anthropic = mockFn` and the rest works. Whether that matters today is a separate question (Chapter 04 doesn't think test debt is the right thing to act on right now), but the option opens.

**The tradeoff**

What you give up: a small amount of locality — right now you can open `summarize.ts` and see every line of code that produces a summary, including the provider call. After the refactor you have to also open `providers.ts` to see the API-call shape. For a developer who's been reading "summarize" for months and never thinks about the provider boundary, this is a tiny cost. For a developer onboarding, it's a small win — the chain files become readable as prompt + parse + validate, and the provider boilerplate stops being noise in every chain file.

What you avoid: the cost of the next provider. Right now adding Gemini (or replacing OpenAI with a local Llama model, or migrating Anthropic from the SDK to the new Files API) means editing five chain files and re-validating each. After the refactor, it's one file (`providers.ts`) and the chain files don't know.

The breakpoint where this stops being right: never, really — the dispatch table is strictly more flexible than the branch and isn't more expensive at runtime. But the breakpoint where it stops being *worth doing* is "AI provider count stays at 2 and no provider migration ever happens." Buffr lives in that world today; the bet is that within the lifetime of this codebase one of those conditions changes.

**What I'd watch for**

The interpret chain is the trap. It wants markdown out from both providers, which makes the response-parse shape diverge (Anthropic returns markdown by default in `content[0].text`; OpenAI returns markdown wrapped in `choices[0].message.content` but ONLY when you don't pass `response_format: json_object`). If the refactor tries to enforce a single response-shape contract on the dispatch table, interpret breaks subtly — its OpenAI branch needs to NOT pass the JSON response_format flag, and a naive Strategy that always passes "I want JSON" because four-of-five chains do will silently corrupt interpret's output. The right shape is `providerCall[provider](req)` where `req` carries `{ wantsJson: boolean }` and each provider function honours it.

**Verdict:** *Worth doing.* Smallest scope of any DEEP item in this book, biggest payoff in extensibility, near-zero runtime risk.

---

### Extract Function — boot orchestration in `_layout.tsx`

**Where it shows up** (neutral)

`app/_layout.tsx` carries eleven `useEffect` hooks orchestrating cold-start work: the cloud-sync bootstrap, the seven one-time backfills (`backfillTodosFromText`, `backfillNutritionFromText`, `backfillTodoMeta`, `classifyAmbiguousMeta`, `backfillThreadMentions`, `backfillHabitsCadence`, `backfillThreadsTouch`), the clip migration, the AI auto-summary-for-yesterday, and the EAS Update check. Each effect is independent, self-gated by either a `ready` flag, a SecureStore key, or a domain-specific guard, and follows the same shape: `if (!ready) return; (async () => { try { ... } catch { console.warn(...) } })()`.

**Take + verdict**

Extracting these into a `useBootSequence()` hook in `src/hooks/` would shorten `_layout.tsx` and group the boot intent in one place. The cost is that the dependency on `ready` and the per-effect guards leak into the new hook's signature, and you trade one busy file for two slightly-less-busy files. I'd do this only if `_layout.tsx` is the file you're looking at because it's actively painful to read — which it isn't yet. *Worth doing eventually*; not load-bearing.

---

### Rename — `clip_uri` / `clip_duration_ms`

**Where it shows up** (neutral)

`entries.clip_uri TEXT` and `entries.clip_duration_ms INTEGER` are columns on the `entries` table that hold the single primary clip's URI and duration. The multi-clip world that landed later stores everything in `entries.clips_json TEXT` (a JSON array). Read paths in `src/components/journal/*` and elsewhere fall back to `clip_uri` only when `clips_json` is empty/null — meaning `clip_uri` is functionally the legacy fallback, not the primary surface, but the name still says "the clip URI."

**Take + verdict**

The honest rename is `entries.legacy_clip_uri` + `entries.legacy_clip_duration_ms`, which makes the deprecation visible to anyone opening the schema for the first time. But a rename through a synced Postgres schema needs migration choreography that's bigger than a composition refactor — you'd be writing an `ALTER TABLE … RENAME COLUMN` plus updating the per-table mapper plus a one-pass over old rows during the transition. The fix-later item in the cleanup audit folds this into the bigger "consolidate to `clips_json` and drop the legacy columns" move, which is the right shape. *Not worth doing standalone* — fold into the cleanup audit's `consolidate-clips-json` track.

---

### MENTION

- **Move Function** — `repairBareClipUris()` at `src/services/database.ts:21`. Currently lives in the database file because it executes SQL; conceptually belongs in a clips module. Move it or don't; the only cost of leaving it is one more thing `database.ts` is doing. Folded into Chapter 02's Extract Module take.

---

## Chapter close

**Take:** buffr's composition health is good. The one real composition issue is the provider switch, and it's worth doing standalone because the verification is mechanical and the future-cost-avoided is real. The rest of the chapter is short because the codebase mostly composes well already — scanners are sized right, magic numbers are named, conditional logic doesn't accumulate. The pattern this suggests is that whoever wrote buffr has decent composition instincts at the function level and that the debt accumulated only at the level where one principle (provider abstraction) wasn't named early enough to be applied. Composition refactors won't reshape the codebase; they'll just remove the one place a future addition would currently get expensive.
