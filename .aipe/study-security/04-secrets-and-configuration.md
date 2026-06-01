# Secrets and configuration

**Industry name(s):** Secrets management, key storage, env hygiene
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

Secrets are the keys that let buffr talk to other systems — the Anthropic API key, the OpenAI API key, the Supabase URL + anon key. Where they live, who can read them, and what would happen if they leaked is one of the cheapest categories to get right and one of the most expensive to get wrong.

```
  Zoom out — where buffr's secrets live

  ┌─ device runtime ────────────────────────────────────┐
  │  expo-secure-store (Android Keystore-backed)         │
  │    ─ Anthropic API key                                │
  │    ─ OpenAI API key                                   │
  │  ★ THIS IS THE PRIMARY VAULT                         │ ← we are here
  └──────────────────────┬──────────────────────────────┘
                         │
  ┌─ build-time config ──▼──────────────────────────────┐
  │  .env / app.config.js / EAS secrets:                 │
  │    ─ Supabase URL                                    │
  │    ─ Supabase anon key (functionally a password A)   │
  └─────────────────────────────────────────────────────┘
```

The audit checks: (1) are user-typed secrets stored in SecureStore, not AsyncStorage; (2) is the Supabase anon key treated as a password (because in Phase A it functionally is); (3) do any secrets land in client bundles, source, or logs.

## Structure pass

The axis is **exposure**. Trace each secret across the layers: where is it written, where is it read, who else can see it?

```
  axis = "where can this secret be observed?"

  secret             written           read by           exposure surface
  ──────             ───────           ───────           ────────────────
  Anthropic API key  SecureStore (1×)  chain calls       device only;
                                                          OS-encrypted at rest
  OpenAI API key     SecureStore (1×)  chain calls       same
  Supabase URL       env at build      sync/client.ts    in client bundle (OK —
                                                          URL is not a secret)
  Supabase anon key  env at build      sync/client.ts    in client bundle —
                                                          ★ effectively a password
                                                            in Phase A ★
  PHASE_A_USER_ID    hardcoded in TS   sync/client.ts    in client bundle —
                                                          a single shared UUID
```

The Supabase anon key being a "password" in Phase A is the audit's load-bearing finding. The mitigation is structural (composite PK keeps cross-user isolation even if the key leaks; concept 02 walks the gate); the residual risk is "anyone with the anon key can read all rows tagged with PHASE_A_USER_ID."

## How it works

### Move 1 — the secret-storage pattern

```
  the storage ladder, cheapest → safest

  source code (NEVER for secrets)
       │
       ▼
  env / app.config (build-time; ships in client bundle if reachable)
       │
       ▼
  SecureStore / Keychain / Keystore (OS-encrypted at rest)
       │
       ▼
  remote secret manager (AWS Secrets Manager / Doppler / Vault)

  the rule: secret storage should match the secret's exposure.
   ─ user-typed API keys → SecureStore (per-device)
   ─ public URLs        → env / public config (not really secrets)
   ─ admin keys         → never in a client app
```

### Move 2 — buffr's three secrets, walked

**Anthropic + OpenAI API keys — SecureStore (correct).** The user enters API keys in the settings screen. They're written to `expo-secure-store`, which is Android Keystore-backed at rest. The chain calls read them per-request. Never logged. Never in source. This is the cheapest correct pattern; buffr does it right.

```
  src/services/ai/config.ts (the read path)

  const key = await SecureStore.getItemAsync('anthropic_api_key');
  if (!key) throw new ConfigError('API key not set');
       │
       └─ Android Keystore is the encryption gate. App uninstall
          → keys cleared. Device wipe → keys cleared. Backups
          → keys excluded by SecureStore's default policy.
```

**Supabase anon key — bundled with the app (Phase A acceptable; documented).** The anon key is a JWT signed by Supabase that authorizes the app to use the public API. It's not secret in the cryptographic sense — every Supabase JS client embeds it. But in Phase A, when buffr authenticates with the anon key and stamps a hardcoded `PHASE_A_USER_ID`, the anon key is *functionally* the access credential. Anyone with the key (and knowing they need to query with the right user_id) can read every Phase-A row.

The mitigation is the composite-PK schema gate (concept 02 — cross-user isolation is structural, not key-dependent). The Phase B mitigation flips the runtime gate on so even the anon key alone returns nothing without a real JWT.

**`PHASE_A_USER_ID` — a constant in source.** This is the per-device user identity in Phase A. Anyone reading the source (decompiled APK, GitHub) sees the same UUID. Not a secret; it's a placeholder. Phase B replaces it with `auth.uid()`.

### Move 3 — the principle

Secrets storage cost scales with what a leak would mean. User-typed API keys → SecureStore (per-device, OS-encrypted). Public-but-functionally-load-bearing keys (the Supabase anon key in Phase A) → bundled, with the structural gate (composite PK) as the actual access defense. Hardcoded constants in source → only acceptable when not actually secret (`PHASE_A_USER_ID`).

## Primary diagram

