# Failure modes the codebase explicitly handles

**Industry name(s):** Failure modes, FMEA-lite for AI features
**Type:** Language-agnostic

> AI is best-effort. Every callsite makes sure that an AI failure leaves the canonical data (the prose, the todo, the entry) untouched. The worst outcome of any AI bug is "no AI annotation this time," never "lost data."

**See also:** → [08-validation-gate](./08-validation-gate.md) · → [10-user-overridden-type-lock](./10-user-overridden-type-lock.md)

---

## Why care

AI calls fail. They fail because the network dropped, because the provider is down, because the model returned malformed JSON, because rate limits hit, because the model refused the prompt, because the user's API key expired. Every one of those failures is going to happen, repeatedly, in production. The question is not "how do I prevent them" — you can't — but "what does the user lose when one of them happens at the wrong moment." If the answer is "their data," the architecture is wrong.

The principle here is graceful degradation: the AI layer is best-effort, and a failure in that layer must never damage the canonical data underneath it. It belongs to the family of "fail-soft" and "isolation" patterns — the same shape as circuit breakers around flaky services, write-ahead logs that survive crashes mid-transaction, and CDN fallbacks that serve stale content when the origin dies. You've already seen it in Stripe SDKs that retry idempotently on network errors, in OpenAI clients that surface a typed error instead of a half-parsed response, and in any production LLM stack that wraps every call in "if this throws, the user's record is unchanged." The next block walks the mechanics.

---

## How it works

An office where the regular workflow (sort the mail, file it, send replies) keeps running even when the new AI assistant is offline. The assistant can be helpful, slow, or completely down — the mail still gets sorted. Every named failure mode has a named recovery path; the canonical data path (prose → SQLite) is never blocked by AI failures. If you're coming from frontend, this is the same shape as treating the LLM call as a non-critical async dependency — like a feature-flag service that the app gracefully degrades around when unreachable.

### The principle — the canonical path never waits on AI

The user types prose into `entries.text`. The autosave commits to SQLite synchronously. The scanners produce `todos_json`, `nutrition`, `thread_mentions`. The reconciler enforces 1:1 on `todo_meta`. None of this requires an LLM call to succeed. If you've worked with optimistic-UI mutations that have a "the network is gravy" mental model, this is the same — local commit is the contract; AI enrichment is the optional later step. Concrete consequence: a user with no API key configured types journal entries for 30 days. SQLite fills with prose, todos, nutrition, threads. Zero AI features run. The journal works. The day they configure a key, the AI features start running on new entries; old entries can be backfilled via the catch-up classifier. Boundary: features that *require* AI output (caption variants for vlog export, expand for todo detail) gracefully degrade — the export still runs without captions, the todo detail shows raw text without expansion.

### The eight named failure modes

Each failure has a defined recovery path. Naming them is the discipline; the codebase doesn't have unnamed AI failure modes:

1. **No API key** — every service starts with `if (!apiKey) return { error }`. The UI shows a "configure your AI key" banner.
2. **Network error** — `fetch` rejects, caller catches, returns `null`. SQLite row stays in pre-AI state. Next event (next save, next user action) gets another shot.
3. **Malformed JSON** — `parseJson` returns `null`. `expand` retries once; others skip.
4. **Missing required field** — `validate.ts` rejects; the row ignored.
5. **Caption-call fails inside summarize** — caption is wrapped in its own try/catch (`summarize.ts:87`). Failure logs; the structured summary still saves.
6. **User overrode type** — `user_overridden_type` lock; classifier reads and skips.
7. **MAX_CONCURRENT exceeded** — `expand.ts:25` caps at 3 concurrent expansions; over-cap returns `{ok:false, reason:'in-flight-cap'}`.
8. **Heuristic uncertain** — async LLM scheduled; UI shows placeholder type until update.

