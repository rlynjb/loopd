# Networking in buffr — HTTPS, three peers, no realtime

Buffr's network surface is small: HTTPS to three external peers (Anthropic, OpenAI, Supabase). No WebSockets. No realtime channels. No edge proxies inside the trust boundary. The native HTTP client (RN's `fetch` over OkHttp on Android) handles TLS, connection pooling, and HTTP/2 by default.

## The network map

```
  ┌──────────────────────────────────────────────────────────┐
  │   buffr (Android)                                          │
  │     │                                                       │
  │     ├─ HTTPS ─► api.anthropic.com    (LLM, primary)        │
  │     ├─ HTTPS ─► api.openai.com       (LLM, fallback + img) │
  │     └─ HTTPS ─► <project>.supabase.co (PostgREST + storage)│
  │                                                             │
  │   no WebSocket; no SSE; no MQTT; no raw TCP.               │
  └──────────────────────────────────────────────────────────┘
```

## Findings (ranked)

| Rank | Finding | Concept | Severity |
|---|---|---|---|
| 1 | All traffic over TLS 1.2/1.3 via native HTTP client | 04-tls | PRAISE |
| 2 | No certificate pinning; relies on platform trust store | 04-tls | LOW (acceptable for buffr's threat model) |
| 3 | No explicit timeout config on `fetch`; uses OS defaults | 07-timeouts-retries-pooling | LOW |
| 4 | No connection pooling control; OkHttp manages | 03-tcp-sockets, 07-pooling | PRAISE (default behavior is right) |
| 5 | No HTTP/2 multiplexing tuning; OkHttp handles | 05-http-semantics | PRAISE |
| 6 | No CORS concern (mobile app, no browser) | 05-cors | N/A |
| 7 | No edge cache, no CDN | 05-caching | LOW (none needed today) |
| 8 | No realtime channel (Supabase Realtime, websocket) | 06-websockets | INTENTIONAL |

## Reading order

`01` (the map) → `02` (DNS) → `03` (transport) → `04` (TLS) → `05` (HTTP semantics) → `06` (realtime) → `07` (timeouts/retries/pooling) → `08` (audit).

## Not yet exercised

- **WebSockets / SSE** — buffr doesn't push from server to client.
- **HTTP caching headers** — every PostgREST response is treated as non-cacheable; reasonable for a write-mostly app.
- **CORS** — not applicable on RN.
- **Proxy / VPN handling** — buffr trusts the OS network stack.
- **mTLS** — no client certs in use.

## Cross-guide seams

- **`study-security`** — trust boundary at each peer; the 0009 RLS incident.
- **`study-system-design`** — where these peers fit in the architecture.
- **`study-distributed-systems`** — what the protocol semantics mean for retries.
- **`study-ai-engineering`** — provider abstraction + rate-limit semantics.