```
  buffr's secrets scorecard

  CORRECT
   ─ Anthropic API key   → expo-secure-store      ✓
   ─ OpenAI API key      → expo-secure-store      ✓

  ACCEPTED (with documented mitigation)
   ─ Supabase anon key   → client bundle           ◐
     (Phase A: functionally password;
      mitigation: composite PK as access gate)
   ─ PHASE_A_USER_ID     → hardcoded constant     ◐
     (placeholder for Phase B auth.uid())

  CHECK ITEMS (verify before each release)
   ─ no secrets in console.log               (grep before ship)
   ─ no secrets in committed .env files       (.gitignore covers .env)
   ─ no secrets in client error messages      (sanitize errors at boundary)
```

## Implementation in codebase

### The right pattern — SecureStore

```
  src/services/ai/config.ts (~L30, the read)

  export async function getAnthropicKey(): Promise<string> {
    const key = await SecureStore.getItemAsync(KEY_NAMES.ANTHROPIC);
    if (!key) throw new ConfigError('Anthropic key not configured');
    return key;
  }
       │
       └─ SecureStore.getItemAsync is async because Android Keystore is
          a system service. The key never lives in plain memory longer
          than the chain call. Never logged.
```

### The accepted risk — anon key in the bundle

```
  src/services/sync/client.ts (~L20, the Supabase client setup)

  const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!;
  const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;
  //                                              ★ bundled at build time

  export const supabase = createClient<Database>(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      auth: { persistSession: false },             ← ★ no session = anon key
      db: { schema: 'buffr' }                       ──  is the only auth
    }
  );
       │
       └─ Phase A acceptance: the composite PK is the structural gate
          (concept 02). The Supabase URL and anon key are public-but-
          functionally-password in Phase A; documented as such.
```

## Elaborate

Secret management gets simpler the more layers of defense you build around the secret. SecureStore is the device-side win (OS encryption + uninstall-cleared lifecycle); composite PKs are the cloud-side structural gate; Phase B's RLS is the runtime gate that makes the anon key no-longer-a-password. The full ladder is: structural defense → runtime defense → OS-encrypted storage → never-in-source. Buffr is on rungs 1, 3, and 4; rung 2 ships with Phase B.

## Interview defense

**Q [mid]:** Where do buffr's API keys live?

**A:** `expo-secure-store`, which is backed by Android Keystore. The keys are encrypted at rest by the OS, never in source, never logged, cleared on app uninstall. The Supabase anon key is bundled at build time because it's a public-but-functionally-load-bearing key — anyone who decompiles the APK sees it. In Phase A that's effectively a password; the composite-PK schema gate is the mitigation that makes a leak survivable (concept 02).

```
  the storage ladder, marked

  SecureStore (Android Keystore)  ✓  Anthropic + OpenAI keys
  Client bundle                    ◐  Supabase anon key (Phase A; PK gate covers)
  Source code                      ✗  no secrets here

  one-line anchor: "structural defense at the cloud, OS storage at the device"
```

**Q [senior]:** Why is the Supabase anon key bundled instead of in SecureStore?

**A:** It's not really secret — every Supabase client embeds it; it's a JWT signed by Supabase that just says "you're using this project." The functional-password problem in Phase A comes from authenticating with *only* the anon key (no real user session), so anyone with the key can read all rows tagged with the hardcoded user_id. The fix isn't moving the key — it's flipping the runtime gate on (Phase B's RLS enable), which makes the anon key alone return nothing.

**Q [arch]:** What changes in Phase B for secret management?

**A:** Two things. (1) Supabase Auth issues a JWT per logged-in user; the anon key is supplemented (not replaced) by a per-user token. The user-side token is stored in SecureStore. (2) RLS enables on every synced table; the anon key alone returns zero rows. The result is that a leaked anon key in Phase B does nothing on its own — the JWT is required to query anything.

## Validate

### Level 1 — reconstruct the diagram

Sketch buffr's three secrets and where each lives, with one mark of correctness per row.

### Level 2 — explain it out loud

Under 90 seconds: explain why SecureStore is the right choice for API keys but the anon key is bundled, and why that's acceptable.

### Level 3 — apply to a new scenario

A new feature: buffr should integrate with a third-party calendar API. Where does the OAuth refresh token live, and why?

Open `src/services/ai/config.ts` (the SecureStore read path) and verify against the pattern.

### Level 4 — defend the decision

Defend or oppose: "The Supabase anon key should be loaded from a remote config endpoint at startup, not bundled, so it can be rotated without releasing a new APK."

Reference `src/services/sync/client.ts` (the bundled anon key) and the Phase B activation walk in concept 02.

## See also

- [`02-authentication-and-authorization.md`](./02-authentication-and-authorization.md) — the PK gate + Phase B RLS that make the anon key acceptable in Phase A.
- [`05-data-exposure-and-privacy.md`](./05-data-exposure-and-privacy.md) — what's exposed if a key leaks.
- [`08-security-red-flags-audit.md`](./08-security-red-flags-audit.md) — secrets-in-source, secrets-in-logs as checklist items.
