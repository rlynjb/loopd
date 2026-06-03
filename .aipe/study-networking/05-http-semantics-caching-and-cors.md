# HTTP semantics, caching, and CORS — what buffr uses and what it doesn't
## Industry name(s): HTTP methods, status codes, headers, CORS · Type: Foundational

> Buffr uses GET (rare), POST (LLM calls), and Supabase's PostgREST-encoded verbs (PATCH-as-upsert, etc.). No HTTP-level caching headers. No CORS concern (mobile, not browser). The application cache lives in SQLite, not in HTTP.

## Zoom out, then zoom in

```
  WHAT BUFFR USES                       WHAT IT DOESN'T

  ─ POST to LLM /messages               ─ HTTP caching headers
  ─ GET/POST to PostgREST               ─ Cache-Control
  ─ Authorization Bearer ...            ─ ETag/If-None-Match
  ─ Content-Type: application/json      ─ CORS (RN, no browser)
                                         ─ cookies
```

Zoom in: buffr's "cache" lives in SQLite (`ai_summaries` table). HTTP responses are not cached at the protocol layer. This is correct — every PostgREST response is fresh by design; LLM responses are uniquely keyed by content hash and cached server-side via the SDK or app-side via SQLite.

## Structure pass

```
  layers   ─ method ─ status ─ headers ─ body
  axes     ─ idempotency by verb
             ─ caching by header
  seams    ─ method ←→ semantic : POST = create-or-action
```

## How it works

### Move 1 — methods and idempotency

```
  GET:    safe + idempotent
  POST:   neither (in general)
  PUT:    idempotent
  PATCH:  not idempotent in general
  DELETE: idempotent

  Supabase's upsert via PATCH on a row is idempotent in practice
  because of the composite-PK + LWW (distributed-systems/03).
```

### Move 2 — status codes used

```
  200 OK             ─ most calls
  201 Created         ─ Supabase upsert sometimes
  4xx                 ─ client error (API key, validation)
  5xx                 ─ server error (Anthropic outage)
  HTTP 200 + error    ─ PostgREST's failure-as-data pattern
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ HTTP is a transport; semantic correctness lives  │
   │ in the body. PostgREST's "200 + error body" is   │
   │ idiomatic for PostgREST and what makes the silent│
   │ error guard so dangerous — must read the body,   │
   │ not just the status.                              │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

```ts
// SDK wraps the HTTP detail; buffr rarely sees raw status
const { data, error } = await supabase.from(t).upsert(rows);
// error is set even if the HTTP response was 200 + error body.
```

The orchestrator's silent-error guard (`debug-obs/01`) is *exactly* the failure to inspect the error field surfaced by this HTTP-200-with-error pattern.

## Elaborate

The CORS section is intentionally empty — RN has no browser security model. The day buffr ships a web build (PWA), CORS becomes real.

## Interview defense

**Q [mid]:** What HTTP methods does buffr use?

**A:** Mostly POST (LLM calls) and PostgREST-encoded upserts. Some GETs for cache reads.

**Q [senior]:** What about CORS?

**A:** N/A. Mobile-only; no browser. The day buffr ships web, this changes.

## Validate

### Level 1 — list the HTTP methods buffr uses.

### Level 2 — explain why the silent-error guard misses HTTP-200-with-error.

### Level 3 — apply: a web build for buffr. CORS on Supabase needs configuring.

### Level 4 — defend: "Cache LLM responses via HTTP Cache-Control." Wrong; the cache key needs to include prompt content, not URL.

## See also

- `../study-debugging-observability/01-success-only-log-guard.md`
- `../study-security/02-authentication-and-authorization.md`
- `../study-system-design/03-chain-composition-with-cache-shortcircuit.md`
