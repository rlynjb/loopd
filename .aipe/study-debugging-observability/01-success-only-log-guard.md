# The success-only log guard — buffr's load-bearing observability gap
## Industry name(s): error-as-data, silent-failure log guard · Type: Pattern (anti-pattern), language-agnostic

> A guard that gates logging on success counts hides failures the underlying API returns as data rather than as a thrown exception. In buffr, two lines in `src/services/sync/orchestrator.ts` turn loud Supabase failures into silent freezes.

## Zoom out, then zoom in

```
  LAYERS — where the bug lives
  ┌─────────────────────────────────────────────────────────────┐
  │ orchestrator.ts          ←  the GUARD lives here            │
  │   if (r.succeeded > 0 || r.failed > 0) console.log(...)     │
  │                                                              │
  │ pushTable / pullTable    ←  returns { succeeded, failed,    │
  │                             error? } — error-as-data path   │
  │                                                              │
  │ Supabase JS SDK          ←  may THROW on transport errors,  │
  │                             or RESOLVE with PostgREST error │
  │                             code embedded in the body       │
  │                                                              │
  │ PostgREST / Supabase     ←  responds 200 with { code: ... } │
  │                             on RLS deny, on PGRST106, etc.  │
  └─────────────────────────────────────────────────────────────┘
```

The path from "Supabase rejects the request" to "engineer sees a log line" is gated by the guard at the top layer. The bug is that the guard checks only the two count fields the SDK *throws-zero* path populates — not the third field (`error`) that the SDK *resolves-with-error* path populates.

Zoom in: when push fails with RLS denial (PGRST301), the SDK returns `{ data: null, error: { code: 'PGRST301', message: '...' } }`. `pushTable` faithfully forwards this into a result shape `{ succeeded: 0, failed: 0, error: 'denied' }`. The guard sees `0 > 0 || 0 > 0 → false`. **No log line. No throw. No user-visible signal.** The sync engine quietly stops working; the user keeps writing locally; the cloud diverges silently for hours or days. This is the 0009 incident's actual mechanism.

## Structure pass

```
  layers   ─ guard (orchestrator) ─ producer (pushTable/pullTable)
             ─ SDK (Supabase JS) ─ wire (PostgREST)

  axes     ─ throws vs returns-as-data (the SDK's two error modes)
             ─ count-based observation vs error-field observation

  seams    ─ orchestrator ←→ pushTable: the result shape contract
             ─ pushTable  ←→ SDK: the throw-vs-resolve discipline
             ─ SDK        ←→ PostgREST: HTTP 200 + error body convention
```

