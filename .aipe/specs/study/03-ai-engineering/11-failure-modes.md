# Failure modes the codebase explicitly handles

> AI is best-effort. Every callsite makes sure that an AI failure leaves the canonical data (the prose, the todo, the entry) untouched. The worst outcome of any AI bug is "no AI annotation this time," never "lost data."

**See also:** → [08-validation-gate](./08-validation-gate.md) · → [10-user-overridden-type-lock](./10-user-overridden-type-lock.md)

---

## Quick summary
- **What:** an enumerated list of every AI failure mode and how the codebase recovers.
- **Why here:** treating AI as best-effort with hard-fail handling means the user's data is never at the mercy of the model.
- **Tradeoff:** "best-effort" sometimes leaves gaps (no expansion, missing caption). The user sees "couldn't run that," not "your todo is gone."

---

## Failure modes — table

```
  ┌──────────────────────────────┬──────────────────────────────────────────────┐
  │ Failure                      │ How loopd recovers                            │
  ├──────────────────────────────┼──────────────────────────────────────────────┤
  │ No API key configured        │ all 4 services return early; UI shows banner │
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
  └──────────────────────────────┴──────────────────────────────────────────────┘
```

---

## How it works

Each failure mode has a defined recovery path. The principle: **the canonical data path (prose → SQLite) is never blocked by AI failures.**

1. **No API key** — every service starts with `if (!apiKey) return { error }`. The UI shows "configure your AI key" banner.
2. **Network error** — `fetch` rejects, caller catches, returns `null`. SQLite row stays in pre-AI state. Next event (next save, next user action) gets another shot.
3. **Malformed JSON** — `parseJson` returns `null`. expand retries once; others skip.
4. **Missing required field** — `validate.ts` rejects; the row ignored.
5. **Caption-call fails inside summarize** — caption is wrapped in its own try/catch (`summarize.ts:87`). Failure logs; the structured summary still saves.
6. **User overrode type** — `user_overridden_type` lock; classifier reads and skips.
7. **MAX_CONCURRENT exceeded** — `expand.ts:25` caps at 3 concurrent expansions; over-cap returns `{ok:false, reason:'in-flight-cap'}`.
8. **Heuristic uncertain** — async LLM scheduled; UI shows placeholder type until update.

---

## In this codebase

- `src/services/ai/summarize.ts` → caption try/catch around line 87.
- `src/services/todos/expand.ts:25` → `MAX_CONCURRENT = 3`.
- `src/services/todos/expand.ts:243` → one-retry pattern.
- `src/services/ai/validate.ts` → all schema validators.
- `src/services/ai/config.ts` → key reads + early return on missing.

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

- **Best-effort AI** — gives: user's data never blocked. Costs: AI features may silently not run; user wonders why.
- **Per-failure recovery** — gives: each mode has a specific behaviour. Costs: more code than "throw and bubble."
- **MAX_CONCURRENT cap** — gives: cost ceiling on expand burst. Costs: power user trying to "expand all" hits the cap.

---

## Interview defense

### What an interviewer is really asking
"What happens when AI fails?" tests whether I have a recovery story or just a happy path. The interviewer wants to hear the principle "canonical data is never blocked by AI" backed by code references — `summarize.ts:87` caption try/catch, `expand.ts:25` MAX_CONCURRENT, the one-retry pattern. The candidate who can only describe the success path fails this question.

### Likely questions

[mid] Q: Trace what happens end-to-end when the user has no API key set.
      A: Every AI service starts with `if (!apiKey) return { error: 'no API key' }` — the early return lives in `ai/config.ts` at the key-getter site. The chain never makes a network call. The caller propagates the error or surfaces it via a UI banner pointing to settings. The canonical data path is unaffected: prose still saves to SQLite, todos still parse out, the editor still commits. The user just doesn't get AI annotations until they configure a key. This is the cleanest of all the failure modes because it's a synchronous gate before any side effects.

[senior] Q: Why one retry on malformed JSON in `expand.ts` and zero retries in caption/summarize/classify?
         A: Because expand's expected output is high-information per call (a typed JSON object filling 4-6 required fields like `observed`, `expected`, `suspectedCause`, `reproSteps[]` for 'bug') and the user explicitly fired the expand action. Failing silently after one network call would be a bad UX — the user pressed "expand", saw nothing happen, doesn't know why. The retry with a stricter prompt ("Your previous output was not valid JSON for the schema. Re-emit ONLY a single JSON object…") rescues the borderline cases. Caption, summarize, and classify run automatically — no user intent — and they have other recovery paths (caption skipped means structured summary still saves; summarize surfaces error in `ai_summaries.error`; classify stays at heuristic-or-null). The retry budget tracks user intent, not technical possibility.

[arch] Q: At scale — say 1000 users — how would this failure-mode list change?
       A: Most of it stays the same, but the silent-failure modes become real problems. Today a user with consistently-failing classification sees `type='todo'` on every row and might not notice. At 1000 users I'd need server-side aggregate visibility — a metric for "classification failure rate per provider per model", alarms when it spikes (model upgrade ate the schema), and a per-user diagnostic. I'd also tighten `MAX_CONCURRENT` from a per-user cap to a global cost ceiling, and probably add exponential backoff on 429s. The recovery shapes don't change; the observability and cost-control do.

### The question candidates always dodge
Q: You list eight failure modes, but the table reads like "we log it and move on." What's a failure that would actually make you want a user-visible alarm — and why don't you have one today?

A: Fair — the silent-failure modes are the gap. The one that would justify a real alarm is "classification consistently failing for this user across multiple entries" — meaning either their key is bad, the model upgrade broke the schema, or they're rate-limited. Today the only signal is the `/todos` banner showing in-flight count via `getClassifyInFlight()` which doesn't drop, and dev-mode logs no real user reads. The reason I haven't built it is the cost-benefit at single-user phase A: an alarm system means deciding what counts as "consistently failing" (3 in a row? 10 in 5 minutes?), how to surface it (toast, banner, settings badge?), and how to recover (button to retry? auto-retry?). At one user with sporadic use, the developer (me) is the alarm — I notice when my own todos stop classifying. The day this app has more users, the first observability investment is a per-failure-mode counter and a "AI is degraded" banner with a retry action. Until then, "log and move on" is the honest behaviour.

### One-line anchors
- "Canonical data is never blocked by AI. The worst outcome is 'no annotation this time'."
- "Retry budget tracks user intent. Expand retries; classify doesn't."
- "Silent-failure modes are the visible gap at scale. At one user, the dev is the alarm."
- "Every failure path leaves the canonical SQLite row untouched."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
