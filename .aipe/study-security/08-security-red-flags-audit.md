# Security red flags audit — the consolidated checklist

**Industry name(s):** Security review checklist, threat-model walk
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

The consolidated security checklist for buffr — every red flag from the seven prior concepts, marked against this repo: fires, doesn't fire, or N/A. Each marked finding cites a file:line and a one-line fix. This is the capstone: the index a code reviewer opens alongside any change touching auth, data flow, secrets, deps, or LLM/agent surfaces.

```
  Zoom out — the audit's findings rolled into one map

  ┌─ overall posture ─────────────────────────────────────────┐
  │  Phase A — solo, single-user, fingerprint-locked phone.    │
  │  Schema gate (composite PK) carries the access boundary.   │
  │  Runtime gate (RLS) defined + disabled (by 0009).          │
  │  AI chains use structured-output defense; no agents, no    │
  │  tools, no RAG ─ Phase A's narrow LLM threat model.        │
  │  Anthropic+OpenAI keys in SecureStore. Lockfile committed. │
  └────────────────────────────────────────────────────────────┘

  THE TOP THREE FIXES (ranked by severity)
   1. sync/orchestrator.ts:49,72 — silent-error guard
      (high severity — already documented as a SOFTWARE-design finding;
       it's a security finding too because it masks a security-relevant
       failure class: PostgREST denies as data, not exceptions)
   2. enable Dependabot / npm audit CI gate
      (low effort; immediate signal on new CVEs)
   3. (Phase A acceptable) document the Phase B activation order:
      auth UI → backfill → flip RLS ENABLE
      to prevent re-running the 0009 incident in reverse
```

## Structure pass

The axis is **severity** — for each red flag that fires, who is positioned to catch it?

```
  axis = "what's the cost of this red flag firing in production?"

  HIGH   — already-fired incidents; recurring class
  MED    — present but mitigated; would matter in Phase B
  LOW    — low-impact items; cheap to fix
  N/A    — surface absent in this codebase
```

## How it works

### Move 1 — the checklist shape

```
  one row per red flag

  flag name              fires?    location          severity   fix
  ────────────           ──────    ────────          ────────   ───
  silent-error guard     ✓ HIGH    orchestrator:49,72  HIGH      log on r.error
  PII in logs            ✗ N/A     audit grep ok        ─         release-gate grep
  anon key as password   ◐ MED     Phase A bundle        MED       Phase B RLS
  RLS off                ◐ MED     0009 (intentional)    MED       Phase B + auth
  prompt injection       ◐ MED     Phase A narrow        MED       Phase B wrap
  ...
```

### Move 2 — the consolidated scorecard

**Authn / authz**

| Flag | Fires? | Location | Severity | Fix |
|---|---|---|---|---|
| Endpoint checks logged-in but not allowed | N/A | no per-resource authz today; composite PK is the structural gate | — | Phase B RLS enable |
| Anon key as functional password | ◐ MED | `src/services/sync/client.ts` (anon-key + `persistSession: false`) | MED | Phase B RLS + Supabase Auth |
| RLS off in production | ◐ MED | committed in `0009_disable_rls_phase_a.sql` (intentional Phase A) | MED | Phase B activation (concept 02) |
| Dashboard toggle could re-enable RLS without auth (the 0009 incident class) | ✗ | mitigated by codifying disable in 0009 migration | — | order Phase B activation correctly |

**Input validation / injection**

| Flag | Fires? | Location | Severity | Fix |
|---|---|---|---|---|
| String-built SQL query with user input | ✗ N/A | expo-sqlite parameterized API throughout | — | maintain pattern |
| Unsanitized user prose into LLM prompt | ◐ MED | `src/services/ai/{summarize,caption,expand,classify,interpret}.ts` | MED (Phase B) | wrap in `<entry>` delimiters; system prompt instructs treating as data |
| Path traversal | ✗ N/A | URIs from MediaLibrary (OS-mediated) | — | maintain pattern |
| XSS in DOM | ✗ N/A | React Native Text doesn't interpret HTML/JS | — | — |

