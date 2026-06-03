# Distributed-systems red flags — the ranked checklist
## Industry name(s): coordination review checklist · Type: Audit summary

> Buffr's coordination surface is tiny. Most flags are N/A (no quorum, no leader, no streams). The structural ones that fire are: silent error-as-data on sync (cross-cuts every guide); no DLQ for poison rows; manual LLM-provider failover.

## Zoom out, then zoom in

```
  the top three moves (ranked)
  ─────────────────────────────────────────────────────────
  1. fix the silent-error guard (debug-obs #1)
     ✓ same fix as everywhere else; 10 LOC
  2. add a push_failures column + DLQ-like skip on N+1
     ✓ prevents poison rows from burning a tick forever
  3. heartbeat alert on cloud-side silence
     ✓ the only honest detection in a local-first model
```

## Structure pass

```
  axis = "what breaks if this flag fires?"

  HIGH    structural; silent failure or data loss
  MED     real degradation; observable at next scale tier
  LOW     style; preempt now to save time later
  PRAISE  the design currently prevents the flag
```

## How it works

### Move 1 — the checklist (one row per flag)

```
  row: flag, fires?, severity, fix
```

### Move 2 — buffr's distributed-systems scorecard

**Partial failure / retries**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Silent error-as-data (sync) | ✓ | HIGH | `\|\| r.error` on guard |
| Retries safe (idempotent upsert) | ✗ — PRAISE | — | maintain |
| Timeouts cascade outer→inner | ✗ — PRAISE | — | maintain |
| Manual LLM-provider failover | ✓ | MED | add automatic fallback in `compose.ts` for transient Anthropic errors |

**Idempotency / delivery**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| At-least-once delivery | ✗ — PRAISE | — | by design |
| Idempotent application | ✗ — PRAISE | — | composite-PK upsert |
| Stable idempotency keys | ✗ — PRAISE | — | (user_id, id) |

**Consistency**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Local strong / cross-device eventual | ✗ — PRAISE | — | acceptable for journal |
| LWW deterministic tiebreak (local wins) | ✗ — PRAISE | — | no flapping |
| Server-time RPC for synced_at | ✗ — PRAISE | — | the right design |

**Queues / streams**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| No DLQ for poison rows | ✓ | MED | counter column + dirty-filter skip |
| No backpressure beyond debounce | ✓ | LOW | no concern at single-user scale |
| No real queue (SQLite-as-queue) | ✗ INTENTIONAL | — | correct for scale |

**Clocks / leadership**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Device clock as authority cross-device | ✗ — PRAISE | — | server-time RPC |
| Leadership election | ✗ N/A | — | not needed |
| Lease/lock for sync exclusion | ✗ N/A | — | one device, one process |

**Workflows**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Multi-step workflow without compensation | ✓ INTENTIONAL | — | re-derive from prose; no saga needed |
| Outbox missing | ✗ INTENTIONAL | — | dirty filter degenerates to outbox |

### Move 3 — the principle

```
  buffr's distributed-systems profile is minimal-but-correct.
  the only real risk class is hidden behind the same silent-error
  guard everywhere else. fix that and most coordination risks
  collapse.
```

## Primary diagram

```
   buffr coordination scorecard

   HIGH
    ─ silent error-as-data (sync orchestrator guard)

   MED
    ─ no DLQ for poison rows
    ─ no automatic LLM-provider failover
    ─ no heartbeat alert on cloud silence

   LOW
    ─ no exponential backoff on sync retry

   PRAISE
    ─ at-least-once + idempotent (composite-PK upsert)
    ─ deterministic LWW (local wins on tie)
    ─ server-time RPC for cross-device ordering
    ─ no premature complexity (no quorum, no leader, no real queue)
    ─ prose-as-source-of-truth eliminates saga need
```

## Implementation in codebase

The concrete actions, in order:

```ts
// 1. fix the silent-error guard (see debug-obs/01)
if (r.succeeded || r.failed || r.error) { /* log including error */ }
```

```sql
-- 2. add push_failures column per synced table
ALTER TABLE entries ADD COLUMN push_failures INTEGER NOT NULL DEFAULT 0;
-- dirty filter: AND push_failures < 5
```

```ts
// 3. automatic LLM-provider failover
async function callChain(chain: string, input: any) {
  try { return await callAnthropic(chain, input); }
  catch (e) { if (isTransient(e)) return await callOpenAI(chain, input); throw e; }
}
```

## Elaborate

The "minimal coordination surface" finding is buffr's load-bearing strength on this axis. The cost of distributed systems complexity is high; the cost of avoiding it (where the use case permits) is zero. Buffr's use case permits it; the audit confirms the design.

## Interview defense

**Q [mid]:** What's the biggest coordination risk in buffr?

**A:** The silent-error guard. Sync push can fail silently because PostgREST returns DB-tier errors as data, not throws. The guard checks success counts but not the error field. Fixing it is one OR term.

**Q [senior]:** What's the next coordination concern as buffr grows?

**A:** Poison rows — a row that fails every push (e.g., violates a constraint not yet on the local side). Today the dirty filter would re-try forever. Adding a `push_failures` column + skip-on-N+1 closes this.

## Validate

### Level 1 — sketch the severity ladder.

### Level 2 — explain why most flags are PRAISE or N/A.

### Level 3 — apply: add the push_failures DLQ skip in pseudocode.

### Level 4 — defend: "Adopt Raft for in-app sync coordination." Massive over-investment for single-device sync.

## See also

- `00-overview.md` — the coordination map.
- All concept files 01–08.
- `../study-debugging-observability/01-success-only-log-guard.md` — the load-bearing finding.
- `../study-system-design/audit.md` — the architectural framing.
