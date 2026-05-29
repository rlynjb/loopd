# Authentication boundary

**Industry name(s):** Authentication middleware, security boundary
**Type:** Industry standard · Language-agnostic

> Phase A has no end-user authentication — every cloud row is tagged with a single hardcoded `user_id`. RLS policies are *defined* (migration 0002) but enforcement is off: 0002 disabled RLS by design, and migration 0009 re-disabled it after it drifted on and silently froze cloud sync (`auth.uid()` is NULL under the anon key, so every policy denied every push and pull).

**See also:** → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [13-append-only-migrations](./13-append-only-migrations.md)

---

## Why care

You're writing a query against a `users`-scoped table — `SELECT * FROM entries WHERE user_id = $1 AND id = $2`. The `WHERE id = $2` clause picks the row; the `WHERE user_id = $1` clause scopes it to the caller. If you only had the first, a client passing someone else's id gets back another user's row. If you only had the second, the query returns *every* row the caller owns instead of the one they asked for. Either clause alone is correct for what it does and wrong for what it leaves uncovered; together, the database returns at most one row, and it's the right one.

The question those two clauses answer is the same one any multi-user data store has to answer: where does the trusted zone end, and what mechanism enforces the seam at every crossing? Not "do we have auth" — that's a yes-or-no with no architecture in it. The interesting answer is *defense in depth*: two independent gates with different failure modes, layered so one gate's bug doesn't compromise the other.