**Secrets / configuration**

| Flag | Fires? | Location | Severity | Fix |
|---|---|---|---|---|
| Secret in source | ✗ N/A | API keys in SecureStore; no secrets committed | — | maintain pattern |
| Secret in client bundle | ◐ LOW | Supabase anon key (bundled; Phase A accepted) | LOW | covered by Phase B RLS (concept 02, 04) |
| Secret in logs | ✗ N/A | orchestrator logs counts + table names, not content | — | release-gate grep for `console.log` interpolating entity fields |

**Data exposure / privacy**

| Flag | Fires? | Location | Severity | Fix |
|---|---|---|---|---|
| PII / entry text in logs | ✗ AUDIT TARGET | grep before each release | — | add CI step: `grep -r 'console.log.*entry\.text\|entries\.text' src/` |
| Verbose error message to UI | ✗ AUDIT TARGET | unverified; centralize error formatting if a leak is found | — | `formatErrorForUser(err) → UserMessage` in one place |
| Silent sync error (data integrity surface) | ✓ HIGH | `orchestrator.ts:49,72` | HIGH | `\|\| r.error` on the log guard (also software-design finding) |

**Dependencies / supply chain**

| Flag | Fires? | Location | Severity | Fix |
|---|---|---|---|---|
| No lockfile | ✗ N/A | `package-lock.json` committed | — | maintain pattern |
| No automated CVE check | ✓ LOW | no Dependabot / npm audit CI | LOW | enable Dependabot (`.github/dependabot.yml`) or `npm audit --production --audit-level=high` in CI |
| Niche dep / community fork bundling native binary | ✓ WATCH | `@wokcito/ffmpeg-kit-react-native 6.1.2` | WATCH | monitor advisories |
| Custom postinstall scripts | ✗ N/A | no custom postinstall in package.json | — | — |

**LLM / agent security**

| Flag | Fires? | Location | Severity | Fix |
|---|---|---|---|---|
| Agent with broader tool scope than task | ✗ N/A | no agents, no tools | — | maintain — see study-agent-architecture |
| LLM output flowing into code path | ✗ N/A | outputs land in `ai_summaries` data cache | — | maintain pattern (concept 07) |
| Unwrapped user content in prompt | ◐ MED (Phase B) | chain interpolation | MED | wrap in `<entry>` delimiters at Phase B |
| No output validation | ✗ N/A | `validate.ts` Zod re-check on every chain output | — | maintain pattern |

### Move 3 — the principle

A red-flags checklist is a code-review accelerator, not a perfection target. Walk the list with each PR touching the marked surfaces; fix HIGH first, MED on a roadmap, LOW when convenient. Buffr's high-severity item is one line at one location (the silent-error guard); the medium-severity items are Phase B blockers; the low-severity item is a 5-minute Dependabot config.

## Primary diagram

```
  buffr's security scorecard — at a glance

  HIGH SEVERITY (fix next)
   ─ ★ silent-error guard at orchestrator.ts:49,72
     fix: `|| r.error` on the log guard
     impact: prevents the next silent sync freeze (security-relevant
             because PostgREST denies as data, not exceptions)

  MED SEVERITY (Phase B blockers — sequence with auth UI)
   ─ Anon key functions as password (mitigated by composite PK gate)
   ─ RLS off (intentional Phase A; activated as part of Phase B)
   ─ Prompt-site delimiter wrapping (Phase B widens the surface)

  LOW SEVERITY (easy wins)
   ─ Enable Dependabot or `npm audit` CI gate
   ─ Add release-gate grep for PII in console.log

  WATCH
   ─ @wokcito/ffmpeg-kit-react-native (community fork w/ native binary)
   ─ Centralize error-to-UI translation (sanitize at one boundary)

  PRAISE FINDINGS (the strong parts)
   ─ Composite-PK schema gate (always-on access boundary)
   ─ SecureStore for user-typed API keys
   ─ Tool-calling schema + validate.ts for LLM output
   ─ Side-effect isolation (LLM outputs are data, never code)
   ─ Lockfile committed; deps current
```

