# Trust boundaries and attack surface

**Industry name(s):** Trust boundary, attack surface, untrusted input
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

Every place untrusted input crosses into trusted code is a trust boundary. The attack surface is the union of all such boundaries. The work of this audit starts by **enumerating** the boundaries — once you can list them, you can ask, of each one, who's allowed past and what happens if they're not.

```
  Zoom out — buffr's attack surface, layer by layer

  ┌─ User ───────────────────────────────────────────┐
  │  the user (Phase A: just rein) types prose       │
  └────────────────────┬─────────────────────────────┘
                       │  trust boundary 1 — input from a (trusted-today) user
                       ▼
  ┌─ UI layer (app/, components) ────────────────────┐
  │  prose stored locally in SQLite as canonical     │
  └────────────────────┬─────────────────────────────┘
                       │  trust boundary 2 — service layer reads prose
                       ▼
  ┌─ Service layer ──────────────────────────────────┐
  │  ai/ chains interpolate prose into LLM prompts    │  ★ surface area
  │  todos/ scanners parse prose                      │
  │  sync/ pushes data to Supabase                    │
  └────────────────────┬─────────────────────────────┘
                       │  trust boundary 3 — network to Anthropic/OpenAI
                       │  trust boundary 4 — network to Supabase Postgres
                       ▼
  ┌─ External providers ─────────────────────────────┐
  │  Anthropic / OpenAI: receive prose; return text   │
  │  Supabase: receives + returns user_id-tagged rows │
  └──────────────────────────────────────────────────┘
```

Phase A's threat model — solo user, fingerprint-locked phone — narrows but doesn't eliminate the surface. The audit names each boundary, the trust assumption it's enforcing, and where that assumption could break.

## Structure pass

The axis is **trust**. Trace it across the boundaries: what's trusted on each side?

```
  axis = "what can each side see, reach, or tamper with?"

  boundary 1: user → UI
    trusted today: rein (single user)
    untrusted in Phase B: any installer

  boundary 2: UI → service
    trusted: passing through validated typed entities
    surface: entry text (the canonical prose) goes through here

  boundary 3: service → Anthropic/OpenAI
    trusted: API key authenticates buffr
    surface: prose interpolated into prompt; output parsed back

  boundary 4: service → Supabase
    trusted: anon key + hardcoded user_id stamps every row
    surface: ★ THE composite-PK + RLS story is here ★
```

Each boundary is a seam where trust changes. The audit's job is to ask, for each one: when the trust assumption holds, what does it buy you? When it fails, what's exposed?

## How it works

### Move 1 — the boundary pattern

```
  the canonical trust-boundary shape

  ┌─ untrusted side ─┐      gate       ┌─ trusted side ─┐
  │                  │ ──── enforces ►  │                │
  │  attacker can     │      one         │  protected     │
  │  send anything    │      trust       │  invariant     │
  │                  │      assumption  │                │
  └──────────────────┘                  └────────────────┘
              ▲                                  ▲
              │  hostile by default              │  every assumption named
              │                                  │  + every gate enumerated
```

Trust is binary at the boundary. Either the gate enforces the assumption (a known mechanism) or it doesn't (a leak). "It's our frontend so it's safe" is not a gate.

### Move 2 — buffr's boundaries, walked

**Boundary 1 — user input as prose.** Today the only user is rein on rein's device; the boundary is barely meaningful. In Phase B (multi-user) every entry's text becomes untrusted input that flows downstream into LLM prompts (concept 07), into scanners (concept 03), into database writes (concept 03).

**Boundary 2 — UI to service layer.** Typed entities cross the boundary (validated by TypeScript). The service layer trusts the shape of what UI hands it. This is a *typing* boundary, not a *security* boundary — TypeScript types are not a security gate.

**Boundary 3 — service to LLM providers.** Buffr sends user prose to Anthropic and OpenAI. The data leaves the device, traverses the public internet, sits on a provider's servers, and the response comes back. The trust assumptions: (a) the API key is valid; (b) the provider acts in good faith; (c) the response shape matches the schema. (a) is enforced by SecureStore; (b) is contractual; (c) is enforced by `validate.ts`.

