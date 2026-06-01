# Dependencies and supply chain

**Industry name(s):** Software supply chain, transitive deps, lockfile hygiene, postinstall risk
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

Every dependency is code you didn't write but ship anyway. Supply-chain risk is the chain of trust: the package you `npm install`, its dependencies, their dependencies, and the build steps each runs. The audit asks: are deps pinned (lockfile), audited (npm audit / known CVEs), updated (current vs frozen), and bounded (postinstall scripts under control)?

```
  Zoom out — buffr's dep stack

  ┌─ buffr (src/, app/) ─────────────────────────────┐
  │  imports ↓                                       │
  └─────────────────────┬────────────────────────────┘
                        │
  ┌─ direct deps (package.json) ─────────────────────┐
  │  react-native 0.83.2  expo SDK 55                 │
  │  @supabase/supabase-js  expo-sqlite expo-secure-store│
  │  @anthropic-ai/sdk   @wokcito/ffmpeg-kit-react-native│
  │  react-native-{reanimated,video,gesture-handler,...}│
  └─────────────────────┬────────────────────────────┘
                        │  transitive deps
                        ▼
  ┌─ ~hundreds of transitive packages ──────────────┐
  │  pinned via package-lock.json (npm)              │
  └──────────────────────────────────────────────────┘
```

The audit checks: lockfile present, direct deps current, niche deps named explicitly (some have higher supply-chain risk), CVE posture, postinstall script discipline.

## Structure pass

The axis is **trust delegation** — every dep is a trust delegation; how broad is each?

```
  axis = "how much do I trust this dep, and how badly does breaking it hurt?"

  dep                            trust scope                impact if compromised
  ───                            ───────────                ─────────────────────
  react / react-native           huge community, audited     entire UI
  expo SDK                       huge, audited                build + runtime
  @supabase/supabase-js          first-party (Supabase)       sync engine
  @anthropic-ai/sdk              first-party (Anthropic)      AI chains
  expo-sqlite, secure-store      first-party (Expo)           local storage
  @wokcito/ffmpeg-kit-react-     niche, less-audited         ★ video pipeline
    native                                                     supply-chain risk
  react-native-{reanimated,...}  large RN community           UI animations
```

Most deps are first-party (Anthropic, Supabase, Expo) or huge-community (React Native, Reanimated). The audit's one named-risk dep is the ffmpeg wrapper.

## How it works

### Move 1 — the supply-chain pattern

```
  every dep is a trust chain

  buffr  ─►  dep A  ─►  dep B  ─►  dep C
              │           │           │
              ▼           ▼           ▼
            postinstall  postinstall  postinstall
            scripts run  scripts run  scripts run
                                                  (at install time)

  the fix shape:
   ─ pin (lockfile) so every install gets the same chain
   ─ audit (npm audit / Snyk / Dependabot) for known CVEs
   ─ update (regular, not heroic) so deps don't freeze
   ─ minimize (don't pull in deps for one-line utilities)
```

### Move 2 — buffr's supply-chain posture

**Lockfile — present.** `package-lock.json` pins every transitive version. Anyone running `npm install` gets the same dep tree as production. Good.

**Direct dep currency — current.** Expo SDK 55, React Native 0.83.2, TypeScript 5.9, @supabase/supabase-js ^2.105 — all 2025-current versions. No frozen-3-years-ago dep visible.

**Niche dep — `@wokcito/ffmpeg-kit-react-native` 6.1.2.** ffmpeg-kit-react-native (the original) was archived; `@wokcito/...` is a community fork. Smaller maintainer base means slower security response, and the package executes ffmpeg binaries — high-impact if the binary or wrapper is compromised. The audit names this as a known supply-chain risk and a buffr-specific reason to monitor that package.

```
  the ffmpeg dep — supply-chain risk note

  package: @wokcito/ffmpeg-kit-react-native 6.1.2
  what it does: bundles ffmpeg binary + RN bridge for transcode/export
  risk: smaller maintainer; bundles a native binary; high-impact if either
        the JS wrapper or the binary chain is compromised
  mitigation:
   ─ pin (✓ done via lockfile)
   ─ watch for upstream advisories
   ─ Phase B: consider alternate libs (or revisit native bridge) if
     advisories pile up
```

**CVE posture — manual today.** No automated `npm audit` in CI; no Dependabot. The audit's recommendation: enable Dependabot on the repo or `npm audit --production` as a release gate. Low-effort wins.

**Postinstall scripts — Expo-managed.** Expo handles native module postinstalls (autolinking). No custom postinstall in `package.json`. Reduces postinstall attack surface to whatever Expo / RN / native modules ship.

### Move 3 — the principle

