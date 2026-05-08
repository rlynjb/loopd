# Authentication boundary

> Phase A has no end-user authentication — every cloud row is tagged with a single hardcoded `user_id`. RLS is *scaffolded* (migration 0002) but disabled.

**See also:** → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [13-append-only-migrations](./13-append-only-migrations.md)

---

## Quick summary
- **What:** every Supabase write/read goes through a single hardcoded `PHASE_A_USER_ID` UUID. RLS policies exist as a migration but are not enabled.
- **Why here:** solo product, single user; building features over the auth wire-up.
- **Tradeoff:** until Phase B ships auth, anyone with the Supabase anon key + URL can read the data. Mitigation: keys live in SecureStore; the app has no public surface.

---

## Authentication boundary — diagram

```
  ┌── Phase A (current) ─────────────────────────────────┐    ┌── Phase B (planned) ─┐
  │                                                      │    │                      │
  │   App                                                │    │   App                │
  │    │                                                 │    │    │                 │
  │    │  every cloud write/read includes a hardcoded    │    │    │  Supabase auth   │
  │    │  PHASE_A_USER_ID (UUID in client.ts)            │    │    │  → access token  │
  │    ▼                                                 │    │    ▼                 │
  │   Supabase                                           │    │   RLS on every       │
  │    │                                                 │    │   row: user_id =     │
  │    │  RLS scaffolded but DISABLED                    │    │   auth.uid()         │
  │    │  composite (user_id, id) PKs ARE the schema     │    │                      │
  │    │  gate against cross-user reads                  │    │   Schema gate stays  │
  │    ▼                                                 │    │   the same           │
  │   Postgres                                           │    │                      │
  └──────────────────────────────────────────────────────┘    └──────────────────────┘
```

---

## How it works

Two layers of isolation, only one of which is active in Phase A.

The **schema gate** is composite primary keys: every synced table has `PRIMARY KEY (user_id, id)`. If the client ever asks for someone else's `id`, the row literally doesn't exist for them. This is enforced regardless of authentication state.

The **runtime gate** is RLS. Migration `0002_rls_policies.sql` defines policies that filter every query to `user_id = auth.uid()`. In Phase A this migration is in the file system but the policies are not installed; the user_id is hardcoded client-side.

Phase B activates the runtime gate: ship Supabase auth, drop the hardcoded id, enable RLS. The schema gate doesn't change because it was already correct.

---

## In this codebase

- `src/services/sync/client.ts` — holds `PHASE_A_USER_ID`. Every push and pull stamps it.
- `supabase/migrations/0002_rls_policies.sql` — the disabled-but-ready RLS scaffold.
- `supabase/migrations/0001_initial_schema.sql` — composite PKs on every synced table.

---

## Elaborate

### Where this pattern comes from
RLS comes from Postgres' security model where the row itself decides who can read it. Supabase popularised the pattern by pairing it with `auth.uid()` so the client only ever sees its own rows even when it asks for "everything."

### The deeper principle
**Defense in depth: schema-level gates and runtime gates are different mitigations.** The schema gate (composite PKs) prevents accidental cross-user reads even with bad code. The runtime gate (RLS) prevents intentional cross-user reads even with stolen credentials. You want both.

### Where this breaks down
- A leaked anon key in Phase A is functionally a leaked password — there's no second factor.
- Composite PKs alone don't protect against anyone who *knows* another user's id; RLS is what closes that hole.

### What to explore next
- Supabase RLS policy documentation → for when migration 0002 is enabled.
- [Append-only Postgres migrations](./13-append-only-migrations.md) → how the auth migration was staged for Phase B without disrupting Phase A.

---

## Tradeoffs

- **Hardcoded user_id (Phase A)** — gives: zero auth UI to build now. Costs: anon-key access reads everything. Mitigation: SecureStore + no public surface.
- **Composite (user_id, id) PKs** — gives: schema-level isolation that works today and after RLS ships. Costs: every query needs the user_id; client code is verbose.
- **RLS scaffolded but disabled** — gives: easy switch-on path. Costs: a Phase B upgrade that forgets to enable it would silently break the runtime gate.

---

## Interview defense

### What an interviewer is really asking
"Phase A has no auth" is the sentence that makes interviewers either move on or pounce. The interviewer wants to know whether you understand that "no auth" is a deliberate decision with named consequences — not a thing you forgot. The probe is: do you know what you're exposed to right now, and do you have a credible plan for closing it?

### Likely questions

[mid] Q: What's the difference between the schema gate and the runtime gate, and which one is active in Phase A?

A: The schema gate is the composite `(user_id, id)` primary key on every synced Supabase table — if a row doesn't include the user's id, that row literally doesn't exist for them. The runtime gate is RLS, defined in `supabase/migrations/0002_rls_policies.sql` but not currently enabled. Phase A only has the schema gate; the runtime gate is staged for Phase B. Both exist because they catch different threats — bad code (schema) versus stolen credentials (RLS).

[senior] Q: Why ship without RLS at all? You wrote the policies — why not turn them on?

A: Because turning on RLS means I also need real Supabase auth — there's no `auth.uid()` to evaluate without a logged-in user. Phase A is single-user-by-design; I hardcoded a UUID in `client.ts` so I could ship the data layer and the sync engine without solving auth UI first. The RLS migration is in tree precisely so Phase B can enable it without rewriting the sync layer. The cost I accepted is that the Supabase anon key is functionally a password — anyone holding it can read everything. Mitigation: the keys live in Android Keystore via `expo-secure-store`, and the app has no public API surface.

[arch] Q: Walk me through the migration from Phase A to Phase B at scale. What stays, what changes?

A: The schema doesn't change — composite PKs were always correct. The migration is: ship Supabase auth UI, replace `PHASE_A_USER_ID` reads with the authenticated user's UUID, run a one-time backfill that rewrites every existing row's `user_id` to that authenticated UUID, then enable migration `0002` to turn on RLS. The sync layer and every CRUD path stay identical. The risk is the backfill — if a user already has data on multiple devices each tagged with the same hardcoded UUID, deduplication is required first.

### The question candidates always dodge
Q: You're shipping a journaling app with no end-user auth and you're calling that acceptable. What about a user who installs your APK on a borrowed phone, writes for a week, then loses the phone — everything they wrote is now on a stranger's device with no password. Defend that.

A: Honestly, the device-loss case isn't covered. The app has no PIN, no biometric gate on launch, no encryption on `loopd.db` beyond what Android offers at the OS level. If the borrowed phone is unlocked, the journal is readable. I accepted that because Phase A's target user is me — solo developer using my own device — and adding a launch-screen lock would be three days of work that nobody is asking for yet. The honest mitigation is "it's on my phone, my phone has a fingerprint lock." The day I onboard a non-me user, the launch-screen lock and at-rest encryption are blockers; I won't pretend they're optional. The schema gate doesn't help here because the threat isn't cross-user reads — it's a stranger reading the only user's data.

### One-line anchors
- "Phase A is auth-deferred, not auth-forgotten — the migration is a single client.ts line and a migration toggle."
- "Composite `(user_id, id)` PKs were the choice that paid back: same schema works in Phase A and Phase B."
- "RLS without auth is meaningless — `auth.uid()` needs a logged-in user. The migration is staged for the day there is one."
- "The threat model in Phase A is device-loss, not cross-user — and device-loss is currently uncovered. I know that."

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
