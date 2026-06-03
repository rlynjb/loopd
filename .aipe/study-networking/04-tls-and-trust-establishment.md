# TLS and trust establishment — buffr's encryption story
## Industry name(s): TLS, certificate validation, certificate pinning · Type: Foundational

> All three peers use TLS 1.2 or 1.3. Buffr validates certificates via the Android trust store. No certificate pinning today — reasonable for the threat model. Bearer tokens (Supabase anon key, LLM API keys) are protected by TLS in transit.

## Zoom out, then zoom in

```
  THE TLS HANDSHAKE (simplified)

  1. client hello (cipher suites, SNI)
  2. server hello + certificate chain
  3. client validates chain against trust store
  4. key exchange
  5. ChangeCipherSpec
  6. encrypted application data
```

Zoom in: step 3 is the load-bearing check. Without trust-store validation, an MITM with a forged cert could read every byte. With it, the only attack surface is "trust the trust store" (a CA in the store is compromised).

## Structure pass

```
  layers   ─ TLS session ─ cert chain ─ trust store
  axes     ─ trust source (OS vs pinned)
             ─ validation strictness
```

## How it works

### Move 1 — Android trust store is the root of trust

```
  the platform ships ~150 trusted root CAs.
  any peer cert signed by one of those CAs validates.
  apps can override with NetworkSecurityConfig (XML).
  buffr doesn't override.
```

### Move 2 — no pinning today

```
  certificate pinning ties trust to a specific cert/CA.
  cost: cert rotation requires app updates.
  benefit: defeats malicious-CA attacks.
  buffr's threat model: low-targeted-attack risk; cost > benefit.
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ TLS is the default in 2026. the only question    │
   │ is whether to add pinning. for a journaling app  │
   │ with low-targeted-attack risk, pinning is        │
   │ over-investment. for a banking app, pinning is   │
   │ table stakes.                                    │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

No TLS config in the app. Relies on:

- Android default trust store
- OkHttp's default TLS 1.2/1.3 negotiation
- Each peer's server-side TLS configuration

The relevant secrets in env:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://...
EXPO_PUBLIC_SUPABASE_ANON_KEY=...  # protected by TLS in transit
ANTHROPIC_API_KEY=...               # server only, never in client
```

Cross-link: `study-security/04-secrets-and-configuration.md` covers secret hygiene.

## Elaborate

The "default TLS, no pinning" pattern works because (a) the threat model doesn't include CA compromise, (b) the cost of pinning (cert rotation) is real. The day buffr handles sensitive financial or health data, this calculus changes.

## Interview defense

**Q [mid]:** Where does buffr establish trust?

**A:** Android's trust store. Any peer cert signed by a trusted root validates.

**Q [senior]:** Why no certificate pinning?

**A:** Threat model. Buffr's data is personal but not high-value-target. Pinning adds operational burden (cert rotation) without proportional security benefit. Reassess if the threat model changes.

## Validate

### Level 1 — sketch the handshake.

### Level 2 — explain the trust store's role.

### Level 3 — apply: a feature handles credit cards. Add pinning.

### Level 4 — defend: "Pin all certs immediately." Cost/benefit doesn't justify for this app.

## See also

- `01-network-map.md`
- `../study-security/01-trust-boundaries-and-attack-surface.md`
- `../study-security/04-secrets-and-configuration.md`