**Boundary 4 — service to Supabase.** The big boundary. Every synced write crosses it. The schema gate is composite `(user_id, id)` PKs; the runtime gate is RLS (today disabled by 0009; concept 02 walks the full story). The trust assumption: "rows tagged with the correct user_id stay isolated from other users." The schema gate enforces it always. The runtime gate is a defense-in-depth layer that's currently off.

```
  trust boundary 4 — Supabase, with the two gates

  buffr client (anon key + hardcoded user_id)
        │
        ▼  trust assumption: "this row belongs to user_id X"
  ┌─ network ────────────────────────────────────────┐
  │  HTTPS to Supabase (TLS is the transport gate)   │
  └────────────────────┬─────────────────────────────┘
                       ▼
  ┌─ Supabase ───────────────────────────────────────┐
  │  schema gate: composite (user_id, id) PK         │ ◄── ALWAYS ON
  │  runtime gate: RLS (auth.uid() = user_id)        │ ◄── OFF (0009)
  └──────────────────────────────────────────────────┘

  Phase A: schema gate alone is the trust gate. It works for
  cross-user isolation (the row literally doesn't exist for the
  wrong user) but doesn't protect against anyone who KNOWS the
  full composite key.
```

**Implicit boundary — device-loss.** Phase A's biggest trust hole isn't at any explicit boundary — it's the device itself. There's no launch-screen lock, no at-rest encryption beyond OS default. If a borrowed unlocked phone is in someone else's hands, the journal is readable. This is documented as a known Phase A gap; the threat model is "my phone, my fingerprint lock at the OS level" and the audit names it as the assumption rather than fixing it.

### Move 3 — the principle

Trust boundaries are explicit seams between unauthenticated and authenticated code paths, paired with a mechanism that enforces each seam on every crossing. The audit's first move is enumeration — until you can list the boundaries, you can't reason about whether each is held. Buffr's four explicit boundaries plus the implicit device-loss boundary are the full attack surface; every later concept walks one of these in detail.

## Primary diagram

```
  buffr's attack surface — five boundaries, ranked by threat-today

  ALWAYS-ON, ROBUST
   ─ boundary 4 schema gate (composite PK)
     → always-on; doesn't depend on a policy being correct
     → ALWAYS the strongest gate buffr has

  CURRENTLY HELD BY DESIGN
   ─ boundary 3 to LLM providers (TLS + API key + validate.ts)
   ─ boundary 2 UI → service (typed entities + Zod at API boundary)

  KNOWN GAPS (documented)
   ─ boundary 4 runtime gate (RLS): disabled by 0009 — Phase A by design
   ─ implicit boundary 5: device-loss — no launch lock, no SQLCipher

  THREAT-MODEL DEPENDENT
   ─ boundary 1 user prose → service: trusted today (one user, me)
                                     untrusted Phase B (any installer)
```

## Implementation in codebase

### Schema gate — composite (user_id, id) PK

```
  supabase/migrations/0001_initial_schema.sql

  CREATE TABLE entries (
    user_id   TEXT NOT NULL,                ← part of the PK
    id        TEXT NOT NULL,                ← scoped per user
    text      TEXT NOT NULL,
    ...
    PRIMARY KEY (user_id, id)                ← ★ THE ALWAYS-ON GATE ★
  );
       │
       └─ a query for the wrong user's id returns NO ROW — the row
          literally doesn't exist in the index. This is the structural
          gate; it works whether RLS is on or off.
```

### Runtime gate — RLS (currently DISABLED by 0009)

