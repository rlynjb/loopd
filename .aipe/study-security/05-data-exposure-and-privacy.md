# Data exposure and privacy

**Industry name(s):** Information disclosure, over-fetching, PII in logs, error verbosity
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

Data exposure is the slow leak: nothing dramatic at any one site, but PII or sensitive content slips out through error messages, logs, over-fetched API responses, or verbose stack traces. Buffr's content — daily journal entries — is among the most sensitive a user owns; the audit's job is to enumerate the egress paths.

```
  Zoom out — where buffr's data could leak

  ┌─ Device ──────────────────────────────────────────┐
  │  SQLite (entries.text — the journal itself)       │
  │  expo-secure-store (API keys)                      │
  │  app sandboxed; readable only with device unlock   │
  └─────────────────────┬─────────────────────────────┘
                        │
  ┌─ Egress paths ──────▼─────────────────────────────┐
  │  console.log (dev / device logs)                  │
  │  Error messages → UI                               │
  │  Sync push → Supabase Postgres                     │
  │  AI chains → Anthropic / OpenAI servers            │
  └───────────────────────────────────────────────────┘
```

The audit walks each egress: who can read it, whether sensitive content lands there, and whether the egress is intentional (sync push) or accidental (a `console.log` that includes prose).

## Structure pass

The axis is **observability** — who can observe each piece of data?

```
  axis = "who can observe this data, and how?"

  data                 observable by                   intentional?
  ────                 ────────────                    ────────────
  entries.text         device user                     ✓ canonical store
                       Supabase (after push)            ✓ sync mirror
                       Anthropic / OpenAI (chain calls)  ✓ feature requirement
                       console / device logs            ✗ if any log includes it
  todo_meta            same as entries.text             ✓ derived
  API keys             SecureStore only                  ✓ scoped storage
  user_id              client + Supabase rows           ✓ structural identifier
  error messages       UI                                ◐ depends on verbosity
```

The risky cells are the ✗ and ◐ ones — accidental logs, and error messages that bleed implementation detail to users.

## How it works

### Move 1 — the egress pattern

```
  the leak shape

  sensitive data ─►  egress path ─►  external observer
       │                  │
       └─ "did we want      └─ logs, errors, third-party
          this here?"          responses, network traces

  the fix: for each egress, either (a) the data shouldn't be there,
  or (b) the observer is sanctioned by the user. nothing in between.
```

### Move 2 — buffr's egress paths

**Sync push to Supabase — INTENTIONAL.** The whole point of the sync mirror is to copy data to Supabase. Users opted in by using the feature. The PII (journal entries) is there because it has to be. The mitigations are the composite-PK schema gate (cross-user isolation) and the user's trust in Supabase's data handling.

**LLM chain calls to Anthropic / OpenAI — INTENTIONAL but worth naming.** The prose of an entry goes to Anthropic (or OpenAI when toggled) every time the summarize / caption / interpret chain runs. The user agreed to AI features when they enabled them; the audit just names that this is an egress, not free magic. Phase B may want a per-feature toggle (e.g., turn off cloud AI; use local model only) for users with stricter privacy needs.

**console.log — RISK SURFACE.** A `console.log(`entry: ${entry.text}`)` in development would write sensitive prose to device logs (visible via `adb logcat` if USB debugging is on). The audit's task is to grep for these.

```
  src/services/sync/orchestrator.ts (the existing logs — checked)

  console.log(`[buffr sync] push ${r.tableName}: ${r.succeeded} ok, ${r.failed} failed`);
  console.warn(`[buffr sync] push ${table.tableName} threw:`, msg);
       │
       └─ logs counts and table names; does NOT log row content.
          The `msg` in the warn is the exception message — could carry
          PostgREST error text (probably safe; verify on real exceptions).
```

**Error messages to UI — depends on verbosity.** A user-facing error like "Database constraint violation: todo_meta_user_id_fkey on row 12345" leaks implementation detail. The audit's check is: do errors get sanitized at the boundary, or does the stack trace flow to the screen?

### Move 3 — the principle

Every byte of sensitive data should have a named observer. Sync push and chain calls are named observers (the user agreed). Logs and error messages are accidental observers; their default content should be metadata (counts, table names, error codes), not content. The audit grep checks for the accidental cases.

## Primary diagram