Lockfile + currency + audit + minimization. Buffr is good on the first two (lockfile present; deps current), weak on the third (no automated CVE check), and average on the fourth (the ffmpeg dep is niche but justified). The cheapest fix is automated CVE scanning; the longest-tail watch item is the ffmpeg dep.

## Primary diagram

```
  buffr's supply-chain scorecard

  STRONG
   ─ lockfile present and committed                       ✓
   ─ direct deps current (Expo 55, RN 0.83.2, TS 5.9)     ✓
   ─ no custom postinstall scripts                         ✓
   ─ first-party deps for primary surfaces (Supabase,      ✓
     Anthropic, Expo)

  GAP — easy fix
   ─ no automated CVE scanning in CI                       ◐
     fix: enable Dependabot or `npm audit --production`
     as a release gate

  WATCH
   ─ @wokcito/ffmpeg-kit-react-native (niche maintainer +  ◐
     bundles native binary)
     mitigation: pin + monitor advisories
```

## Implementation in codebase

### The lockfile — present and pinning

```
  package-lock.json  (root, committed)

  every transitive version pinned; reproducible installs across
  every dev box and CI.
       │
       └─ no lockfile = the spread between dev and prod widens
          with every install. buffr commits the lockfile = ✓.
```

### The Dependabot / npm audit recommendation

```
  proposed: .github/dependabot.yml (file does not exist yet)

  version: 2
  updates:
    - package-ecosystem: npm
      directory: /
      schedule:
        interval: weekly
       │
       └─ once enabled, GitHub opens PRs for vulnerable deps automatically.
          low effort; high signal.

  or: in CI, add a step
    npm audit --production --audit-level=high
       │
       └─ fails the build if a high-severity CVE is unpatched.
```

## Elaborate

Supply-chain risk has moved up the OWASP Top 10 ladder consistently since 2017. The two highest-leverage moves are pinning (lockfile) and currency-with-automation (Dependabot). Buffr already does pinning; the audit's only real recommendation is enabling Dependabot, which is a 5-minute configuration with ongoing payback.

For the niche ffmpeg dep, the watch is justified by the package shape (community fork bundling a native binary) but not by any current advisory. Monitoring is the action; replacing isn't justified yet.

## Interview defense

**Q [mid]:** What's buffr's supply-chain posture?

**A:** Pinned (lockfile committed), current (Expo 55, RN 0.83.2, TS 5.9 — 2025-current), no custom postinstall scripts. The one watch is `@wokcito/ffmpeg-kit-react-native`, a niche community fork that bundles a native binary — smaller maintainer base, higher impact if anything goes wrong. The one easy fix is enabling Dependabot or `npm audit` in CI; currently CVE checking is manual.

```
  the posture, marked

  lockfile committed                     ✓
  direct deps current                    ✓
  no custom postinstall                  ✓
  Dependabot / npm audit in CI            ◐ ← fix next
  niche binary-bundling dep              ◐ ← monitor

  one-line anchor: "pin everything; automate the CVE check"
```

**Q [senior]:** Why is the ffmpeg dep a higher-risk than the others?

**A:** Two reasons. (1) `@wokcito/ffmpeg-kit-react-native` is a community fork of the original ffmpeg-kit-react-native (which was archived). Smaller maintainer = slower security response. (2) The package bundles a native ffmpeg binary; a compromise at either the JS wrapper or the binary chain has high impact. The mitigation is monitoring + pinning; replacing isn't justified by any current advisory, but it's the dep most worth watching.

**Q [arch]:** How would you reduce supply-chain risk further?

**A:** Three escalating moves. (1) Enable Dependabot — 5-minute config. (2) Add `npm audit --production --audit-level=high` as a CI gate — fails the build on high-severity CVEs. (3) Use a Software Bill of Materials (SBOM) generator and track changes per release. Most repos at buffr's scale stop at (1) and (2); (3) is overkill until there's a security-audit requirement.

## Validate

### Level 1 — reconstruct the diagram

Sketch the supply-chain posture (lockfile / currency / audit / postinstall) with buffr's mark per row.

### Level 2 — explain it out loud

Under 90 seconds: name the strong points and the one easy fix.

### Level 3 — apply to a new scenario

A new contributor proposes adding a small utility package (`is-odd`, hypothetical) as a dep. Walk the audit conversation.

Reference `package.json` (existing direct deps) for the bar.

### Level 4 — defend the decision

Defend or oppose: "We should replace the ffmpeg dep with our own native module so we control the supply chain entirely."

Reference the ffmpeg-kit-react-native role in `src/services/ffmpeg.ts` / `exportPipeline.ts`.

## See also

- [`08-security-red-flags-audit.md`](./08-security-red-flags-audit.md) — supply-chain items as checklist entries.