```
  supabase/migrations/0002_rls_policies.sql  (defined; disabled)
  supabase/migrations/0009_disable_rls_phase_a.sql  (rolled back the on-state)

  -- 0002 defines policies AND disables RLS (Phase A by design)
  CREATE POLICY "users access own rows" ON entries
    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  ALTER TABLE entries DISABLE ROW LEVEL SECURITY;
       │
       └─ the policy EXISTS. RLS is OFF. The Phase B migration that
          turns RLS on hasn't shipped yet because auth UI hasn't shipped.
          Concept 02 walks the full story (incident → 0009 rollback).
```

## Elaborate

The trust-boundary framing is the foundation of every threat model — Adam Shostack's *Threat Modeling: Designing for Security* (2014) and Saltzer & Schroeder's classic principles (1975) both start by listing them. The discipline isn't novel; the practice of *enumerating* the boundaries before reasoning about any one of them is.

Buffr's posture is consciously chosen: schema gate as the always-on defense, runtime gate (RLS) as the defense-in-depth layer that's currently off because the auth layer to authenticate against isn't built. The 0009 incident is the empirical proof that you can't have one without the other — concept 02 walks it in detail.

## Interview defense

**Q [mid]:** Walk me through the attack surface in buffr.

**A:** Five boundaries. The schema gate at Supabase (always on; composite PK keeps user data structurally isolated). The TLS/API-key gate at the LLM provider (always on). The typed-entity gate between UI and service (TypeScript boundary; not a security gate — types are not enforcement). The runtime gate at Supabase (RLS; currently off by 0009). And the implicit device-loss gate (no launch lock; documented Phase A gap). The audit walks each one in subsequent concepts.

```
  the five-boundary diagram

  user ─► UI ─► service ─► [Anthropic/OpenAI]
                    │
                    └─► Supabase (schema gate ON; RLS OFF)

  + implicit: the device itself (no launch lock)

  one-line anchor: "enumerate the boundaries, then walk each"
```

**Q [senior]:** What's the strongest gate in buffr's design?

**A:** The composite `(user_id, id)` primary key. It's structural: a query for the wrong user's id doesn't return "exists but you can't see it" — it returns no row, because the row's full key includes a `user_id` the caller didn't reference. It doesn't depend on RLS being on, on a policy being correctly written, or on any runtime check. The PK is the gate that protected user data through the entire window RLS was misconfigured (the 0009 incident).

**Q [arch]:** What changes about buffr's surface in Phase B?

**A:** Boundary 1 flips — user prose is no longer trusted-by-default, because the user could be anyone. This forces three Phase-B additions: real auth (Supabase Auth + JWT), RLS enabled (a new migration that flips ENABLE; the policies are already in 0002), and a one-time backfill that rewrites `user_id` columns from the Phase A UUID to the authenticated user's `auth.uid()`. The schema doesn't change — the composite PK shape is identical between phases.

## Validate

### Level 1 — reconstruct the diagram

Sketch buffr's four explicit + one implicit boundaries.

### Level 2 — explain it out loud

Under 90 seconds: name each boundary, what's trusted on each side, and the gate that enforces the assumption.

### Level 3 — apply to a new scenario

A new feature: buffr should add a "share day" link that emails a day's summary to a friend. Walk the new trust boundaries this introduces.

Open `src/services/sync/client.ts` (the Supabase client setup) and `.aipe/project/context.md` (the documented Phase A posture).

### Level 4 — defend the decision

Defend or oppose: "Schema-gate-only is enough — RLS is overkill for a journal app."

Reference `supabase/migrations/0001_initial_schema.sql` (the composite PK) and the 0009 incident in `supabase/migrations/0009_disable_rls_phase_a.sql`.

## See also

- [`02-authentication-and-authorization.md`](./02-authentication-and-authorization.md) — the runtime gate walk + the 0009 incident.
- [`07-llm-and-agent-security.md`](./07-llm-and-agent-security.md) — boundary 3 in detail.
- [`08-security-red-flags-audit.md`](./08-security-red-flags-audit.md) — the consolidated checklist.
- `.aipe/study-system-design-dsa/01-system-design/02-authentication-boundary.md` — the system-altitude view.
