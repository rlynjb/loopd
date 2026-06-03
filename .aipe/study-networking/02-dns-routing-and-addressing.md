# DNS, routing, and addressing — what's at each hostname
## Industry name(s): DNS, name resolution, anycast · Type: Foundational

> Three hostnames, three DNS lookups (cached per-process). All resolve to globally-anycast IPs (AWS, Cloudflare, GCP variants). Buffr doesn't do anything special — relies on OS DNS resolver.

## Zoom out, then zoom in

```
  api.anthropic.com       → AWS CloudFront (or similar)
  api.openai.com          → AWS / Azure edge
  <proj>.supabase.co      → Cloudflare → AWS us-east (default)
```

Zoom in: buffr never hardcodes IPs, never does its own DNS, never bypasses the OS resolver. The DNS lookup is cached at the OS level for the TTL the resolver respects.

## Structure pass

```
  layers   ─ hostname ─ OS resolver ─ IP ─ TCP
  axes     ─ resolution latency (cached vs cold)
             ─ routing (anycast vs unicast)
```

## How it works

### Move 1 — DNS is cached

```
  first call to a hostname: DNS lookup (5-50ms typical).
  subsequent: cached at OS level (TTL dependent).
  buffr sees no DNS work after the first call per host.
```

### Move 2 — anycast distributes requests

```
  the same hostname resolves to the geographically nearest edge.
  buffr from Manila hits Asia-region edges; from US hits US edges.
  buffr's code is unaware.
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ on mobile, DNS happens at the OS level. apps     │
   │ rarely need to think about it. the failure mode  │
   │ to know is captive-portal DNS hijack — a network │
   │ that returns wrong IPs. TLS catches this; the    │
   │ certificate doesn't match.                       │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

No DNS configuration anywhere in buffr. The hostnames are in:

```ts
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
// e.g., https://<project-ref>.supabase.co
```

## Elaborate

The "rely on OS DNS" pattern is correct for mobile apps. The only sophistication worth investing in: certificate pinning (not done; reasonable for buffr's threat model) and IP-based health checks (not relevant; CDNs handle this).

## Interview defense

**Q [mid]:** Where does DNS resolution happen?

**A:** OS resolver. Cached at the OS level. App never sees it.

**Q [senior]:** What's the worst DNS failure?

**A:** Captive portal returning fake IPs. TLS certificate mismatch surfaces the attack; buffr's connections fail rather than succeed-to-attacker.

## Validate

### Level 1 — name the resolver layer.

### Level 2 — explain why TLS catches DNS hijack.

### Level 3 — apply: a feature requires a specific region. Use a region-pinned hostname.

### Level 4 — defend: "Pin DNS in the app." Wrong; cuts off OS-level caching, breaks captive portals.

## See also

- `04-tls-and-trust-establishment.md`
- `../study-security/01-trust-boundaries-and-attack-surface.md`