The load-bearing seam is the first one. The producer (`pushTable`) honestly carries the error forward in the result. The consumer (the orchestrator's guard) discards it. The gap is one boolean expression wide.

## How it works

### Move 1 — the two error modes the JS SDK exposes

```
  THE TWO MODES (Supabase JS SDK)

  mode A — throw
   ┌─────────────────────────────────┐
   │  await supabase.from(t).upsert  │ → throws on
   │  ✗                              │   transport, auth-token,
   │  catch (e) { ... }              │   client misconfig
   └─────────────────────────────────┘

  mode B — resolve-with-error
   ┌─────────────────────────────────┐
   │  const { data, error } =        │ resolves with
   │    await ...upsert()            │ error.code populated:
   │  if (error) handle()            │ PGRST301 (RLS deny)
   │                                 │ PGRST106 (schema missing)
   │                                 │ 23505    (uniq violation)
   └─────────────────────────────────┘
```

PostgREST returns HTTP 200 with an error body for most database-tier failures — RLS denial, schema-not-exposed, unique-constraint violation, foreign-key violation. The SDK doesn't throw on these; it surfaces them via the `error` field. **A guard that only checks for throws will miss every database-tier failure**.

### Move 2 — buffr's guard, and why it was written this way

```
  THE GUARD                            WHY IT LOOKS REASONABLE

  if (r.succeeded > 0 ||               ┌──────────────────────┐
      r.failed > 0) {                  │ "if nothing was      │
    console.log('[buffr sync]          │  attempted, don't    │
      push ${table}: ${r.succeeded}    │  print noise"        │
      ok, ${r.failed} failed');        │                      │
  }                                    │ a dirty-filter that  │
                                       │ found zero rows is a │
                                       │ true zero — no need  │
                                       │ to log every cycle.  │
                                       └──────────────────────┘
```

The intent is sound: a sync cycle on an unchanged table is a non-event. The shipping bug is that the guard cannot distinguish "zero rows to push" from "rows attempted, all rejected before any succeeded or failed counter incremented." The latter is exactly what happens when authorization is denied at the request level — the SDK returns one error for the whole batch; no per-row counter ever moves.

### Move 3 — the principle: never gate logging on success metrics

```
  THE RULE
   ┌─────────────────────────────────────────────────┐
   │ A log guard's predicate must include EVERY      │
   │ failure-bearing field the producer can populate, │
   │ including ones surfaced as data rather than as   │
   │ thrown exceptions.                               │
   └─────────────────────────────────────────────────┘

  THE BANNED SHAPE
   if (success > 0) log()   ← any version of this

  THE RIGHT SHAPE
   if (success || failure || error || skipped) log()
   ─ or ─
   ALWAYS log; let the log level decide visibility
```

The "always log" variant is sometimes cheaper to maintain. The cost is one log line per sync cycle even on no-op cycles. At single-user scale, this cost is zero; the discipline buys correctness directly. At larger scale, structured logging with level gating replaces the boolean guard with a level filter, which is qualitatively different.

## Primary diagram

```
  buffr's silent-freeze sequence

  device          orchestrator       pushTable        Supabase
   │                  │                  │                │
   │  app writes      │                  │                │
   ├──────────────────▶                  │                │
   │  to local DB     │                  │                │
   │                  │  sync cycle      │                │
   │                  ├──────────────────▶                │
   │                  │                  │  upsert(batch) │
   │                  │                  ├────────────────▶
   │                  │                  │                │
   │                  │                  │ 200 + { error: │
   │                  │                  │   PGRST301 }   │
   │                  │                  │◀───────────────┤
   │                  │                  │                │
   │                  │  { succeeded:0,  │                │
   │                  │    failed:0,     │                │
   │                  │    error:'...' } │                │
   │                  │◀─────────────────┤                │
   │                  │                  │                │
   │  ┌─ THE GUARD ─┐ │                  │                │
   │  │  0 > 0 ||   │                  silent. no log.    │
   │  │  0 > 0      │                  no throw.          │
   │  │  → false    │                  user sees nothing. │
   │  └─────────────┘                                     │
   │                  │                                   │
   │  user keeps writing locally; cloud diverges          │
   ▼                                                      ▼
```

One missing OR term hides this whole sequence.

## Implementation in codebase

The two lines, read side by side with the fix.

```ts
// src/services/sync/orchestrator.ts (around line 49 — push branch)

for (const table of tables) {
  const r = await pushTable(table, ctx);
  if (r.succeeded > 0 || r.failed > 0) {                     // ← line 49
    console.log(`[buffr sync] push ${table}: ${r.succeeded} ok, ${r.failed} failed`);
  }
}

// and again (around line 72 — pull branch)

for (const table of tables) {
  const r = await pullTable(table, ctx);
  if (r.applied > 0 || r.fetched > 0) {                      // ← line 72
    console.log(`[buffr sync] pull ${table}: ${r.applied} applied, ${r.fetched} fetched`);
  }
}
```

**Line-by-line read of line 49:**

- `r.succeeded > 0` — true when at least one row in the batch reached PostgREST and was accepted.
- `r.failed > 0` — true when at least one row was rejected per-row (constraint violation on a single row, e.g.).
- **What's missing:** `r.error` is populated when the whole *batch* was rejected before per-row processing happened. RLS denial, schema-not-exposed, auth-token failure — all of these reject the batch as a unit. The producer carries the field; the guard ignores it.

**The fix, in two forms:**

```ts
// Form 1 — extend the guard (10 LOC across both branches)
if (r.succeeded > 0 || r.failed > 0 || r.error) {
  console.log(
    `[buffr sync] push ${table}: ${r.succeeded} ok, ${r.failed} failed` +
    (r.error ? `, ERROR: ${r.error}` : '')
  );
}

// Form 2 — always log, kept structured
console.log('[buffr sync] push', { table, ...r });
```

Form 1 preserves the original "silent on no-op" intent. Form 2 trades that for absolute symmetry. For buffr today, **Form 1 is the right call** — the dirty-filter genuinely makes most cycles no-op, and at single-user scale the noise floor matters more than structured indexing.

**The result-shape audit.** While extending the guard, verify the producer side. `pushTable` and `pullTable` must populate `r.error` reliably when the SDK call returns `{ error }`. If the producer drops the error on the floor and only reports counts, the guard fix is cosmetic.

## Elaborate

This bug pattern generalizes well beyond Supabase. Anywhere an API has *two* error modes (throws + error-as-data), any guard that counts only one mode will systematically miss the other. Same pattern with:

- the AWS SDK v3 — most service errors are returned as `$metadata` on a resolved response, not thrown
- Stripe — `Stripe.errors.*` thrown for some, but `result.lastResponse.statusCode` for others
- any GraphQL client — partial-error responses resolve normally with errors in the `errors` array

The principle is "name every error mode the API can produce; gate on the union, not the intersection."

The reason this specific bug fired *twice* in buffr — the 0009 RLS incident and the PGRST106 schema-not-exposed incident — is that PostgREST as a layer is unusually fond of resolve-with-error. Most "database-tier" failures from Supabase travel as data. A guard that only watches for throws will be perpetually blind to the most common Supabase failure modes.

**Why this finding shows up across four study guides.** It's the load-bearing observability gap (`study-debugging-observability/audit.md` #1), the load-bearing security gap (`study-security/05-data-exposure-and-privacy.md` — silent denial means a future attacker probing for RLS coverage has more time), the load-bearing software-design red flag (`study-software-design/08-red-flags-audit.md` — a Move 2 boundary that loses information), and the first integration test to write (`study-testing/05-edge-cases-and-error-paths.md` — RLS-deny-as-data). Four lenses, one finding. That's what "load-bearing" means.

## Interview defense

**Q [mid]:** "Your sync engine went silent for hours and you didn't notice. Walk me through what happened."

**A:** "Two-line guard at `orchestrator.ts:49` and `:72` checked `succeeded > 0 || failed > 0` to decide whether to log. PostgREST returns RLS denial as a resolved response with an error field — neither counter ever incremented. The cycle ran on a timer, hit denial, returned cleanly with no log line, and exited. The local-canonical read path meant the UI showed the user's own writes back to them from SQLite, so the user had no signal either. Fix is one OR term — `|| r.error` — and the bug class collapses."

```
  one diagram, in the interview

   ┌─ producer ─┐   ┌── guard ──┐   ┌─ user ─┐
   │ pushTable  │ → │ succ>0 || │ → │ sees   │
   │ { s:0,     │   │ fail>0    │   │ NOTHING│
   │   f:0,     │   │           │   │        │
   │   err:✓  } │   │ false     │   │        │
   └────────────┘   └───────────┘   └────────┘

   fix: || err  ──── done
```

**Q [senior]:** "What's the structural lesson — not the fix, the lesson?"

**A:** "Never gate logging on success metrics from an API that has more than one error mode. The Supabase JS SDK has two: throws for transport, resolve-with-error for database tier. A guard that watches only one is structurally blind to the other. The lesson generalizes to any SDK with mixed error modes — AWS v3, GraphQL clients, Stripe in places. The right discipline is to name every failure-bearing field the producer can populate and gate on the union, not the intersection."

**Q [arch]:** "Why didn't a test catch this?"

**A:** "Buffr has no automated tests. The test that would have caught it is a 30-line integration test: in-memory SQLite, mock Supabase client returning `{ data: null, error: { code: 'PGRST301' } }`, assert that `pushTable`'s result has `error` populated, then assert that the orchestrator's log was called. It's the first test I'd write — and it's the test the `study-testing/05-edge-cases-and-error-paths.md` audit recommends as the priority-1 integration test. The fact that this class of bug is detectable by a single test makes the test ROI very high."

```
  the test that would have caught it

   arrange:  mock SDK returns { error: { code: 'PGRST301' } }
   act:      run one sync cycle
   assert:   the orchestrator's log was called WITH the error
   ───────────────────────────────────────────────────────────
   30 lines.  catches every RLS-deny-as-data regression forever.
```

## Validate

### Level 1 — reconstruct the diagram

Sketch the four-actor sequence (device → orchestrator → pushTable → Supabase) showing the silent-freeze path. Mark where the guard sits and what predicate it evaluates.

### Level 2 — explain it out loud

Under 90 seconds: name the two SDK error modes, name buffr's guard, say why it fails, give the one-OR-term fix.

### Level 3 — apply to a new scenario

A new contributor adds an `s3.putObject(...)` call to a future feature and wraps it in `try { ... } catch (e) { console.error(e); }`. Walk why that's identical to buffr's bug and how AWS v3 makes it worse (most service errors are *not* thrown; they arrive in `result.$metadata`).

### Level 4 — defend the decision

Defend or oppose: "We should always log every sync cycle, even no-ops, to eliminate this class of bug forever."

Pro: structural — no guard, no failure mode. Con: noise floor in dev, plus *log volume* at scale matters; once buffr has a real remote logging sink, log volume costs money. The right answer for buffr today is Form 1 (extend the guard); the right answer for buffr at 10k users is Form 2 (always log, structured, with level gating).

## See also

- [`audit.md`](./audit.md) — Pass 1's evidence map and the eight-lens walk that ranks this finding #1.
- [`02-local-first-observability-paradox.md`](./02-local-first-observability-paradox.md) — why the user didn't notice and structurally can't notice.
- `../study-software-design/08-red-flags-audit.md` — the same finding under the design-quality lens.
- `../study-security/05-data-exposure-and-privacy.md` — the same finding under the trust-axis lens.
- `../study-testing/05-edge-cases-and-error-paths.md` — the test that pins this bug class down forever.
- `../study-testing/01-what-is-tested-and-what-isnt.md` — the priority-1 integration test list this finding belongs to.