Think of it like an enumerated error union in a typed React Query mutation — each failure case has its own UI affordance, each has its own retry policy, none of them silently corrupt downstream state. Concrete consequence: a user with intermittent network gets the same row through cases 2 (network error → skip) and 3 (malformed JSON → expand retries once). The row never lands in a corrupt state; the UI either shows the previous value or a placeholder. Boundary: the eight modes are exhaustive at today's surface area. A new AI feature with a new failure shape (e.g., rate-limit headers requiring backoff) needs to add a ninth named mode rather than swallow the failure under an existing one.

### The split between "skip" and "retry once"

The codebase distinguishes two recovery strategies. **Skip** means "the operation failed; the row stays at its prior state; the next event gets another shot." **Retry once** means "the operation failed once; try one more time with a stricter prompt; if that fails, return failure to the caller." Only `expand` uses retry-once; the others all skip. The reason: `expand` is user-triggered (the user tapped a todo to see its expansion), so a visible failure-state matters; the others are background (typing → autosave → classify), so the user never sees a failure UI. If you've worked with TanStack Query's `retry` option, this is the same shape — per-mutation policy, not a global default. Concrete consequence: user taps an idea todo to see its expansion. Claude returns malformed JSON. `expand` retries with `"Your previous output was not valid JSON for the schema. Re-emit ONLY a single JSON object that exactly matches the schema."` and succeeds. The user sees the expansion ~1.5s later (one extra round-trip) instead of an error. Boundary: too many retries inflate cost; one retry on `expand` is the empirical sweet spot, calibrated against observed malformed-output rates.

### The cap on concurrency — `MAX_CONCURRENT = 3`

`expand.ts` caps concurrent expansions at 3. A 4th simultaneous request returns `{ok: false, reason: 'in-flight-cap'}`; the UI shows a "wait a moment" affordance. The cap exists because expansions can chain (user expands one, scrolls, expands another) and uncapped concurrency would let a runaway user pile up 20 in-flight requests, each costing money. If you've worked with `useQueries` and a max-parallel option, this is the same pattern at the application layer instead of the library layer. Concrete consequence: a user power-clicks through 6 todos in two seconds. The first 3 fire normally; the next 3 return `in-flight-cap`. The UI shows a "wait" badge on the over-cap ones; as the first 3 land, the queued ones run. Total cost: 6 expansion calls, none parallel beyond 3. Boundary: the cap is an application-side guardrail, not a server-side rate limit. If Anthropic's actual rate limit is lower, the codebase would still hit it under sustained traffic; the cap is a politeness measure, not a fallback.

This is what people mean by "graceful degradation for non-critical paths." Every AI feature in the codebase has an answer to "what happens if this fails?" and the answer is never "the user is stuck." The discipline is naming the failure modes — when you've named them, you've designed for them; the unnamed ones are the ones that surprise you in production. Every system that has ever shipped a critical dependency on a flaky service has learned the same lesson: the canonical path stays cheap and local, the enriching paths fail open. The full picture is below.

---

## Failure modes — table

