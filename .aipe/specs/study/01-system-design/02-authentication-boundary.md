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
