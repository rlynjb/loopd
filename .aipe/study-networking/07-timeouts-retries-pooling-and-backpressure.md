# Timeouts, retries, pooling, and backpressure — what's tuned vs default
## Industry name(s): timeout, retry-with-backoff, connection pool, backpressure · Type: Foundational

> Timeouts mostly rely on OS defaults; one chain-level timeout (~30s) is explicit. Retries are debounce-driven (next sync tick, not exponential backoff). Pooling is OkHttp's default. No backpressure mechanism.

## Zoom out, then zoom in

```
  WHAT'S CONFIGURED                  WHAT'S DEFAULTED

  ─ chain timeout (~30s)             ─ OS socket timeout
  ─ debounce window (5s)             ─ OkHttp connection pool size
                                      ─ HTTP retry policy (SDKs handle)
                                      ─ no app-level rate limit
```

Zoom in: the chain timeout is the only thing buffr's code explicitly sets at the network layer. Everything else is platform defaults.

## Structure pass

```
  layers   ─ call ─ timeout ─ retry ─ pool ─ backpressure
  axes     ─ explicit vs default
             ─ retry safety
```

## How it works

### Move 1 — timeouts cascade

```
  chain timeout (30s)
  > Anthropic SDK's default request timeout (~10 min)
  > OkHttp socket read timeout (~10 min default)
  
  buffr's 30s catches early; lower layers never fire.
```

### Move 2 — retries are debounce-driven

```
  sync push: failed batch stays dirty; next tick re-tries.
  no exponential backoff. acceptable at single-user scale.
```

### Move 3 — the principle: tune the outer timeout

```
   ┌──────────────────────────────────────────────────┐
   │ the outermost (closest to the user) timeout      │
   │ should be the smallest. buffr's 30s on chains    │
   │ is the right shape — beyond that, the user has   │
   │ moved on.                                         │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

```ts
// pattern; chain timeout
const result = await Promise.race([
  callProvider(prompt),
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000)),
]);
```

For sync, the timeout is implicit — the next tick fires regardless of any in-flight request. (Verify: is there an in-flight guard preventing concurrent sync cycles? There should be.)

## Elaborate

The "trust the SDK + add one outer timeout" pattern is correct for a client app. Server-side, fine-grained timeout discipline at every layer matters; client-side, the user's patience is the load-bearing timeout.

## Interview defense

**Q [mid]:** What's the chain timeout?

**A:** ~30s. Set explicitly. Beyond that we abort and surface to caller.

**Q [senior]:** What about retries?

**A:** No explicit retries on chain calls — the user can re-trigger via re-saving. For sync, retries are implicit in the dirty-filter pattern. No exponential backoff today; at scale, worth adding.

## Validate

### Level 1 — explain timeout cascade.

### Level 2 — name the retry mechanism for sync.

### Level 3 — apply: add exponential backoff to sync push.

### Level 4 — defend: "Set socket-level timeouts everywhere." Cost > benefit at this scale.

## See also

- `../study-distributed-systems/02-partial-failure-timeouts-and-retries.md`
- `../study-system-design/02-debounced-batched-sync.md`
- `../study-ai-engineering/06-production-serving/` (retry + circuit breaker)