```
  ┌──────────────────────────────┬──────────────────────────────────────────────┐
  │ Failure                      │ How loopd recovers                            │
  ├──────────────────────────────┼──────────────────────────────────────────────┤
  │ No API key configured        │ all 5 services return early; UI shows banner │
  │ Network error                │ caller catches, returns null; row stays in   │
  │                              │ pre-AI state and is retried on next event    │
  │ Malformed JSON (model drift) │ expand: 1 retry with stricter prompt; others:│
  │                              │ skip and log warn                            │
  │ Missing required field       │ validate.ts returns errors[]; row ignored    │
  │ Caption-call fails inside    │ logged; structured summary still saves       │
  │  summarize                   │  (caption is independent — see summarize.ts:87)│
  │ User overrode type           │ next classifier write checks the lock and    │
  │                              │  refuses to overwrite                        │
  │ MAX_CONCURRENT exceeded      │ expandTodo returns { ok:false, reason:'in-flight-cap'} │
  │ Heuristic uncertain          │ deferred to async LLM; UI shows type='todo' │
  │                              │  in the meantime                              │
  │ Interpret: input < 20 chars  │ returns { ok:false, reason:'too-short' };    │
  │  (MIN_TEXT_LENGTH guard)     │ modal shows "entry too short"; no API call   │
  │ Interpret: input > 2000 chars│ truncateTail keeps the most-recent 2000;     │
  │  (MAX_INPUT_CHARS cap)       │ silent — no error, just bounded prompt       │
  │ Interpret: empty/whitespace  │ cleanMarkdown returns null →                  │
  │  model output                │ { ok:false, reason:'malformed' };             │
  │                              │ user sees error UI, can re-tap                │
  │ Interpret: clinical-language │ NOT caught — slips through. Prompt forbids   │
  │  drift                       │  it but no post-call filter. User dismisses   │
  │                              │  the modal.                                   │
  └──────────────────────────────┴──────────────────────────────────────────────┘
```

---

## In this codebase

**Caption isolation:**    `src/services/ai/summarize.ts` → `summarize()` L42–L105 wraps the caption call in its own try/catch at L87–L96 (caption can fail; structured summary still saves)
**Concurrency cap:**      `src/services/todos/expand.ts` → `MAX_CONCURRENT = 3` at L25 — over-cap returns `{ ok:false, reason:'in-flight-cap'}`
**Interpret guards:**     `src/services/ai/interpret.ts` → `MIN_TEXT_LENGTH = 20` (L16) + `MAX_INPUT_CHARS = 2000` (L17) + `truncateTail()` L58–L61 + `cleanMarkdown()` L98–L108. `InterpretResult` (L52) discriminates `'no-ai' | 'too-short' | 'malformed' | 'network'`.
**One-retry pattern:**    `src/services/todos/expand.ts` → `expandTodo()` L191+; the inner `callOnce` invocation pair re-fires with a stricter prompt on validation failure
**All validators:**       `src/services/ai/validate.ts` → `validateSummary()` L12+ + `parseAndValidate()` for caption in `caption.ts` L169–L199 + `validateExpansion()` in `expand.ts` L77–L142 + `cleanMarkdown()` for interpret in `interpret.ts` L98–L108
**Key gate:**             `src/services/ai/config.ts` → key getters L18–L40 (whole file is L1–L50); every chain returns an error reason on early-return when these come back empty

---

## Elaborate

### Where this pattern comes from
"Best-effort with explicit failure modes" is the standard pattern for any side service. Caching layers, analytics, indexing — they're allowed to fail; the main path isn't.

### The deeper principle
**The model is one of many possible failure points. The user's canonical data path must not depend on its success.** Treat AI exactly like an external API that might be down — your app survives the outage.