**What depends on getting this right:** whether one user's journal becomes readable by anyone holding a copy of the anon key, and whether the cost of activating real auth later is "a one-line config swap" or "rewrite the schema." In this codebase the schema gate is composite `PRIMARY KEY (user_id, id)` on every synced Supabase table — even with bad code, a query for the wrong user's `id` returns no rows because the row's full key includes a `user_id` the caller doesn't know. The runtime gate is RLS, defined in `supabase/migrations/0002_rls_policies.sql` but disabled in Phase A; Phase A uses a hardcoded `PHASE_A_USER_ID` UUID in `src/services/sync/client.ts`. The schema was built to accept the runtime gate later without a schema change — because the composite PK was correct from day one, Phase B activation is `auth.uid()` replacing the hardcoded UUID plus a new migration that flips RLS to `ENABLE` (0002's policies are already in tree), not a schema rewrite.

Without two gates (only RLS, schema didn't anticipate multi-tenant):
- A future PR disables RLS by accident
- Every user's cloud rows become readable by every other user's client
- The bug is "policy regression," recovery is "restore from backup + audit"

With two gates (composite PK + staged RLS):
- A future PR disables RLS by accident
- Queries still return no rows because the row's full composite key isn't visible to the wrong caller
- The bug is "RLS off," recovery is "re-enable the policy"

The composite PK is the structural gate; RLS is the runtime gate. Same shape as the two `WHERE` clauses up top — defense in depth, two independent mechanisms, the row stays invisible even when one mechanism fails.

---

## How it works

Two `WHERE` clauses on the same query, both required, evaluated by different mechanisms. The composite PK (`(user_id, id)`) is the structural gate — it doesn't ask who you are; it just makes the row appear to not exist if your scope doesn't include it. RLS (`auth.uid() = user_id`) is the runtime gate — it consults the JWT, evaluates a policy, and rejects unauthorised reads. Today only the structural gate is active in buffr; the runtime gate is scaffolded (migration 0002) but disabled in Phase A. Two independent mechanisms, layered — either one alone would still narrow the rows correctly under perfect conditions, and together they survive imperfect ones.

The mental model in one picture:

```
   Query: SELECT * FROM entries WHERE user_id = $1 AND id = $2

   ┌────────────────────────────┐
   │  WHERE user_id = $1        │  ◄── gate 1: composite-PK schema
   │   (composite PK lookup)    │     active in Phase A
   └─────────────┬──────────────┘     (row doesn't exist for wrong user_id)
                 │
                 │  rows narrowed to caller's namespace
                 ▼
   ┌────────────────────────────┐
   │  WHERE auth.uid() = user_id│  ◄── gate 2: RLS runtime
   │   (RLS policy filter)      │     STAGED, OFF in Phase A
   └─────────────┬──────────────┘     (postgres adds it automatically in Phase B)
                 ▼
            row returned
```

Either clause alone narrows the result correctly under normal conditions; together they survive a bug in either layer. The three sub-sections below trace each gate in turn, then the Phase A / Phase B split.

### The schema gate — composite primary keys

Every synced table in Supabase has `PRIMARY KEY (user_id, id)`. That's two columns participating in the primary key, not one — it's called a *composite primary key*. If you're coming from frontend, you're used to thinking of an `id` as globally unique (like a React key in a map). Here it's different: an `id` only means something *inside* a particular user's namespace. The compound key is `(user_id, id)`; the same `id` can exist for two different users and they refer to different rows. Concrete consequence: if user A's client sends a query for `id = 'abc123'` belonging to user B, the database looks for `(user_A_id, 'abc123')` and that row literally does not exist — not "exists but you can't see it"; it does not exist. The data is invisible at the structural level, not at the policy level. Boundary: this works whether the user is authenticated or not, whether RLS is on or off, whether the client lies about who it is — the rows are isolated at the schema. The only thing that breaks it is a client that knows the *full composite key* (both user_id and id), which the runtime gate's job is to prevent.

The composite-key shape, with two users having the same `id`:

```
entries
┌──────────────┬───────────┬────────────────┬───────────┐
│ user_id      │ id        │ text           │ ...       │
├──────────────┼───────────┼────────────────┼───────────┤
│ alice-uuid   │ 'abc123'  │ 'call mom'      │ ...       │
│ alice-uuid   │ 'xyz789'  │ 'write spec'    │ ...       │
│ bob-uuid     │ 'abc123'  │ 'ship v2'       │ ...       │ ◄── same id,
└──────────────┴───────────┴────────────────┴───────────┘     different row
              └──────┬───────┘
       PRIMARY KEY (user_id, id) — the pair is what's unique
```

Two rows can share the `id` `'abc123'` because the primary key is the *pair*, not the `id` alone. Alice's client asking for `'abc123'` finds her row; Bob's client asking for the same string finds his. Neither can see the other's row because the lookup is keyed on `(user_id, 'abc123')` and the cross-user pair simply doesn't exist in the index.

### The runtime gate — Row-Level Security

Migration `supabase/migrations/0002_rls_policies.sql` defines RLS policies that filter every query to `WHERE user_id = auth.uid()`. Postgres applies these policies automatically — the client doesn't add the filter, the database does. If you're coming from frontend, this is like a backend middleware that injects an `if (user.id !== resource.userId) return 403;` check before every read and write — except it's at the database layer, not in application code, so even raw SQL access is bound by it. Concrete consequence: if user A is authenticated and runs `SELECT * FROM entries`, Postgres rewrites the query to `SELECT * FROM entries WHERE user_id = 'user-A-uuid'`. There's no way to forget the filter; the filter is *part of the table* from the policy's perspective. Boundary: RLS only works once `auth.uid()` returns the right value — that requires Supabase auth to be configured and a JWT in the request headers. Without auth, `auth.uid()` is NULL and the policy filters everything to zero rows.

What the client sends vs what the database actually runs:

```
       client query                       what postgres executes
   ┌────────────────────────┐         ┌──────────────────────────────┐
   │ SELECT * FROM entries  │  ──▶    │ SELECT * FROM entries        │
   │                        │  RLS    │ WHERE user_id = auth.uid()   │  ◄── added by
   │                        │  on     │                              │     policy
   └────────────────────────┘         └──────────────────────────────┘
```

The client doesn't know the filter is there. The policy is on the table, not in application code, so any query path — raw SQL, the Supabase client SDK, even a service-role admin tool — passes through the same gate.

### Phase A / Phase B — current state vs planned

- **Phase A (current):** schema gate active, runtime gate dormant. `auth/client.ts` carries a single hardcoded `PHASE_A_USER_ID` UUID; every Supabase call inserts that value into the `user_id` column on writes and reads. RLS policies are *defined and applied* by `0002_rls_policies.sql`, but that migration's final block disables RLS on every table (Phase A by design). RLS later drifted *on* — the Supabase dashboard flags disabled-RLS tables and offers a one-click enable — and silently froze cloud sync, because `auth.uid()` is NULL under the anon key so the policies denied every push and pull; migration `0009_disable_rls_phase_a.sql` re-disabled RLS to restore Phase A. The cloud database treats the hardcoded id as the sole user.
- **Phase B (planned):** schema gate unchanged, runtime gate activated. Ship Supabase auth (`signInWithPassword` or similar), drop the hardcoded id, and ship a new migration that flips RLS to `ENABLE` on every table (0002's policies are already in tree). Every client request now carries a JWT; `auth.uid()` returns the authenticated user's id; the schema gate still appears identical from the outside.

Side by side, the structural columns don't change — only the source of `user_id` and the activation state of RLS:

```
            Phase A (now)                       Phase B (later)
   ┌──────────────────────────────┐    ┌──────────────────────────────┐
   │ user_id = PHASE_A_USER_ID    │    │ user_id = auth.uid()         │ ◀ source flips
   │   (hardcoded in client.ts)   │    │   (from JWT, real user)      │
   │           ▼                  │    │           ▼                  │
   │ schema gate (composite PK) ✓ │    │ schema gate (composite PK) ✓ │   unchanged
   │           ▼                  │    │           ▼                  │
   │ RLS defined, DISABLED        │    │ RLS ENABLED, ENFORCED ✓       │ ◀ activated
   │           ▼                  │    │           ▼                  │      (new!)
   │ row returns                  │    │ row returns                  │
   └──────────────────────────────┘    └──────────────────────────────┘
     schema gate identical across both phases — only the runtime layer changes
```

The point of Phase A/B here is that the **schema didn't have to change between phases**. The composite-PK shape was correct from day one; only the runtime layer (RLS, JWT auth) gets added. If you've watched a team retrofit multi-tenancy onto a single-tenant schema, you know how expensive that is — column renames, FK rewrites, data migrations. The architecture absorbed the future activation cost as a one-time `ALTER TABLE` plus an auth flow, not a re-architecture.

### Defense in depth — why both gates

If RLS is enough, why have the schema gate? Because RLS is a *policy*, not a *structural property*. Policies can have bugs (a misconfigured `USING` clause that returns rows it shouldn't), can be disabled accidentally (a future migration that forgets `ENABLE ROW LEVEL SECURITY`), can be bypassed by service-role keys. The schema gate doesn't depend on any of that — it depends on the relational model itself. If you're coming from frontend, this is the same shape as input sanitization plus output escaping: each layer is enough on its own under perfect conditions, and both together survive imperfect conditions. Concrete consequence: if a future PR mistakenly disables RLS, the user data isn't suddenly exposed — the composite key still makes the rows structurally invisible. The blast radius of "someone misconfigured RLS" stays bounded.

Walking the failure modes side by side makes the redundancy concrete:

```
   failure scenario              schema gate only      RLS only           both layers
   ─────────────────────────     ──────────────────    ────────────────   ─────────────
   PR disables RLS               ✓  rows hidden        ✗  rows exposed    ✓  schema still
                                    by composite PK       to wrong user      hides them
   USING clause bug              ✓  composite PK        ✗  may return       ✓  composite PK
   (policy returns wrong rows)      independent           wrong rows           catches it
   service-role key leaks        ✗  if attacker         ✗  service role     ✗  both layers
                                    knows composite       bypasses RLS         bypassed —
                                    key                                        not covered
   client lies about user_id     ✓  wrong (user_id,id)  ✓  policy filter    ✓  doubly blocked
                                    pair doesn't exist    catches it
```

The schema gate covers what RLS bugs miss; RLS covers what an attacker would need the schema gate to fail to exploit. Both layers together leave one realistic gap — a leaked service-role key, which is the threat any layered defense at this scale shares.

This is what defense in depth looks like in a real system — two independent mechanisms with different failure modes, layered so that one mechanism's bug doesn't compromise the other. People say "defense in depth" all the time; the rare version is shipping it on a system where both layers are real, both layers are testable, and both layers stay correct under future change. The full picture is below.

---

## Authentication boundary — diagram

```
┌─ App layer (client) ────────────────────────────────────────────────────────────────┐
│                                                                                     │
│  ┌── Phase A (current) ─────────────────────┐    ┌── Phase B (planned) ──────────┐  │
│  │   App                                    │    │   App                         │  │
│  │    │                                     │    │    │                          │  │
│  │    │  every cloud write/read includes a  │    │    │  Supabase auth           │  │
│  │    │  hardcoded PHASE_A_USER_ID          │    │    │  → access token          │  │
│  │    │  (UUID in client.ts)                │    │    │                          │  │
│  └────┼─────────────────────────────────────┘    └────┼──────────────────────────┘  │
└───────┼─────────────────────────────────────────────── ┼──────────────────────────── ┘
        ▼                                                ▼
┌─ Network / auth boundary ───────────────────────────────────────────────────────────┐
│   Supabase API                                                                      │
│    │                                                                                │
│    │  Phase A: anon key, no auth.uid()                                              │
│    │  Phase B: bearer token, auth.uid() populated                                   │
└────┼────────────────────────────────────────────────────────────────────────────────┘
     ▼
┌─ Storage layer (Postgres) ──────────────────────────────────────────────────────────┐
│                                                                                     │
│   Phase A:                              Phase B:                                    │
│    RLS scaffolded but DISABLED           RLS on every row:                          │
│    composite (user_id, id) PKs ARE       user_id = auth.uid()                       │
│    the schema gate against                                                          │
│    cross-user reads                      Schema gate stays the same                 │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Hardcoded id:**         `src/services/sync/client.ts` — holds `PHASE_A_USER_ID` (UUID). Every push and pull mapper stamps it; replacing it with `auth.uid()` is the Phase B switch.
**Schema gate:**          `supabase/migrations/0001_initial_schema.sql` — declares composite `(user_id, id)` PKs on every synced table. The schema-level isolation that holds today and after RLS ships.
**Runtime gate (off):**   `supabase/migrations/0002_rls_policies.sql` — creates the per-table policies and disables RLS (Phase A by design; the `ENABLE` is the last block, deferred to Phase B).
**RLS re-disable:**       `supabase/migrations/0009_disable_rls_phase_a.sql` — after RLS drifted on (Supabase dashboard one-click enable) and silently froze cloud sync (`auth.uid()` NULL under the anon key denied every push/pull), 0009 re-disabled RLS to restore Phase A. Policies stay defined; enforcement is off until a Phase B migration flips `ENABLE`.
**Postgres namespace:**   `supabase/migrations/0010_namespace_to_buffr_schema.sql` — moved all 10 synced tables and the `get_server_time()` RPC from `public` into a dedicated `buffr` schema; the JS client sets `db: { schema: 'buffr' }` so every `.from()` call resolves there. The composite-PK gate and the staged RLS policies followed the tables to the new schema automatically (Postgres tracks them by OID), so the auth posture didn't change — only the namespace did.

---

## Elaborate

### Where this pattern comes from
RLS comes from Postgres' security model where the row itself decides who can read it. Supabase popularised the pattern by pairing it with `auth.uid()` so the client only ever sees its own rows even when it asks for "everything."

### The deeper principle
**Defense in depth: schema-level gates and runtime gates are different mitigations.** The schema gate (composite PKs) prevents accidental cross-user reads even with bad code. The runtime gate (RLS) prevents intentional cross-user reads even with stolen credentials. You want both.

### Where this breaks down
- A leaked anon key in Phase A is functionally a leaked password — there's no second factor.
- Composite PKs alone don't protect against anyone who *knows* another user's id; RLS is what closes that hole.
- Enabling RLS *before* real auth exists fails closed and silent: `auth.uid()` is NULL under the anon key, so every policy denies every query and cloud sync freezes with no error. This happened once; migration `0009` rolled it back. RLS and auth have to ship together — half of the pair is worse than neither.

### What to explore next
- Supabase RLS policy documentation → for when migration 0002 is enabled.
- [Append-only Postgres migrations](./13-append-only-migrations.md) → how the auth migration was staged for Phase B without disrupting Phase A.

---

## Tradeoffs

We traded a real authentication surface for time-to-data-layer — the schema gate is correct today, the runtime gate is staged for the day there's an actual second user.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (hardcoded UUID +   │ Alternative (Supabase auth +   │
│                  │ RLS staged-but-off)            │ RLS enabled day-1)             │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Complexity       │ 1 line in client.ts +          │ login screen + session refresh │
│                  │ migration 0002 applied (RLS    │ + token storage + RLS policies │
│                  │ disabled); 0009 re-disabled    │ enabled + bootstrap auth path  │
│ Time-to-ship     │ days (auth deferred entirely)  │ 1–2 weeks (auth UI + supabase  │
│  data layer      │                                │ flows + RLS testing per table) │
│ Failure blast    │ leaked anon key = read all     │ leaked anon key = read nothing │
│  radius (cloud)  │ rows; device-loss = read all   │ (token required); device-loss  │
│                  │ local rows                     │ = read local rows only         │
│ Device-loss      │ uncovered — no PIN, no         │ launch-screen lock + at-rest   │
│  exposure        │ encryption beyond OS default   │ encryption ship with auth      │
│ Migration cost   │ 1 client.ts line + enable      │ none — already there           │
│  to Phase B      │ migration 0002 + one-time      │                                │
│                  │ user_id backfill               │                                │
│ Cognitive load   │ "Phase A is single-user, do    │ "auth is auth, just like every │
│                  │ not enable RLS until auth      │ other app"                     │
│                  │ ships" — one rule              │                                │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

The Supabase anon key is functionally a password. Anyone holding it can read every row in every cloud table, because the runtime gate (RLS) isn't on. We mitigate by storing keys in Android Keystore via `expo-secure-store` and shipping no public API surface, but the mitigation is "the key is hard to steal," not "stealing the key is harmless."

The device-loss case is uncovered. The app has no PIN, no biometric gate on launch, no encryption on `buffr.db` beyond what Android offers at the OS level. If a borrowed phone is unlocked, the journal is readable. That's the explicit cost of skipping the auth UI in Phase A; the threat model says "the target user is me, my phone has fingerprint lock" and stops there.

Defined-but-disabled RLS is a footgun — and it already fired. RLS drifted on once (the Supabase dashboard nags about disabled-RLS tables and offers a one-click enable), and because `auth.uid()` is NULL under the anon key, every policy denied every push and pull. Cloud sync silently froze — local SQLite stayed canonical, so the app *felt* completely normal while the cloud quietly diverged. Migration `0009_disable_rls_phase_a.sql` rolled it back and codifies the Phase A posture in the migration chain (so a `db-migrate --all-pending` can't leave RLS on). The lesson: RLS without real auth doesn't half-work — it fails closed and silent.

### What the alternative would have cost

If we had shipped Supabase auth on day 1, we'd have spent 1–2 weeks on login UI, session refresh, token storage in SecureStore, the bootstrap flow change in `_layout.tsx`, and per-table RLS policy testing before any of the journaling features could ship. The journaling app would not exist in a useable form yet. We'd have the strongest security posture (no anon-key read-all) but no users to protect because there's no app to use.

The cognitive load also shifts. Every test, every migration script, every dev-action push from `scripts/db-migrate.mjs` would need a real bearer token, and the developer-experience overhead of "log in as devuser before you run anything" compounds on a solo timeline.

### The breakpoint

Fine until the first non-me user installs the APK. At that point the hardcoded UUID stops being a placeholder for "me on my device" and starts being a real cross-user collision — two installs share the same `user_id`, and every row from device A appears on device B's dashboard. The fix is Phase B exactly: ship auth UI, replace `PHASE_A_USER_ID` with `auth.uid()`, enable migration 0002, run a one-time `user_id` backfill on existing rows.

---

## Tech reference (industry pairing)

### expo-secure-store

- **Codebase uses:** `expo-secure-store` (Android Keystore-backed secret storage).
- **Why it's here:** the Supabase anon key lives here; it is the only mitigation between a stolen key and full cloud read access in Phase A.
- **Leading today:** `expo-secure-store` — `adoption-leading` for RN secrets, 2026.
- **Why it leads:** Expo-native; Android Keystore + iOS Keychain behind one API; zero extra dependency for Expo projects.
- **Runner-up:** `react-native-keychain` — broader feature set (biometric prompts), bare-RN-friendly.

### Supabase (auth + RLS)

- **Codebase uses:** Supabase anon key (Phase A); RLS staged in `supabase/migrations/0002_rls_policies.sql` for Phase B; composite `(user_id, id)` PKs on every synced table enforced via Supabase Postgres.
- **Why it's here:** Supabase is both the auth provider the file frames Phase B around and the enforcement surface for the runtime gate.
- **Leading today:** Supabase — `adoption-leading` for Postgres-as-a-service with integrated auth and RLS, 2026.
- **Why it leads:** managed Postgres + auth + RLS + Storage in one console; SDK mirrors PostgREST; `auth.uid()` wires directly to RLS policies without extra middleware.
- **Runner-up:** Neon + Drizzle — `innovation-leading` typed SQL with branch-per-PR; Convex is the reactive-first alternative.

---

## Summary

A trust boundary is the explicit seam between unauthenticated and authenticated code paths, paired with a mechanism that enforces it on every crossing — defense in depth means the schema, the middleware, and the application code each independently refuse unauthorized access. In this codebase the schema gate is composite `(user_id, id)` primary keys declared in `supabase/migrations/0001_initial_schema.sql`, and the runtime gate is RLS staged in `supabase/migrations/0002_rls_policies.sql` but disabled; every Supabase write and read instead stamps a hardcoded `PHASE_A_USER_ID` UUID from `src/services/sync/client.ts`. The constraint was a solo product with a single user in Phase A — shipping the data layer and sync engine before the auth UI was the priority. The cost is that the Supabase anon key is functionally a password — anyone holding it can read everything, mitigated only by keys living in SecureStore and the app having no public surface. The day a real second user logs in, Phase B activates the runtime gate by replacing the hardcoded UUID with `auth.uid()` and shipping a new migration that flips RLS to `ENABLE` (0002's policies are already applied; only the toggle is left).

Key points to remember:
- Two gates exist: composite `(user_id, id)` PKs (schema, always active) and RLS in migration 0002 (runtime, disabled in Phase A).
- Every cloud write/read stamps a hardcoded `PHASE_A_USER_ID` UUID from `src/services/sync/client.ts`.
- Lives in step 4 (State ownership) and step 6 (Scale concerns) of the system-design checklist.
- The schema doesn't change when Phase B ships — composite PKs were already correct; only the client `user_id` source and the RLS toggle flip.
- The anon key is functionally a password in Phase A — device-loss is uncovered until a launch-screen lock and at-rest encryption ship.

---

## Interview defense

### What an interviewer is really asking
"Phase A has no auth" is the sentence that makes interviewers either move on or pounce. The interviewer wants to know whether you understand that "no auth" is a deliberate decision with named consequences — not a thing you forgot. The probe is: do you know what you're exposed to right now, and do you have a credible plan for closing it?

### Likely questions

[mid] Q: What's the difference between the schema gate and the runtime gate, and which one is active in Phase A?

A: The schema gate is the composite `(user_id, id)` primary key on every synced Supabase table — if a row doesn't include the user's id, that row literally doesn't exist for them. The runtime gate is RLS, defined in `supabase/migrations/0002_rls_policies.sql` but not currently enabled. Phase A only has the schema gate; the runtime gate is staged for Phase B. Both exist because they catch different threats — bad code (schema) versus stolen credentials (RLS).

```
[two gates, one active in Phase A]

  Client request
       │
       ▼
  Schema gate: composite (user_id, id) PK
       │   row doesn't exist for wrong user_id
       │   ACTIVE in Phase A
       ▼
  Runtime gate: RLS (user_id = auth.uid())
       │   query filtered to caller's rows
       │   STAGED, DISABLED in Phase A
       ▼
  Postgres row returned (or not)
```

[senior] Q: Why ship without RLS at all? You wrote the policies — why not turn them on?

A: Because turning on RLS means I also need real Supabase auth — there's no `auth.uid()` to evaluate without a logged-in user. I know this firsthand: RLS got enabled once (the Supabase dashboard nags about disabled-RLS tables and offers a one-click enable), and because `auth.uid()` is NULL under the anon key, every policy denied every push and pull — cloud sync silently froze while local SQLite kept working, so nothing *looked* broken. Migration `0009_disable_rls_phase_a.sql` rolled it back. That's the empirical proof that RLS without auth doesn't half-work; it fails closed and silent. Phase A is single-user-by-design; I hardcoded a UUID in `client.ts` so I could ship the data layer and the sync engine without solving auth UI first. The policies stay in tree (0002) so a Phase B migration can flip `ENABLE` once real auth lands, without rewriting the sync layer. The cost I accepted is that the Supabase anon key is functionally a password — anyone holding it can read everything. Mitigation: the keys live in Android Keystore via `expo-secure-store`, and the app has no public API surface.

```
                  Path taken (hardcoded UUID, RLS off)  Alternative (Supabase auth day 1)
                  ──────────────────────────────────    ──────────────────────────────────
auth UI           none — deferred to Phase B            login + signup + session refresh
RLS state         0002 applied → RLS disabled;          RLS enabled, enforced on
                  0009 re-disabled after drift          every query
anon-key risk     reads everything in cloud             reads nothing (token required)
time-to-data      days                                  1–2 weeks
                  layer
Phase A user      "me, on my device, fingerprint       any installer of the APK
                  lock"
when worth        single solo writer                   multi-user from day 1
                  flipping
```

[arch] Q: Walk me through the migration from Phase A to Phase B at scale. What stays, what changes?

A: The schema doesn't change — composite PKs were always correct. The migration is: ship Supabase auth UI, replace `PHASE_A_USER_ID` reads with the authenticated user's UUID, run a one-time backfill that rewrites every existing row's `user_id` to that authenticated UUID, then ship a new migration that flips RLS to `ENABLE` (0002's policies are already applied; 0009 currently holds RLS off). The sync layer and every CRUD path stay identical. The risk is the backfill — if a user already has data on multiple devices each tagged with the same hardcoded UUID, deduplication is required first. And the ordering matters: enable RLS *after* the backfill and a verified `auth.uid()`, or you reproduce the 0009 silent-freeze.

```
At Phase B (1 → N users, real auth):

  ┌─ Auth UI layer ─────────────────────────────┐
  │ NEW — Supabase login + signup + session     │  ◀── NEW SURFACE
  │ Replaces hardcoded PHASE_A_USER_ID read     │
  └─────────────────────────────────────────────┘
              │
  ┌─ Sync / database.ts ────────────────────────┐
  │ unchanged — already user_id-aware           │
  └─────────────────────────────────────────────┘
              │
  ┌─ Schema gate (composite PKs) ───────────────┐
  │ unchanged — was correct in Phase A          │
  └─────────────────────────────────────────────┘
              │
  ┌─ Runtime gate (RLS) ────────────────────────┐
  │ FLIPPED ON — migration 0002 installed       │  ◀── BREAKS FIRST if backfill
  │ Backfill rewrites old rows' user_id to       │     skipped (auth.uid() ≠
  │ auth.uid() before policies activate          │     PHASE_A_USER_ID, queries
  └─────────────────────────────────────────────┘     return zero rows)
```

### The question candidates always dodge
Q: You're shipping a journaling app with no end-user auth and you're calling that acceptable. What about a user who installs your APK on a borrowed phone, writes for a week, then loses the phone — everything they wrote is now on a stranger's device with no password. Defend that.

A: Honestly, the device-loss case isn't covered. The app has no PIN, no biometric gate on launch, no encryption on `buffr.db` beyond what Android offers at the OS level. If the borrowed phone is unlocked, the journal is readable. I accepted that because Phase A's target user is me — solo developer using my own device — and adding a launch-screen lock would be three days of work that nobody is asking for yet. The honest mitigation is "it's on my phone, my phone has a fingerprint lock." The day I onboard a non-me user, the launch-screen lock and at-rest encryption are blockers; I won't pretend they're optional. The schema gate doesn't help here because the threat isn't cross-user reads — it's a stranger reading the only user's data.

```
                  Path taken (no launch lock,           Suggested (launch lock + at-rest
                  no at-rest encryption)                encryption from day 1)
                  ──────────────────────────────────    ──────────────────────────────────
device-loss       fully exposed — unlocked phone        gated by PIN/biometric; buffr.db
 exposure         reads journal verbatim                encrypted at rest
build cost        0 (current)                           ~3 days (PIN UI + SQLCipher
                                                        integration + key rotation)
Phase A user      "me, fingerprint lock at OS level"    "any installer"
 fit
threat addressed  cross-user reads (schema gate)        device-loss / theft
acknowledgement   documented as known gap; blocker      no gap
                  for Phase B
```

### One-line anchors
- "Phase A is auth-deferred, not auth-forgotten — the migration is a single client.ts line and a migration toggle."
- "Composite `(user_id, id)` PKs were the choice that paid back: same schema works in Phase A and Phase B."
- "RLS without auth is meaningless — `auth.uid()` needs a logged-in user. The migration is staged for the day there is one."
- "The threat model in Phase A is device-loss, not cross-user — and device-loss is currently uncovered. I know that."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the authentication boundary to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/sync/client.ts` + `supabase/migrations/0001..0002`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

Phase B ships tomorrow. The migration is: ship Supabase auth UI, drop the hardcoded `PHASE_A_USER_ID`, ship a new migration that flips RLS to `ENABLE` (0002's policies are applied; 0009 holds RLS off today). A user has 200 entries already in cloud, all tagged with the Phase A UUID. After they log in for the first time and get a *real* `auth.uid()`, what does the dashboard query show? What's the one-time backfill that has to run, and where would you write it?

Write your answer. 3–5 sentences minimum. Then open `src/services/sync/client.ts` and `supabase/migrations/0001_initial_schema.sql` to verify the schema shape.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `supabase/migrations/0001_initial_schema.sql` (the schema gate that paid back) to support what exists
→ Point to `supabase/migrations/0002_rls_policies.sql` (the runtime gate you'd enable, paired with auth UI) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).

---
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram; added architectural-layer labels to the primary diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for expo-secure-store, @supabase/supabase-js.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (two-locked-doors metaphor opening / 4 layered sub-sections — schema gate composite PK, RLS runtime gate, Phase A/B, defense in depth — each with frontend bridges and concrete consequences / principle paragraph on defense in depth).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (bank-vault two-locks scenario → defense-in-depth pattern named as the answer → bolded "what depends on getting this right" with composite PK + staged RLS stakes → before/after walking an accidental RLS-disable PR → one-line "schema is the deadbolt; RLS is the guard").

---
Updated: 2026-05-14 — v1.31.0 pass (system-design re-scan): rewrote Move 1 of Why care + How it works to anchor on real software (replaced bank-vault + two-locked-doors analogies with GitHub branch protection requiring review + status checks, and Stripe webhook signature + IP allowlist defense-in-depth). Both Move 1s were missed by the original triage agent; this re-scan caught them.

---
Updated: 2026-05-14 — v1.32.0 pass: swapped Why care + How it works Move 1 anchors from whole-product references (GitHub branch protection, Stripe webhooks) to the level-1 primitive (two `WHERE` clauses on the same query); same swap on the Why care Move 5 summary. Added Move 1 mnemonic diagram (two-WHERE-clauses pipeline) + 4 Move 2 sub-section diagrams: composite-PK table shape, RLS client-vs-database query rewrite, Phase A/B side-by-side, and a failure-mode comparison table. Total: 5 new diagrams.

---
Updated: 2026-05-19 — added `Postgres namespace` row to `## In this codebase` documenting migration 0010 (cloud tables moved to `buffr` schema); noted that the composite-PK gate and the staged RLS policies followed the tables to the new schema automatically, so the auth posture is unchanged.

---
Updated: 2026-05-29 — codebase-drift + accuracy pass: corrected the factually-wrong "migration 0002 not installed / not applied" claims (0002 IS applied — it creates the policies and disables RLS by design). Added the real RLS incident the file was missing: RLS drifted on (Supabase dashboard one-click enable), `auth.uid()` was NULL under the anon key so every policy denied every push/pull, cloud sync silently froze, and migration 0009 rolled it back. Added 0009 to `In this codebase`, a `Where this breaks down` bullet, the footgun sub-block (hypothetical → actual incident), and the [senior] interview answer. Reframed Phase B from "enable migration 0002" to "ship a new ENABLE migration" (0002 disables RLS; the toggle is a separate migration) across Why care, Summary, and both [arch]/Level-3 scenarios. Fixed the Phase A/B diagram cell and two comparison-table cells.