## Implementation in codebase

### The top 3 fixes, ranked

```
  1. orchestrator.ts:49,72  → log on r.error
      HIGH severity. 10 lines. Same fix as software-design concept 01.
      Stops the next silent sync freeze.

  2. .github/dependabot.yml (new) → enable weekly npm scans
      LOW severity. 5-minute config. Ongoing payback.

  3. Document Phase B activation order in docs/spec.md
      (auth UI → backfill → flip RLS ENABLE)
      MED severity. Prevents re-running the 0009 incident in reverse
      (enabling RLS before auth.uid() returns a real user).
```

## Elaborate

A security checklist works as code-review acceleration, not as a perfection bar. Walk it with each PR touching the marked surfaces; let the rest accumulate until the cost is felt. Buffr's strong defenses (structural schema gate, SecureStore, tool-calling output enforcement, side-effect isolation, lockfile) cover the high-impact failures. The mediums all have a forcing function (Phase B); the lows are 5-minute fixes.

For each finding's deeper context, see the originating concept file. This page is the index; the depth lives in concepts 01–07.

## Interview defense

**Q [mid]:** What's the worst security risk in this codebase right now?

**A:** The silent-error guard in `src/services/sync/orchestrator.ts:49,72`. It hid two production sync failures by treating errors-as-data as zero-activity events. The fix is `|| r.error` on the log guard — ten lines, immediate impact, same fix as the software-design audit's top finding. It's a security finding because the masked failures included an RLS-misconfiguration freeze (the 0009 incident) — exactly the security-relevant failure class that should be loudest.

```
  the top finding, one diagram

  before:  if (succeeded || failed) log(...)         ← HIDES error-as-data
  after:   if (succeeded || failed || r.error) log(...)

  prevents the next silent freeze.
  HIGH severity for a reason.

  one-line anchor: "silent failure at a security boundary IS the bug"
```

**Q [senior]:** Walk the Phase B blockers.

**A:** Three medium-severity items must sequence with Phase B's auth UI: (1) Supabase Auth issues real JWTs so `auth.uid()` returns a user, (2) one-time backfill rewrites Phase-A rows' user_id to the authenticated UUID, (3) a new migration flips RLS to ENABLE. Order matters — doing (3) before (1) reproduces the 0009 silent freeze. The audit's job is to document this order in `docs/spec.md` so the activation can't happen out of order.

**Q [arch]:** What's the strongest defense buffr has?

**A:** The composite-PK schema gate. It's structural — the row literally doesn't exist for the wrong (user_id, id) pair. It doesn't depend on a policy being right, on `auth.uid()` returning a value, on RLS being enabled. It held throughout the 0009 incident; it held while RLS was off; it would hold if every other gate failed. That's defense-in-depth's strongest property: the gate that doesn't depend on the others.

## Validate

### Level 1 — reconstruct the diagram

Sketch the severity ladder (HIGH → MED → LOW → WATCH → N/A) and place the audit's top three fixes.

### Level 2 — explain it out loud

Under 90 seconds: name the highest-severity finding, the fix, and one Phase B blocker.

### Level 3 — apply to a new scenario

A new PR adds a Supabase Realtime subscription that watches for new entries. Walk the checklist — which flags would you check against the diff?

Reference `src/services/sync/orchestrator.ts:49,72` and `src/services/sync/client.ts`.

### Level 4 — defend the decision

Defend or oppose: "The Phase B blockers are too distant to plan around. Just rewrite auth when the first non-me user installs."

Reference the 0009 incident (the empirical proof that activation order matters) and concept 02's Phase A/B walk.

## See also

- [`01-trust-boundaries-and-attack-surface.md`](./01-trust-boundaries-and-attack-surface.md) — the boundary map.
- [`02-authentication-and-authorization.md`](./02-authentication-and-authorization.md) — the 0009 incident in detail.
- [`07-llm-and-agent-security.md`](./07-llm-and-agent-security.md) — the LLM-side scorecard.
- `.aipe/study-software-design/08-red-flags-audit.md` — the software-design scorecard (the silent-error finding is the same).
