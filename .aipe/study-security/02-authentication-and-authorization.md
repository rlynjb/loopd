# Authentication and authorization

**Industry name(s):** AuthN vs AuthZ, defense in depth, Phase A vs Phase B posture
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

Authentication asks "who are you?" — sessions, tokens, expiry. Authorization asks "what are you allowed to do?" — per-resource policy checks. The classic security gap: authentication is present, authorization is assumed. Buffr's Phase A posture is different — neither runtime gate is on; the only access control is the always-on schema gate.

```
  Zoom out — buffr's auth posture, layered

  ┌─ Client ────────────────────────────────────────┐
  │  buffr app (Phase A: anon key + hardcoded UUID) │
  └────────────────────┬────────────────────────────┘
                       │  ★ NO bearer token; auth.uid() is NULL
                       ▼
  ┌─ Supabase API ──────────────────────────────────┐
  │  RLS DISABLED (0009 — rolled back from on-state) │ ◄── no runtime gate
  │  composite (user_id, id) PK on every synced table │ ◄── ALWAYS-ON schema gate
  └─────────────────────────────────────────────────┘

  authentication today: none (anon-key access)
  authorization today:  structural only (the schema gate)
  runtime gate:         OFF (the policies exist in 0002; 0009 disabled them)
```

This concept walks why that posture is principled today (Phase A by design), what went wrong when RLS drifted on (the 0009 incident), and what flips when Phase B ships.

## Structure pass

The axis is **identity** — who is the caller, and how does the system know?

```
  axis = "who is the caller, and how do we know?"

  Phase A:                              Phase B (planned):
   ─ anon key authenticates the APP      ─ Supabase Auth issues JWT per user
   ─ no per-user identity                ─ auth.uid() returns the real UUID
   ─ user_id stamped from a constant     ─ user_id stamped from auth.uid()
   ─ RLS off (auth.uid() is NULL)        ─ RLS on (policies enforce isolation)
   ─ structural isolation via composite ─ structural + runtime gates
     PK is the entire boundary           (defense in depth)

  the seam: where user_id is sourced flips. The composite-PK shape stays.
```

The structural gate (composite PK) is unchanged across phases. Only the runtime layer flips. That's the architectural win — the schema absorbs the future runtime change without itself changing.

## How it works

### Move 1 — the two-gate pattern

```
  defense-in-depth — two gates with different failure modes

  SELECT * FROM entries WHERE id = $1

  ┌─ schema gate ─────────────────────────────────────────┐
  │  composite PK: (user_id, id) — the row literally       │
  │  doesn't exist for the wrong user                      │
  │  ✓ always on  ✓ doesn't depend on a policy             │
  └────────────────────┬──────────────────────────────────┘
                       │
                       ▼
  ┌─ runtime gate (RLS) ──────────────────────────────────┐
  │  WHERE user_id = auth.uid() (database rewrites query)  │
  │  ✓ catches "client knows the full composite key" case  │
  │  ✗ depends on auth.uid() being correct                 │
  └───────────────────────────────────────────────────────┘
```

Each gate catches what the other misses. The schema gate works without authentication (Phase A); the runtime gate catches credentialed misuse. Together they're defense in depth.

### Move 2 — the Phase A posture + the 0009 incident

**Phase A is a deliberate choice.** Buffr shipped the data layer and sync engine without auth UI to focus on getting the canonical-local + cloud-mirror right. The schema gate was built for Phase B from day 1 (composite PK on every synced table), so Phase B activation is "ship auth UI + flip RLS to ENABLE + one-time backfill" — not a schema rewrite.

```
  why Phase A is acceptable

  threat model:  rein, on rein's phone, fingerprint-locked at OS level
  exposure if anon key leaks:   readable cloud rows (all tagged with one user_id)
  exposure if phone is borrowed: full journal readable (no launch lock)

  these are documented Phase A gaps, not hidden ones.
```

