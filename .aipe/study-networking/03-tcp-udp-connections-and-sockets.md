# TCP, sockets, and connection lifecycle — what OkHttp does for buffr
## Industry name(s): TCP socket, connection pool, keep-alive · Type: Foundational

> All traffic over TCP. OkHttp (Android's HTTP client) pools connections per host, reuses them across calls, and handles keep-alive. Buffr does not see sockets directly.

## Zoom out, then zoom in

```
  THE LIFECYCLE

  first request to host:
   ─ TCP handshake (RTT 1)
   ─ TLS handshake (RTT 1-2)
   ─ HTTP request/response (RTT 1)

  subsequent requests (within keep-alive window):
   ─ HTTP request/response on the same socket (RTT 1)

  idle timeout (~60s default) → socket closed.
```

Zoom in: the per-host connection pool amortizes the cost of the TLS handshake across many requests. For buffr's chain calls + sync pushes, this matters — a sync cycle that pushes 5 tables benefits from one open connection vs five separate handshakes.

## Structure pass

```
  layers   ─ socket pool ─ socket ─ TCP ─ wire
  axes     ─ pool reuse (per host)
             ─ keep-alive duration
```

## How it works

### Move 1 — OkHttp pools per host

```
  default: 5 idle connections per host kept warm.
  default: 60s idle timeout.
  buffr's traffic pattern hits this well.
```

### Move 2 — TCP is what buffr sees

```
  no UDP (no QUIC unless OkHttp is configured for HTTP/3).
  no raw socket APIs.
  no socket close handling in app code.
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ on RN, sockets are abstracted away. trust the    │
   │ HTTP client's pool defaults; tune only when      │
   │ profiling shows a connection-related bottleneck. │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

None of this is configured by buffr. OkHttp's defaults apply.

## Elaborate

The "trust the HTTP client" pattern is correct for client apps. Server-side, connection pool tuning is real work; client-side, the OS+client library do it right.

## Interview defense

**Q [mid]:** What does buffr do for connection management?

**A:** Nothing explicit. OkHttp pools per-host. Each peer gets reused sockets across calls.

**Q [senior]:** What's the cost of a first request to a new host?

**A:** ~3 RTTs (TCP + TLS handshake + first request). Subsequent: 1 RTT. The pool amortizes this.

## Validate

### Level 1 — explain TCP handshake.

### Level 2 — name keep-alive's role.

### Level 3 — apply: a feature wants low-latency repeated calls. Make sure they hit the same host (already does).

### Level 4 — defend: "Configure connection pool size." Only with evidence.

## See also

- `04-tls-and-trust-establishment.md`
- `05-http-semantics-caching-and-cors.md`
- `07-timeouts-retries-pooling-and-backpressure.md`