### Where this breaks down
- Features where AI output IS the canonical data (e.g., the editor's structured composition reads from `ai_summaries.summary_json`). Mitigation: cache prior runs, fall back through `variants.clean → caption → summary.summary`.
- Silent failures the user can't see — a steady stream of AI rejection, none flagged. Mitigation: `/todos` banner, dev-mode logs.

### What to explore next
- [08-validation-gate](./08-validation-gate.md) → the validator step.
- [10-user-overridden-type-lock](./10-user-overridden-type-lock.md) → another protection layer.

---

## Tradeoffs

We traded loud user-visible AI errors for graceful degradation — every AI failure leaves the canonical SQLite write untouched, and the worst outcome is "no annotation this time," never "lost data" or "broken commit."

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (graceful degrade)  │ Alternative (loud throw + halt)│
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Canonical data   │ never blocked — prose to       │ at risk — sync chain failure   │
│ integrity        │ SQLite always commits          │ could abort save; data lost    │
│ User experience  │ silent on AI failure; banner   │ error toast on every network   │
│                  │ surfaces persistent in-flight  │ blip; user trains to ignore    │
│ Money            │ 1 wasted call on expand retry  │ retries on every chain would   │
│ ($/call)         │ (~$0.04); other chains skip    │ multiply cost; no retry =      │
│                  │ on failure (zero retry cost)   │ user manual re-tap            │
│ Observability    │ getClassifyInFlight() banner   │ explicit per-failure-mode      │
│ (at single user) │ + ai_summaries.error + dev     │ counter + alarms — overkill    │
│                  │ logs                           │ for solo phase A               │
│ Failure-mode     │ each chain has typed recovery: │ shared retry-with-backoff      │
│ coding cost      │ skip / retry / soft error      │ utility would centralize but   │
│                  │ surface — ~8 conditions in code│ obscure per-chain semantics    │
│ Cognitive load   │ "AI is best-effort, canonical  │ "every failure is loud; user   │
│                  │ data is never blocked" — one   │ retries, AI fails again, loop" │
│                  │ universal rule                 │ — exhausting UX                │
│ At-scale         │ silent failures hide in        │ explicit metrics scale better; │
│ observability    │ aggregate — needs per-failure  │ but they're not needed at one  │
│                  │ counter for 1000+ users        │ user                           │
│ Capacity / rate  │ MAX_CONCURRENT = 3 on expand;  │ no cap → burst expansion hits  │
│ limits           │ classify uncapped (heuristic   │ 429s; failure mode count grows │
│                  │ bounds volume)                 │ uncontrollably                 │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

We gave up loud, immediate error signalling on AI failures. When `scheduleClassify` fails, the user sees nothing — the row stays at `type='todo'`, the badge never upgrades, and the only signal is the `/todos` banner via `getClassifyInFlight()` showing a stuck in-flight count. When caption fails inside summarize, the structured summary still saves but the 4-variant strip on the dashboard is empty; the user might not realize the model misfired. When interpret returns clinical-language drift, `cleanMarkdown` passes it through and the user dismisses the modal — no telemetry captures the failure.

At single-user phase A, this is acceptable: the developer (me) is the alarm. I notice when my own todos stop classifying, when captions go missing, when interpret reads weird. At 1000 users, this calculation flips — silent failures hide in aggregate, and "AI is degraded" needs to be a real metric with a real alarm.

We also gave up retry budgets on caption, summarize, and classify. Only expand retries (once, with a stricter prompt), because expand is button-fired — the user explicitly asked for it. The other three run automatically; their recovery is "next event will fire another call." Caption skipped means tomorrow's variants might work; summarize failed surfaces error in `ai_summaries.error`; classify skipped leaves the row at `type='todo'` and the next reconcile re-fires. None of these have user-visible retry affordances today.

The `MAX_CONCURRENT = 3` cap on expand is the only explicit cost-control surface. A power user trying to "expand all 12 todos at once" hits the cap and 9 of them return `{ ok: false, reason: 'in-flight-cap' }`. The user has to re-tap as the queue drains. That's a friction point we accept rather than removing the cap and risking unbounded burst cost.

### What the alternative would have cost

A "loud, throw, halt" failure mode would have made every AI error a user-visible event. Every network blip in a tunnel would surface a "AI failed!" toast; users would learn to ignore them within a week and the alarm becomes noise. The deeper cost is that loud failure on the canonical-data path is unacceptable: if an AI error during the summarize chain aborted the editor commit, a flaky network would block the user from saving their journal. We can't have AI failures contaminating the canonical write.

A shared retry-with-backoff utility would have centralized retry logic but obscured per-chain semantics. Expand's retry uses a stricter system prompt because validation failed; that's not the same shape as "network error, exponential backoff." Centralizing both into one utility would force one or the other to use the wrong recovery shape. Five chains with five recovery semantics is more code but more honest than one chain with five branches.

Explicit observability — per-failure-mode counters, "AI is degraded" banners, retry buttons on every stuck row — is genuine infrastructure that we'd need at scale. Today the cost-benefit is wrong: building it for one user is over-engineering, and the developer-as-alarm is good enough. The day we have 1000 users with no individual developer eyes, the observability investment becomes the first priority.

### The breakpoint

The pattern flips the day "no annotation" becomes user-visible *as failure*. Today every chain is advisory: missing classify → row stays at `type='todo'`, missing caption → no variants strip, missing summarize → editor shows un-annotated state, missing expand → user sees "couldn't expand" and re-fires, missing interpret → user closes modal. None of these are "broken product" — they're "AI didn't run this time."

The trigger shapes for flipping: (a) editor refuses to render without structured summary (AI becomes load-bearing — we'd add server-side fallback or remove the dependency), (b) the user pays for an AI feature and "couldn't generate" feels like a billing dispute (we'd add explicit retry UX and SLA-style failure handling), (c) failure rate climbs past ~5% (we'd tighten validators, add backoff, or surface failures explicitly).

A secondary trigger: multi-user. At 1000 users I'd need (i) a per-failure-mode counter (track which mode is firing how often), (ii) alarms when failure rates spike (model upgrade ate the schema), (iii) per-user diagnostic showing why their AI features are degraded, (iv) tighter MAX_CONCURRENT (global cost ceiling, not just per-user). The recovery shapes don't change; the observability and cost-control do.

### What wasn't actually a tradeoff

Silent-failure vs throwing-the-error wasn't a real choice for the canonical data path. The principle "canonical data is never blocked by AI" (spec §10 principle 3) forecloses any failure mode where an AI error halts the prose-to-SQLite write. We could have thrown errors in the AI services and caught them in callers — but the catch handler would still have to swallow them silently to preserve the canonical write. Same outcome, two function boundaries instead of one.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk / Claude Sonnet 4.6 + Haiku 4.5

- **Codebase uses:** `@anthropic-ai/sdk` for `summarize`, `caption`, `expand`, `interpret` (Sonnet) and `classify` (Haiku).
- **Why it's here:** Anthropic is the primary provider; every failure mode in the table (malformed JSON, network error, no-API-key) applies per-call.
- **Leading today:** `@anthropic-ai/sdk` — `adoption-leading`, 2026.
- **Why it leads:** native SDK gives first-class access to prompt caching, JSON output, and tool calling that wrappers sometimes flatten or delay.
- **Runner-up:** Vercel AI SDK — `innovation-leading` multi-provider streaming with typed message structures and `useChat` hook.

### Raw fetch to OpenAI `/v1/chat/completions`

- **Codebase uses:** raw `fetch`; OpenAI is the alternate provider branched in `callOpenAI()` across all 5 chains.
- **Why it's here:** the failure-mode table applies to both providers — network errors, 429s, malformed JSON all fire on the OpenAI path too.
- **Leading today:** OpenAI Node SDK — `adoption-leading`, 2026.
- **Why it leads:** typed request/response shapes, built-in retries, and the most-used OpenAI client in production.
- **Runner-up:** Vercel AI SDK — `innovation-leading` wrapper unifying OpenAI + Anthropic + others under one interface.

---

## Project exercises

### [B5.1] Request queue with retry/backoff for all chains + RAG retrievals

- **Exercise ID:** `[B5.1]`
- **What to build:** A small async queue in `src/services/ai/queue.ts` that wraps every chain call. Exponential backoff (250ms → 500ms → 1s) on 5xx and network errors; per-chain concurrency cap (`MAX_CONCURRENT = 3` for expand stays; classify gets its own bucket). When Phase 2A ships, the queue covers RAG retrievals too.
- **Why it earns its place:** the current pattern is per-chain try/catch with no retry. A failed network call right now means "no annotation this time"; with the queue, transient failures recover silently and the failure-modes table only fires after the retry budget exhausts.
- **Files to touch:** new `src/services/ai/queue.ts`; edit `summarize.ts`, `caption.ts`, `classify.ts`, `expand.ts`, `interpret.ts` to enqueue rather than call directly.
- **Done when:** every chain goes through the queue; an injected 503 fixture retries twice and then surfaces the failure; per-chain concurrency caps hold under stress.
- **Estimated effort:** `1–2 days`.

### [B5.4] Circuit breaker for provider outage

- **Exercise ID:** `[B5.4]`
- **What to build:** A circuit breaker layered on top of `[B5.1]`'s queue. After N consecutive failures (default 5) on a provider, the breaker opens for T minutes (default 2). Open state short-circuits new calls and surfaces a clean error to callers; half-open state lets one probe through to test recovery.
- **Why it earns its place:** during a real provider outage, retries make things worse. The breaker is the difference between "the app degrades gracefully" and "the app retry-storms a dying provider."
- **Files to touch:** new `src/services/ai/circuitBreaker.ts`; integrates with `[B5.1]` queue; surfaced in `[B1.8]` AI ops panel.
- **Done when:** the breaker opens after 5 consecutive failures, blocks for 2 minutes, then probes; ops panel shows breaker state per provider.
- **Estimated effort:** `1–2 days`.

---

## Summary

Graceful-degradation for AI features is the "fail-soft + isolation" pattern — every AI failure mode has a defined recovery path that leaves the canonical data (prose, todo, entry) untouched. In this codebase that shows up as a per-failure-mode table across all 5 chains: `summarize.ts:87` wraps the caption call in its own try/catch so caption failure doesn't kill the structured summary; `expand.ts:25` caps concurrency at `MAX_CONCURRENT = 3`; `interpret.ts` adds 4 new failure surfaces (too-short, malformed-markdown, network, no-ai) via the `InterpretResult` discriminated union; `validate.ts` rejects malformed JSON before any SQLite write. The constraint that drove it is "canonical data is never blocked by AI" — the worst outcome of any AI bug is "no annotation this time," never "lost data." The cost is silent failures: a flaky network leaves classifications stuck at `type='todo'` and at single-user phase A the only signal is the `/todos` banner via `getClassifyInFlight()`.

Key points to remember:
- Every chain has a defined recovery path; nothing throws past the AI boundary.
- The canonical SQLite write happens before or independently of the AI write — always.
- Retry budget tracks user intent: expand retries with a stricter prompt; classify doesn't.
- `MAX_CONCURRENT = 3` caps expand cost; classify has no cap because heuristic gating bounds volume.
- Silent-failure modes are the gap at scale — at one user the dev is the alarm; at 1000 users a per-failure-mode counter and "AI degraded" banner become necessary.

---

## Interview defense

### What an interviewer is really asking
"What happens when AI fails?" tests whether I have a recovery story or just a happy path. The interviewer wants to hear the principle "canonical data is never blocked by AI" backed by code references — `summarize.ts:87` caption try/catch, `expand.ts:25` MAX_CONCURRENT, the one-retry pattern. The candidate who can only describe the success path fails this question.

### Likely questions

[mid] Q: Trace what happens end-to-end when the user has no API key set.
      A: Every AI service starts with `if (!apiKey) return { error: 'no API key' }` — the early return lives in `ai/config.ts` at the key-getter site. The chain never makes a network call. The caller propagates the error or surfaces it via a UI banner pointing to settings. The canonical data path is unaffected: prose still saves to SQLite, todos still parse out, the editor still commits. The user just doesn't get AI annotations until they configure a key. This is the cleanest of all the failure modes because it's a synchronous gate before any side effects.

```
[no-API-key flow — synchronous gate before side effects]

  any AI chain fires (summarize / caption / classify / expand / interpret)
        │
        ▼  getAnthropicKey() / getOpenAIKey() from config.ts
  apiKey === null
        │
        ▼  early return: { ok: false, reason: 'no-ai' }
  caller surfaces "configure your AI key" banner
        │
        ▼  CANONICAL PATH UNAFFECTED:
  prose still saves to entries.text          ← never blocked
  scanners still extract todos / threads     ← never blocked
  editor still commits                        ← never blocked
```

[senior] Q: Why one retry on malformed JSON in `expand.ts` and zero retries in caption/summarize/classify?
         A: Because expand's expected output is high-information per call (a typed JSON object filling 4-6 required fields like `observed`, `expected`, `suspectedCause`, `reproSteps[]` for 'bug') and the user explicitly fired the expand action. Failing silently after one network call would be a bad UX — the user pressed "expand", saw nothing happen, doesn't know why. The retry with a stricter prompt ("Your previous output was not valid JSON for the schema. Re-emit ONLY a single JSON object…") rescues the borderline cases. Caption, summarize, and classify run automatically — no user intent — and they have other recovery paths (caption skipped means structured summary still saves; summarize surfaces error in `ai_summaries.error`; classify stays at heuristic-or-null). The retry budget tracks user intent, not technical possibility.

```
                  Path taken (retry tracks user intent)  Alternative (retry everything)
                  ─────────────────────────────────────  ───────────────────────────────
expand            user pressed button → retry once       same outcome
                  stricter prompt → soft give-up
caption           automatic → skip on fail               retry adds ~$0.04, no clear win
                  (structured summary still saves)        — caption is automatic, next
                                                         summarize fires tomorrow
summarize         automatic → surface error in           retry could double cost on
                  ai_summaries.error                     persistent drift; bigger lock-in
classify          automatic → skip; next reconcile       retry would waste Haiku calls
                  re-fires on null confidence            ($0.0001 × 30 todos = $0.003)
                                                         per failure; pointless
retry budget      tracks user intent — button = 1 retry  blind technical retry —
shape             auto = next event is the retry          ignores who fired the action
$ cost per fail   ~$0.04 (expand only); others $0       ~$0.04 × N chains; multiplies
debugging         per-chain recovery semantics visible   uniform but obscure — when did
                                                         retry stop helping?
```

[arch] Q: At scale — say 1000 users — how would this failure-mode list change?
       A: Most of it stays the same, but the silent-failure modes become real problems. Today a user with consistently-failing classification sees `type='todo'` on every row and might not notice. At 1000 users I'd need server-side aggregate visibility — a metric for "classification failure rate per provider per model", alarms when it spikes (model upgrade ate the schema), and a per-user diagnostic. I'd also tighten `MAX_CONCURRENT` from a per-user cap to a global cost ceiling, and probably add exponential backoff on 429s. The recovery shapes don't change; the observability and cost-control do.

```
At 1000 users (no individual dev eyes; aggregate-only signal):

  ┌─ Per-chain recovery shapes ─────────────────┐
  │ unchanged — skip / retry / soft error       │
  │ surface — same semantics                     │
  └─────────────────────────────────────────────┘
              │
  ┌─ Today: silent failures + dev-as-alarm ─────┐
  │ getClassifyInFlight() banner                │  ◀── BREAKS FIRST
  │ ai_summaries.error column                   │     (aggregate failures
  │ dev-mode logs (no real user reads)          │      invisible; "AI degraded"
  │                                              │      undetectable from any
  │                                              │      single user's view)
  └─────────────────────────────────────────────┘
              │ needs replacement
              ▼
  ┌─ NEW: telemetry layer + alarms ─────────────┐
  │ per-failure-mode counter (network / parse /  │
  │ validate / 429 / rate-limit)                 │
  │ per-provider per-model failure-rate metric  │
  │ "AI is degraded" banner with retry action   │
  │ global MAX_CONCURRENT cost ceiling           │
  │ exponential backoff on 429s                  │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: You list eight failure modes, but the table reads like "we log it and move on." What's a failure that would actually make you want a user-visible alarm — and why don't you have one today?

A: Fair — the silent-failure modes are the gap. The one that would justify a real alarm is "classification consistently failing for this user across multiple entries" — meaning either their key is bad, the model upgrade broke the schema, or they're rate-limited. Today the only signal is the `/todos` banner showing in-flight count via `getClassifyInFlight()` which doesn't drop, and dev-mode logs no real user reads. The reason I haven't built it is the cost-benefit at single-user phase A: an alarm system means deciding what counts as "consistently failing" (3 in a row? 10 in 5 minutes?), how to surface it (toast, banner, settings badge?), and how to recover (button to retry? auto-retry?). At one user with sporadic use, the developer (me) is the alarm — I notice when my own todos stop classifying. The day this app has more users, the first observability investment is a per-failure-mode counter and a "AI is degraded" banner with a retry action. Until then, "log and move on" is the honest behaviour.

```
                  Path taken (silent log)              Suggested (per-failure alarm)
                  ──────────────────────               ──────────────────────────────
alarm trigger     none                                 N failures in M minutes per
                                                       chain (e.g. 3-in-5)
new UI surfaces   getClassifyInFlight() banner only    per-chain status badge +
                                                       settings diagnostic panel +
                                                       "AI is degraded" toast
new state needed  none — failure is fire-and-forget    per-chain failure counter,
                                                       last-failure-timestamp,
                                                       failure-reason union
false-alarm cost  zero                                 high — every tunnel = alarm
                                                       fires; user trains to ignore
phase-A fit       solo dev IS the alarm                over-engineered for one user
$ cost            0                                    counter writes on every fail;
                                                       trivial $$ but real LOC
when this flips   multi-user OR paid AI feature OR     ship the alarm layer;
                  AI becomes load-bearing              recovery shapes unchanged
1000-user fit     blind — aggregate failures hide      essential — per-provider failure
                                                       rate is the most important
                                                       metric to track
honest framing    "log and move on" is the right       ship when the cost-benefit
                  posture for advisory AI at phase A   actually flips
```

### One-line anchors
- "Canonical data is never blocked by AI. The worst outcome is 'no annotation this time'."
- "Retry budget tracks user intent. Expand retries; classify doesn't."
- "Silent-failure modes are the visible gap at scale. At one user, the dev is the alarm."
- "Every failure path leaves the canonical SQLite row untouched."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the failure-mode table from memory. Label every row.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain "AI is best-effort, canonical data is never blocked" to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → at least one of `summarize.ts:87` or `expand.ts:25` or `expand.ts:234`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

The user has been on a flaky train for 30 minutes. They've committed 4 entries with 12 todos total — 8 ambiguous (need LLM classify), 2 expand button presses, 1 caption-after-summary day. Every network call has been failing with timeouts. Walk what the user sees: which AI annotations are missing, which canonical data is intact, what does `/todos` show as in-flight, and what happens when the network returns at minute 31?

Write your answer. 3–5 sentences minimum. Then open `src/services/ai/summarize.ts` L87–L96, `src/services/todos/expand.ts` L25 + L211–L266, and `src/services/todos/classify.ts` L90–L120 to verify the recovery shapes.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/ai/summarize.ts:87` (the silent-log behaviour) to support what exists
→ Point to where a per-failure-mode counter + a UI banner would land (likely a new `src/services/ai/telemetry.ts` plus an `/todos` banner state) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — added 4 new interpret-specific failure modes (too-short / over-cap / malformed-markdown / clinical-drift); bumped service count from 4 to 5. See `14-interpret.md`.
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block.
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary table to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the table.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @anthropic-ai/sdk, raw fetch to OpenAI.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (office-without-AI-assistant metaphor opening / 4 layered sub-sections — canonical path never waits on AI, the 8 named failure modes, skip vs retry-once split, MAX_CONCURRENT cap — each with frontend bridges and concrete consequences / principle paragraph on graceful degradation for non-critical paths).