**The 0009 incident.** Migration 0002 defined RLS policies and DISABLED RLS as its final step (Phase A by design). At some point — the Supabase dashboard nags about disabled RLS and offers a one-click enable — RLS got toggled ON. Buffr uses the anon key with no user session, so `auth.uid()` returned NULL, every `auth.uid() = user_id` policy denied every push and pull, and cloud sync silently froze. Reads stayed local-canonical so the app felt normal; the cloud quietly diverged. Migration 0009 re-disabled RLS and codified the Phase A posture into the migration chain so `db-migrate --all-pending` can't leave RLS on.

```
  the 0009 incident — what happened, what we learned

  before:   0002 defines + disables RLS (Phase A)
  drift:    RLS got toggled ON (dashboard one-click; the nag pattern)
            → auth.uid() = NULL (no session, anon key)
            → every policy denied every push/pull
            → cloud sync silently froze (reads still local; app felt fine)
  after:    0009 re-disables RLS via a migration in the source-controlled chain
            → "Phase A posture" is now a committed file, not a runtime state

  lesson:   security posture belongs in version-controlled migrations,
            not a dashboard toggle. RLS without auth fails CLOSED and SILENT.
```

**Phase B is conditional.** When real users land, Phase B activates: ship Supabase Auth (`signInWithPassword` or similar), drop the hardcoded `PHASE_A_USER_ID`, ship a new migration that flips RLS to `ENABLE`, run a one-time backfill that rewrites every Phase-A row's `user_id` to the authenticated UUID. The schema doesn't change.

### Move 3 — the principle

Two independent gates with different failure modes — schema and runtime — catch what the other misses, and a deliberately disabled runtime gate is principled when the auth layer it depends on hasn't shipped yet. The 0009 incident is the empirical proof: RLS without auth doesn't half-work; it fails closed and silent.

## Primary diagram

```
  buffr's auth posture, Phase A → Phase B side by side

           Phase A (current)                Phase B (planned)
  ┌──────────────────────────────┐   ┌──────────────────────────────┐
  │ user_id = PHASE_A_USER_ID    │   │ user_id = auth.uid()         │ ◀ source flips
  │   (hardcoded in client.ts)    │   │   (from JWT, real user)      │
  │           ▼                   │   │           ▼                  │
  │ schema gate (composite PK) ✓ │   │ schema gate (composite PK) ✓ │   unchanged
  │           ▼                   │   │           ▼                  │
  │ RLS defined, DISABLED        │   │ RLS ENABLED, ENFORCED ✓       │ ◀ activated
  │   (0002 + 0009 re-disable)   │   │   (new migration flips ON)    │
  │           ▼                   │   │           ▼                  │
  │ row returns                   │   │ row returns                  │
  └──────────────────────────────┘   └──────────────────────────────┘
    schema gate identical across both phases — only runtime layer changes
```

## Implementation in codebase

### The schema gate — always on

```
  supabase/migrations/0001_initial_schema.sql  (every synced table)

  CREATE TABLE entries (
    user_id  TEXT NOT NULL,
    id       TEXT NOT NULL,
    ...
    PRIMARY KEY (user_id, id)               ← the structural gate
  );
       │
       └─ a query for the wrong user's id doesn't return "denied" —
          it returns no row. The row literally doesn't exist for the
          wrong key combination. Holds whether RLS is on or off.
```

### The runtime gate — defined + disabled + re-disabled

```
  supabase/migrations/0009_disable_rls_phase_a.sql  (the codified posture)

  -- Rollback RLS to the Phase A posture (2026-05-13).
  -- ... auth.uid() returns NULL for every sync request, so the
  -- auth.uid() = user_id policies from 0002 deny every push and pull.
  -- Cloud sync silently freezes; local SQLite stays canonical and the app
  -- feels normal, but cloud diverges. ...

  ALTER TABLE entries         DISABLE ROW LEVEL SECURITY;
  -- ... all 10 synced tables ...
       │
       └─ committed file. Future `db-migrate --all-pending` can't
          leave RLS on, because this migration explicitly disables it.
          The Phase B re-enable will be a NEW migration shipped with
          the auth UI.
```

## Elaborate

