# Authentication boundary

**Industry name(s):** Authentication middleware, security boundary
**Type:** Industry standard · Language-agnostic

> Phase A has no end-user authentication — every cloud row is tagged with a single hardcoded `user_id`. RLS is *scaffolded* (migration 0002) but disabled.

**See also:** → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [13-append-only-migrations](./13-append-only-migrations.md)

---

## Why care

Every system has a line drawn on the inside of it where "we trust this request" turns into "we don't, and we need to prove who's asking." Most bugs that leak one user's data to another are caused by drawing that line in the wrong place, or by drawing it on paper and forgetting to enforce it in code. The interesting question is never "do we have auth" — it's "where does the trusted zone end, and what stops a request from crossing it without identity."

A trust boundary is the explicit seam between unauthenticated and authenticated code paths, paired with a mechanism that enforces the seam on every crossing. It belongs to the family of "defense in depth" patterns, where the schema, the middleware, and the application code each independently refuse unauthorized access. You've seen this in Postgres row-level security, in HTTP middleware that rejects requests before they hit a handler, and in the way operating systems separate user-space from kernel-space syscalls. The next block walks the mechanics.

---

## How it works

Two layers of isolation, only one of which is active in Phase A.

The **schema gate** is composite primary keys: every synced table has `PRIMARY KEY (user_id, id)`. If the client ever asks for someone else's `id`, the row literally doesn't exist for them. This is enforced regardless of authentication state.

The **runtime gate** is RLS. Migration `0002_rls_policies.sql` defines policies that filter every query to `user_id = auth.uid()`. In Phase A this migration is in the file system but the policies are not installed; the user_id is hardcoded client-side.

Phase B activates the runtime gate: ship Supabase auth, drop the hardcoded id, enable RLS. The schema gate doesn't change because it was already correct. The diagram below shows it end-to-end.

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

**Hardcoded id:**       `src/services/sync/client.ts` — holds `PHASE_A_USER_ID` (UUID). Every push and pull mapper stamps it; replacing it with `auth.uid()` is the Phase B switch.
**Schema gate:**        `supabase/migrations/0001_initial_schema.sql` — declares composite `(user_id, id)` PKs on every synced table. The schema-level isolation that holds today and after RLS ships.
**Runtime gate (off):** `supabase/migrations/0002_rls_policies.sql` — the staged-but-disabled RLS scaffold. File exists, policies are not installed in Phase A.

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

## Quick summary

A trust boundary is the explicit seam between unauthenticated and authenticated code paths, paired with a mechanism that enforces it on every crossing — defense in depth means the schema, the middleware, and the application code each independently refuse unauthorized access. In this codebase the schema gate is composite `(user_id, id)` primary keys declared in `supabase/migrations/0001_initial_schema.sql`, and the runtime gate is RLS staged in `supabase/migrations/0002_rls_policies.sql` but disabled; every Supabase write and read instead stamps a hardcoded `PHASE_A_USER_ID` UUID from `src/services/sync/client.ts`. The constraint was a solo product with a single user in Phase A — shipping the data layer and sync engine before the auth UI was the priority. The cost is that the Supabase anon key is functionally a password — anyone holding it can read everything, mitigated only by keys living in SecureStore and the app having no public surface. The day a real second user logs in, Phase B activates the runtime gate by replacing the hardcoded UUID with `auth.uid()` and enabling migration 0002.

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

Phase B ships tomorrow. The migration is: ship Supabase auth UI, drop the hardcoded `PHASE_A_USER_ID`, enable migration `0002`. A user has 200 entries already in cloud, all tagged with the Phase A UUID. After they log in for the first time and get a *real* `auth.uid()`, what does the dashboard query show? What's the one-time backfill that has to run, and where would you write it?

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
