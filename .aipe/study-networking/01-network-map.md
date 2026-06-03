# The buffr network map — three peers, all HTTPS
## Industry name(s): network topology · Type: Foundational

> Three HTTPS peers. No realtime. No edge proxies. The on-the-wire model is trivially simple.

## Zoom out, then zoom in

```
  buffr ─► HTTPS ─► api.anthropic.com    LLM
  buffr ─► HTTPS ─► api.openai.com       LLM
  buffr ─► HTTPS ─► <proj>.supabase.co   PostgREST + storage
```

Zoom in: every call is a discrete HTTP request. No persistent socket (beyond OkHttp's keep-alive pooling). No session affinity. No proxies between buffr and the peer (modulo carrier-level transparent proxies that buffr can't see).

## Structure pass

```
  layers   ─ app ─ fetch ─ OkHttp ─ TLS ─ TCP ─ network
  axes     ─ persistent vs per-request
             ─ direct vs proxied
  seams    ─ fetch ←→ OkHttp : RN bridge
             ─ OkHttp ←→ peer : TCP + TLS
```

## How it works

### Move 1 — fetch is the only network primitive

```
  buffr's code calls fetch() (or supabase-js / Anthropic SDK).
  no raw sockets. no native networking modules beyond
  the platform's HTTP client.
```

### Move 2 — three peers, three TLS sessions

```
  each peer has its own TCP+TLS state. OkHttp pools connections
  per host, so subsequent calls reuse the same TLS session.
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ buffr's network simplicity is a feature. fewer   │
   │ peers, simpler protocol (HTTP), no realtime.     │
   │ everything that COULD go wrong is well-understood│
   │ at the HTTP layer.                                │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

```ts
// the SDKs and clients
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
// fetch is global from RN
```

## Elaborate

The "three HTTPS peers" pattern is the right minimum. Adding a fourth peer doubles the trust-boundary audit cost and adds one more failure domain. Buffr's choice to use OpenAI only as fallback + multimodal (not as a primary) keeps the peer count meaningfully bounded.

## Interview defense

**Q [mid]:** How many network peers does buffr talk to?

**A:** Three: Anthropic, OpenAI, Supabase. All HTTPS. No realtime.

**Q [senior]:** What's the consequence of HTTPS-only?

**A:** Every peer is reachable from any network buffr is on. No firewall holes. No raw socket fuss. The cost is "no push from server" — sync is poll-based.

## Validate

### Level 1 — sketch the network map.

### Level 2 — explain why fewer peers is better.

### Level 3 — apply: add a fourth peer (e.g., Sentry). Walk the impact.

### Level 4 — defend: "Add realtime." Only if a feature needs it.

## See also

- `04-tls-and-trust-establishment.md`
- `07-timeouts-retries-pooling-and-backpressure.md`
- `../study-security/01-trust-boundaries-and-attack-surface.md`
- `../study-system-design/00-overview.md`