The defense-in-depth framing has 50+ years of precedent (Saltzer & Schroeder's *The Protection of Information in Computer Systems*, 1975 — "complete mediation" + "fail-safe defaults"). The modern Supabase-specific lesson is sharper: **dashboard toggles are not security posture**. Anything that can be flipped outside source control is unbounded. The 0009 fix isn't just re-disabling RLS; it's *codifying the posture into the chain*, so the running system matches the source.

For the full system-altitude treatment of this trust boundary — the architectural decisions, the Phase A/B split, the why-it-works — read `.aipe/study-system-design-dsa/01-system-design/02-authentication-boundary.md`. This file is the security audit's view; that file is the architecture.

## Interview defense

**Q [mid]:** Why two gates instead of just RLS?

**A:** Different failure modes. RLS is a policy — it depends on `auth.uid()` returning the right value, on the policy `USING` clause being written correctly, on RLS staying enabled. Any of those can go wrong (the 0009 incident is the proof: RLS got toggled on, `auth.uid()` was NULL, every policy denied every query, silent freeze). The composite-PK schema gate doesn't depend on any policy being right — the row literally doesn't exist for the wrong user. Two independent gates with different failure modes is the textbook defense-in-depth move.

```
  defense in depth — same query, two gates

  query     SELECT * FROM entries WHERE id = $1
              │
              ▼  schema gate: (user_id, id) PK lookup
              │  ✓ row doesn't exist for wrong user
              │  ✓ doesn't depend on a policy
              ▼  runtime gate: WHERE user_id = auth.uid()
                 ✓ catches authenticated misuse
                 ✗ requires auth to work

  one-line anchor: "the gate that doesn't depend on a policy being right"
```

**Q [senior]:** Why ship Phase A with RLS off if the policies are written?

**A:** Because RLS without auth doesn't half-work — it fails closed and silent. With no Supabase Auth wired in, `auth.uid()` is NULL on every request; the policies' `USING (auth.uid() = user_id)` clauses then deny every row. Cloud sync silently freezes. We learned this empirically (the 0009 incident): RLS got enabled via a dashboard nag, sync froze, took an endpoint curl to find. The fix shipped in 0009 codifies the Phase A posture in the migration chain so it can't drift back on without an explicit migration.

**Q [arch]:** Walk Phase B activation.

**A:** Five steps in order. (1) Ship Supabase Auth UI (signInWithPassword, signup). (2) Drop the `PHASE_A_USER_ID` constant in `client.ts`; read user from session. (3) Run a one-time backfill that rewrites every Phase-A row's `user_id` to the authenticated user's UUID. (4) Ship a new migration that flips RLS to `ENABLE` on every synced table (0002's policies are already applied). (5) Verify `auth.uid()` is non-NULL on push/pull before flipping the runtime gate — order matters; doing (4) before (3) reproduces the 0009 silent freeze.

## Validate

### Level 1 — reconstruct the diagram

Sketch the Phase A vs Phase B comparison with the schema gate unchanged and the runtime gate flipping.

### Level 2 — explain it out loud

Under 90 seconds: explain the 0009 incident and the lesson "RLS without auth fails closed and silent." Use the phrase "dashboard toggles are not security posture."

### Level 3 — apply to a new scenario

A new contributor proposes enabling RLS now "for safety, before Phase B ships." Walk them through why this is the 0009 incident in waiting.

Open `supabase/migrations/0009_disable_rls_phase_a.sql` (the committed posture) and `src/services/sync/client.ts` (the anon-key config; `persistSession: false`).

### Level 4 — defend the decision

Defend or oppose: "Buffr should keep RLS off forever and rely on the composite PK as the only access gate."

Reference `supabase/migrations/0002_rls_policies.sql` (the defined policies) and the Phase B activation walk above.

## See also

- [`01-trust-boundaries-and-attack-surface.md`](./01-trust-boundaries-and-attack-surface.md) — the boundary this concept enforces.
- [`08-security-red-flags-audit.md`](./08-security-red-flags-audit.md) — the consolidated checklist.
- `.aipe/study-system-design-dsa/01-system-design/02-authentication-boundary.md` — the architectural view (Phase A/B in full, the deeper background, the per-row mechanics).
