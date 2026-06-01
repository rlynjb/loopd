# buffr — security audit

A security audit of **buffr** through the trust axis: what an attacker can reach, who's allowed past each boundary, what's hidden vs exposed, and what dependencies drag in. Findings are grounded in real files. Where buffr's design holds the boundary, the audit names where; where it doesn't (or where the design accepts a documented risk), the audit names the file, the trust assumption, and the fix.

## The through-line

> The only question — what can an attacker reach, and what happens when they do?

Every finding ties to one trust assumption — which boundary, whether it holds, what breaks if it's wrong. The audit is **defensive**: it names weaknesses and fixes; it does not write exploit code.

## Reading order

```
  the audit in eight concepts, ordered by where the attacker hits first

  01 trust-boundaries-and-attack-surface  ─ the zoom-out: map every place
                                            untrusted input enters trusted code
       │
       ▼
  02 authentication-and-authorization     ─ who-are-you vs what-can-you-do
                                            (Phase A posture; 0009 incident)
       │
       ▼
  03 input-validation-and-injection       ─ SQL / prompt / path / SSRF / XSS
       │
       ▼
  04 secrets-and-configuration            ─ API keys, .env, client bundles
       │
       ▼
  05 data-exposure-and-privacy             ─ PII surfaces, error verbosity
       │
       ▼
  06 dependencies-and-supply-chain         ─ lockfile, CVEs, transitive bloat
       │
       ▼
  07 llm-and-agent-security                ─ prompt injection, output as code
                                            (single-user threat model today)
       │
       ▼
  08 security-red-flags-audit              ─ consolidated checklist
                                            (the capstone)
```

## What this guide is, and isn't

- **What it is:** a defensive audit of buffr's current trust assumptions. Real files, real boundaries, the fix in one line per finding.
- **What it isn't:** an exploit guide. No working attack code. The audit names the weakness, the assumption it breaks, and the move; it doesn't demonstrate how to abuse it.

## Where this sits vs other guides

This is the **trust axis** as a discipline. System architecture (sync engine choice, conflict-resolution rule) lives in `.aipe/study-system-design-dsa/`; complexity / module design (deep modules, leakage) lives in `.aipe/study-software-design/`. A finding about *who may read/write data and how that's enforced* belongs here; a finding about *how data is structured* belongs to data-modeling.

Cross-references — where security findings touch other guides:

- The 0009 RLS-drift incident: full system context in `.aipe/study-system-design-dsa/01-system-design/02-authentication-boundary.md`.
- LLM chain shape (prompt construction, validate.ts): mechanics in `.aipe/study-ai-engineering/01-llm-foundations/04-structured-outputs.md`.

## buffr's headline trust posture

> **Phase A — solo single-user; anon-key + hardcoded user_id is the entire access boundary.** The composite `(user_id, id)` PK is the always-on schema gate that doesn't depend on a policy being correct. RLS exists as defined policies (migration 0002) but is currently disabled by migration 0009 after a production drift incident. The threat model is "me, my phone, my fingerprint lock" — and that bound is named at every finding here.

This is documented in `.aipe/project/context.md` and in `docs/spec.md` §10. The audit's job is to name where that posture holds, where it has gaps (device-loss is uncovered), and what would need to change for Phase B (real auth + RLS enable).
