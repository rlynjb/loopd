# Partial failure, timeouts, and retries — buffr's response to "the other side is slow"
## Industry name(s): partial failure, timeout discipline, retry with backoff · Type: Foundational

> Every network call has a timeout. Timeouts must be smaller than the next layer up. Retries must be safe to repeat (idempotent). Buffr's two callers — sync engine and chain client — both honor this, with one structural hole: the silent-error guard hides partial-batch failures.

## Zoom out, then zoom in

```
  THREE FAILURE MODES PER CALL

  1. timeout (call took too long)
   → buffr: abort the call; surface to caller
  2. transport error (ECONNRESET, no route)
   → buffr: caught at the client; retried by orchestrator's next tick
  3. application error (HTTP 200 + error body)
   → buffr: returned in result.error
   → ★ silently swallowed by orchestrator's success-only guard ★
```

Zoom in: failure mode 3 is the load-bearing hole. Modes 1 and 2 propagate cleanly to the caller; mode 3 returns as data and the guard at `orchestrator.ts:49,72` drops it.

## Structure pass

```
  layers   ─ call ─ client (timeout) ─ caller (retry) ─ orchestrator (gate)
  axes     ─ failure source (network vs app)
             ─ retry safety (idempotent vs not)
  seams    ─ call ←→ client : timeout
             ─ caller ←→ orchestrator : surfaces result
```

## How it works

### Move 1 — timeouts cascade from outer to inner

```
  user-facing operation: no explicit timeout (sub-second feel)
  chain call:            30s
  HTTP socket:           network library default
  
  RULE: each layer's timeout must be < its caller's tolerance.
```

### Move 2 — retries require idempotency

```
  sync push retries are SAFE because:
   ─ upsert ON CONFLICT is idempotent (composite PK)
   ─ same row pushed twice → same end state
  
  LLM call retries are SAFE because:
   ─ no side effects on the provider side
   ─ result is cached after validation; re-run produces same cache entry
```

### Move 3 — the principle: name what's retryable

```
   ┌──────────────────────────────────────────────────┐
   │ retry without idempotency = double-spend.        │
   │ buffr's sync is idempotent by upsert; its chain  │
   │ calls are idempotent by pure-function semantics. │
   │ both are safe. neither uses exponential backoff  │
   │ today; debounce + next-tick is the only retry.   │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
   the retry path

   sync tick → pushTable(t)
                  │
                  ├─ success counts > 0           → log
                  ├─ failed counts > 0            → log
                  ├─ thrown exception              → log
                  └─ result.error (PGRST301...)   → ★ silent ★
                                                    sync retries on
                                                    next tick by
                                                    dirty filter.
                                                    if RLS deny is
                                                    permanent, sync
                                                    silently churns.
```

## Implementation in codebase

```ts
// sync push retry path is implicit:
// dirty filter selects unsynced rows on EVERY tick.
// failed batches stay dirty; next tick re-tries.
// no explicit backoff; debounce timer is the rate limit.
```

```ts
// chain call timeout (pattern; verify path)
const result = await Promise.race([
  fetch(provider, { body }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('chain timeout')), 30_000)),
]);
```

## Elaborate

The "no exponential backoff" choice is fine at single-user scale — the debounce-driven retry interval is already conservative (5s). At higher scale (many users hitting Anthropic at once on a flaky API run), exponential backoff with jitter would prevent retry-storm convoys. Not yet exercised.

## Interview defense

**Q [mid]:** What does buffr do when Anthropic returns 503?

**A:** The chain throws, the caller (`compose.ts`) catches, the prose-commit skips that derivation, the user can re-trigger later. No automatic retry inside the call; the user's next prose-commit will hit the cache (if the result was eventually cached) or re-call.

**Q [senior]:** What's the load-bearing partial-failure mode you don't handle well?

**A:** Postgres returning `error` as data (PGRST301 RLS deny, PGRST106 schema-missing). The orchestrator's log guard checks success counts but not the error field. The sync silently re-tries every 5s, and the user never knows.

## Validate

### Level 1 — list the three failure modes per call.

### Level 2 — explain why timeouts must cascade outer-to-inner.

### Level 3 — apply: an LLM provider returns 200 + error body. Walk: caller has to inspect the body; not just status.

### Level 4 — defend: "Add exponential backoff to sync retries." Worth it at scale; over-investment today.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — why retries are safe.
- `../study-debugging-observability/01-success-only-log-guard.md` — the silent-error path.
- `../study-ai-engineering/06-production-serving/` — retry + circuit-breaker.
