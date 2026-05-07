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