```
  buffr's egress paths — intentional vs accidental

  INTENTIONAL (user-sanctioned)
   ─ sync push → Supabase (the whole feature)
   ─ chain calls → Anthropic / OpenAI (AI features)

  STRUCTURED LOGS (metadata only, currently OK)
   ─ orchestrator.ts logs counts + table names
   ─ no entry text logged at the sync layer

  AUDIT TARGETS (verify each release)
   ─ grep for console.log(...entry.text) — should be 0 results
   ─ check error.message paths to UI — sanitize at boundary
   ─ check thrown error contents for PostgREST verbose payloads
```

## Implementation in codebase

### The existing structured logs — metadata only

```
  src/services/sync/orchestrator.ts:49 (push log)

  if (r.succeeded > 0 || r.failed > 0) {
    console.log(`[buffr sync] push ${r.tableName}: ${r.succeeded} ok, ${r.failed} failed`);
  }
       │
       └─ metadata only: table name + counts. No row content. Safe.
          (Separate concern: this guard hides errors-as-data — see
          concept 01 of software-design audit.)
```

### The audit check — verify before release

```
  the grep checks (run as part of release CI ideally)

  $ grep -r 'console.log.*entry\.\|entries\.text\|todo\.\|.expanded_md' src/
   ── should return zero results before each release.
   ── any hit means a dev log slipped sensitive content into the device log.

  $ grep -r 'console.log.*api_key\|secret\|password\|token' src/
   ── should also return zero.
```

## Elaborate

PII-in-logs is the most-common preventable leak in mobile apps. The defense is uniform: log metadata (counts, IDs, durations), never content. Buffr's sync logs are already structured this way — counts and table names, not row contents. The audit's job is mostly to verify the pattern holds and to add a release-time grep as a sanity check.

For the broader exposure-via-error verbosity pattern, the cleanest defense is centralizing the error-to-UI translation in one place (a single `formatErrorForUser(err) → UserMessage` function), then auditing only that one site rather than every call site.

## Interview defense

**Q [mid]:** Where could user content leak in buffr?

**A:** Three intentional egresses (sync push, AI chains, the device itself — sandboxed) and one accidental risk surface (`console.log`). The sync and AI egresses are user-sanctioned features. The risk is a dev log that interpolates `entry.text` into a console call — invisible until someone reads device logs. Mitigation: a release-time grep that fails on any `console.log` containing entity fields. Cheap; high signal.

```
  intentional vs accidental egress

  user prose
   ├─ sync push → Supabase    (sanctioned ✓)
   ├─ chain call → provider   (sanctioned ✓)
   ├─ SQLite local             (canonical ✓)
   └─ console.log              (accidental ★ audit target)

  one-line anchor: "every byte of sensitive data has a named observer"
```

**Q [senior]:** What's the worst exposure path the audit would name?

**A:** A verbose error message that includes raw `entry.text` flowing to UI. None has been observed, but the audit step is to grep for error-rendering sites that don't sanitize. The defense is centralizing translation in one place (`formatErrorForUser`), then auditing only that site.

**Q [arch]:** What changes about exposure in Phase B?

**A:** Multi-user introduces new exposure paths — primarily Supabase's logs (which Supabase manages) and the chance that a multi-user UI accidentally renders someone else's prose. The composite-PK schema gate prevents the latter structurally (the wrong-user prose just doesn't exist in queries); the former is a Supabase contract question.

## Validate

### Level 1 — reconstruct the diagram

Sketch the egress paths (intentional vs accidental) with one example of each.

### Level 2 — explain it out loud

Under 90 seconds: name the intentional egresses, the accidental risk, and the cheap defense.

### Level 3 — apply to a new scenario

A new contributor adds a `console.log('Processing entry:', entry)` line for debugging. Walk what the audit would say.

Reference the orchestrator.ts log style as the contrast (metadata, not content).

### Level 4 — defend the decision

Defend or oppose: "Buffr should never call out to LLM providers — the prose is too sensitive to leave the device."

Reference `src/services/ai/config.ts` (the provider toggle) and the user's opt-in via AI feature use.

## See also

- [`04-secrets-and-configuration.md`](./04-secrets-and-configuration.md) — secrets in logs is a subset of this exposure class.
- [`08-security-red-flags-audit.md`](./08-security-red-flags-audit.md) — PII-in-logs as a checklist item.
