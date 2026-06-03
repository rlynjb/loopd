# Networking red flags — the ranked checklist
## Industry name(s): network review checklist · Type: Audit summary

> Buffr's network surface is small. Most flags are LOW or N/A. The one structural concern (cross-cutting from other guides) is HTTP-200-with-error handling — and that's the same silent-error-guard finding that load-bears across guides.

## Zoom out, then zoom in

```
  top three moves (ranked)
  ─────────────────────────────────────────────────────────
  1. fix the HTTP-200-with-error path in sync orchestrator
     ✓ same silent-error fix as everywhere else
  2. add automatic provider failover (Anthropic → OpenAI)
     ✓ ~30 LOC; closes transient-outage gap
  3. (optional) certificate pinning for high-value features
     ✓ only when threat model demands it
```

## Structure pass

```
  axis = "what fires when?"

  HIGH    blocks features or silent failure
  MED     scaling tier cost
  LOW     style; preempt now
  PRAISE  the network model handles this for us
  N/A     not applicable (mobile, not browser)
```

## How it works

### Move 1 — checklist

### Move 2 — scorecard

**Map / boundaries**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Excessive peers | ✗ — PRAISE | — | three peers; minimum correct |
| Plaintext traffic | ✗ — PRAISE | — | HTTPS only |

**DNS / routing**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Hardcoded IPs | ✗ — PRAISE | — | hostnames only |
| DNS-over-HTTPS not used | ✓ NOT YET | — | OS resolver is fine |

**TCP / sockets**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Connection-pool mis-tuned | ✗ — PRAISE | — | OkHttp defaults |
| Per-call new socket | ✗ — PRAISE | — | OkHttp pools |

**TLS**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| TLS optional / downgrade allowed | ✗ — PRAISE | — | TLS-only |
| No certificate pinning | ✓ INTENTIONAL | LOW | OK for threat model |

**HTTP**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| HTTP-200-with-error misread (silent failure) | ✓ TRUE | HIGH | `\|\| r.error` (debug-obs/01) |
| Missing/wrong Authorization headers | ✗ — PRAISE | — | SDK handles |
| HTTP caching mis-used | ✗ N/A | — | application cache is in SQLite |
| CORS issue | ✗ N/A | — | mobile |

**Realtime**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| Realtime missing where needed | ✗ N/A | — | not needed today |
| Realtime reconnect logic missing | ✗ N/A | — | no realtime in use |

**Timeouts / retries**

| Flag | Fires? | Severity | Fix |
|---|---|---|---|
| No timeout on chain call | ✗ — PRAISE | — | explicit 30s |
| No exponential backoff on retry | ✓ TRUE | LOW | preempt at next scale tier |
| No automatic LLM-provider failover | ✓ TRUE | MED | ~30 LOC in `compose.ts` |

### Move 3 — the principle

```
  buffr's network is well-shaped because it's small and uses
  defaults correctly. the structural finding (HTTP-200-with-error)
  is the cross-cutting silent-error finding from elsewhere.
```

## Primary diagram

```
   buffr network scorecard

   HIGH SEVERITY
    ─ HTTP-200-with-error misread (debug-obs/01, sync orchestrator)

   MED SEVERITY
    ─ no automatic LLM-provider failover

   LOW SEVERITY
    ─ no exponential backoff on sync retries
    ─ no certificate pinning (acceptable)
    ─ no DNS-over-HTTPS (OS resolver is fine)

   PRAISE
    ─ HTTPS only, no plaintext
    ─ three peers (minimum correct)
    ─ OkHttp connection pooling
    ─ TLS 1.2/1.3 by default
    ─ no realtime complexity until needed
```

## Elaborate

The "small, default, HTTPS" pattern is the right baseline for a client mobile app. Tuning beyond defaults requires evidence. Today there's no evidence; the audit confirms defaults are correct.

## Interview defense

**Q [mid]:** Biggest network risk?

**A:** Same as the cross-cutting finding: silent failures from PostgREST's HTTP-200-with-error pattern. Fix is in the orchestrator's log guard.

**Q [senior]:** What's the next move at scale?

**A:** Automatic LLM-provider failover. Currently `compose.ts` falls back on per-call exception; making the fallback transparent is ~30 LOC.

## Validate

### Level 1 — sketch the severity ladder.

### Level 2 — explain why the silent-error finding is HIGH here too.

### Level 3 — apply: implement automatic provider failover.

### Level 4 — defend: "Add cert pinning for security." Cost > benefit at current threat model.

## See also

- All concept files 01–07.
- `../study-debugging-observability/01-success-only-log-guard.md`
- `../study-security/01-trust-boundaries-and-attack-surface.md`
- `../study-distributed-systems/02-partial-failure-timeouts-and-retries.md`
