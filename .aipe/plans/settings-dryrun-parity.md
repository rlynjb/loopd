# Plan — Settings page parity with dryrun + Gemma local-only + LLM progress loader

**Status:** drafted 2026-06-17
**Reference:** `../dryrun/app/src/main/java/com/dryrun/app/ui/settings/SettingsScreen.kt`,
`../dryrun/app/src/main/java/com/dryrun/app/ai/LlmProgress.kt`,
`../dryrun/app/src/main/java/com/dryrun/app/ui/common/LlmProgressTracker.kt`

## The decision

Three changes, ship as one logical refactor:

1. **Gemma is on-device only.** Drop the Together cloud-Gemma path entirely. Cloud = Anthropic primary + OpenAI fallback. On-device = Gemma via llama.rn.
2. **Tabbed Settings page** matching dryrun's structure (Routing / On-Device / Anthropic / OpenAI / Cloud Sync). Per-chain routing chips replace the global provider toggle.
3. **LlmProgressLoader** — live phase / token / elapsed-time loader for in-flight chain calls. Ported from dryrun's `LlmProgressTracker` (StateFlow → React state + 250ms timer).

## The new mental model

```
  per chain:  "on-device"  OR  "cloud"

  on-device  =  Gemma 3 4B local (llama.rn)
                falls back to cloud unless strict-local

  cloud      =  Anthropic primary
                OpenAI fallback on transient failure
                (mirrors dryrun's primary/fallback pattern)

  strict-local mode (global)  =  disable cloud entirely; on-device or fail
```

Per-chain routing lives in SecureStore as four keys:
`route_summarize`, `route_caption`, `route_interpret`, `route_classify`. Default `'cloud'`.

## What gets removed

| Code | File | Reason |
|---|---|---|
| `callGemmaCloud`, `GEMMA_CLOUD_MODEL`, `TOGETHER_ENDPOINT` | `providers/gemma.ts` | Gemma is on-device only |
| `getGemmaCloudKey` / `setGemmaCloudKey` / `clearGemmaCloudKey`, `KEY_GEMMA_CLOUD` | `config.ts` | no Together key needed |
| `'gemma'` from `AIProvider` union | `config.ts` | AIProvider becomes `'claude' \| 'openai'` (cloud picker only) |
| Cloud-Gemma branches in `runSummarizeLLM`, `runInterpretLLM`, `runCaptionLLM`, classify cascade | 4 chain files | not in the routing model anymore |
| "Gemma" button + Together API key input + "TOGETHER API KEY" label | `settings/ai.tsx` | replaced by per-chain Routing tab |
| `predictClassifyProvider`'s gemma-cloud check | `classify.ts` | only on-device for gemma now |

## What gets refactored

### `config.ts`
- `AIProvider` narrows to `'claude' \| 'openai'`. This is the *cloud picker only* — used for "when cloud, which cloud is primary?"
- New `RouteChoice = 'on-device' \| 'cloud'` type.
- Per-chain route getters/setters: `getChainRoute(chain)` / `setChainRoute(chain, route)`. Default `'cloud'`.
- `getCloudPrimary()` / `setCloudPrimary()` — picks Anthropic or OpenAI as the primary cloud provider. Default `'claude'`. Reuses `KEY_PROVIDER` (already there).

### `providers/gemma.ts`
- Delete all Together-related code (`callGemmaCloud`, `GEMMA_CLOUD_MODEL`, `TOGETHER_ENDPOINT`).
- Keep everything else: `callGemmaLocal`, model path, download/delete, KV warm, latency probe.
- `GEMMA_LOCAL_MODEL` constant stays (used by chain return paths to record served model).

### New: `providers/cloud.ts`
Single shared helper that mirrors dryrun's "primary cloud + fallback":

```ts
export type CloudCallParams = {
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  onProgress?: (p: LlmProgress) => void;
};

export type CloudCallResult = { text: string; model: string };

// Calls primary (Anthropic or OpenAI per getCloudPrimary());
// on rejection that looks transient, tries the other one.
export async function callCloud(params: CloudCallParams): Promise<CloudCallResult>;
```

Internally: `callClaudeWithProgress` and `callOpenAIWithProgress` private helpers, each one calling the existing SDKs and emitting a single `done: true` `LlmProgress` event after parsing the response (cloud doesn't stream in the current implementation).

### 4 chain files
Each chain's `runXxxLLM` helper simplifies:

```ts
async function runSummarizeLLM(strictLocal, system, user, onProgress): Promise<{text, model}> {
  const route = await getChainRoute('summarize');
  
  // Strict-local override: always on-device.
  // Or route === 'on-device': try local, fall back to cloud unless strict.
  if (strictLocal || route === 'on-device') {
    if (await shouldUseGemmaLocal('summarize')) {
      try {
        const text = await callGemmaLocal('summarize', system, user, MAX_TOKENS, undefined, onProgress);
        return { text, model: GEMMA_LOCAL_MODEL };
      } catch (err) {
        if (strictLocal) throw err;
        // fall through to cloud
      }
    } else if (strictLocal) {
      throw new Error('Strict local mode: on-device AI not ready');
    }
  }
  
  // Cloud path
  return callCloud({ system, user, maxTokens: MAX_TOKENS, onProgress });
}
```

Smaller helper, one routing decision, no triple-branch chain. Each chain still exposes its prior signature (`onProgress` becomes a new optional param).

Classify's cascade simplifies too:
```
strict-local: gemma-local OR fail
on-device:    gemma-local → cloud(Anthropic primary, OpenAI fallback)
cloud:        cloud(Anthropic primary, OpenAI fallback)
```

### `cache.ts`
- `CacheKeyInput.provider` semantic change: now `'on-device' \| 'cloud'` rather than specific model name.
- `predictClassifyProvider` becomes `predictClassifyRoute` returning `RouteChoice`.
- One-shot migration path: bump `PROMPT_VERSION` in all 4 chains so old cache rows naturally expire.

## What gets added

### `LlmProgress.ts` + `LlmProgressTracker.ts` (or one combined file)
React-port of dryrun's tracker. Same fields:

```ts
export type LlmProgress = {
  phase: string;        // human-readable label like "Analyzing"
  inputTokens?: number;
  outputTokens?: number;
  estimated?: boolean;  // false if exact, true if estimate
  done?: boolean;
};

export type LlmLoadState = {
  phase: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  elapsedMs: number;
  done: boolean;
};
```

The tracker is a small class or hook:

```ts
export function useLlmProgressTracker(): {
  state: LlmLoadState | null;
  track<T>(label: string, block: (onProgress: (p: LlmProgress) => void) => Promise<T>): Promise<T>;
  clear: () => void;
};
```

Mirrors dryrun's behavior:
- `track(label, block)` starts a 250ms timer, calls block with the onProgress callback
- Block's onProgress emissions fold into state via React's setState
- On settle (success/throw) marks `done: true` and stops the timer
- `clear()` resets to null

### `callGemmaLocal` emits progress
llama.rn's `context.completion` accepts a callback `(data) => { const { token } = data; }` for streaming. Wire this to emit `LlmProgress` events with `outputTokens` climbing. Final emission has `done: true` and final exact counts.

```ts
export async function callGemmaLocal(
  chain: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature?: number,
  onProgress?: (p: LlmProgress) => void,
): Promise<string> {
  const ctx = await getLlamaContext();
  const start = Date.now();
  let outputTokens = 0;
  const result = await ctx.completion({
    messages: [/* ... */],
    n_predict: maxTokens,
    ...(temperature !== undefined ? { temperature } : {}),
    stop: [/* ... */],
  }, (data) => {
    if (data?.token) {
      outputTokens++;
      onProgress?.({ phase: chain, outputTokens, estimated: true });
    }
  });
  const elapsed = Date.now() - start;
  await updateGemmaLocalProbe(chain, elapsed);
  onProgress?.({ phase: chain, outputTokens, estimated: false, done: true });
  return result.text ?? '';
}
```

### `callCloud` emits progress
Single `done: true` event after the request completes — cloud doesn't stream in this implementation. Phase string carries chain name.

### Settings UI restructure — `settings/ai.tsx`
Five tabs matching dryrun's layout:

| Tab | Content |
|---|---|
| **Routing** | Four per-chain rows (`summarize`, `caption`, `interpret`, `classify`). Each: title + description + on-device/cloud chip pair. On-device chip disabled when device class is 'disabled' or model not downloaded. Strict-local toggle below the rows. |
| **On-Device** | Device class + RAM. Model status state (NotDownloaded / Downloading / Ready / Error). Download / Remove buttons. Stats: per-chain auto-skip status (from latency probe), reset-skip button. |
| **Anthropic** | Key field with show/hide eye toggle. Save / Clear / Test Connection. One-line description. |
| **OpenAI** | Same shape (fallback). |
| **Cloud Sync** | The existing cloud-sync content. |

Visual primitives needed:
- `Tabs` component — RN doesn't ship one; pick a small lib or hand-roll. Hand-roll: a horizontal scrolling row of pressables matching the existing `providerRow` style.
- `Chip` component — two-button row using existing `providerBtn` / `providerBtnActive` styles.
- `KeyField` — TextInput with `secureTextEntry` + show/hide eye icon. Uses existing input style + Icon.
- `Card` — wrap each tab's content in the existing `gemmaCard` style for consistency.

Settings menu (`settings/index.tsx`): now only shows the entry into AI Settings (since Cloud Sync moves into a tab). Simpler menu.

### Where the loader surfaces
For now, the loader state is **per-chain** and rendered alongside each feature's UI:
- Summarize: in the AI summary card
- Caption: in the editor caption-variants UI
- Interpret: in the interpret modal
- Classify: in the existing `/todos` banner (already has an in-flight counter)

Implementation: each chain's caller passes an `onProgress` callback that updates a React state held in the calling component. Optional convenience: a `useLlmProgressTracker()` hook (the React equivalent of dryrun's class) returns `{state, track, clear}` for the calling component to use uniformly.

A global "AI is busy" indicator (status bar at app level) is out of scope for this commit — could come later.

## Phasing (logical commits)

| # | Scope | Reach |
|---|---|---|
| 1 | Rip out Together cloud-Gemma + extract `callCloud` helper (Anthropic primary, OpenAI fallback) | `config.ts`, `providers/gemma.ts`, new `providers/cloud.ts`, 4 chains. **No UI change yet.** |
| 2 | Per-chain routing storage + `getChainRoute`/`setChainRoute` + simplify chain helpers to read the route | `config.ts`, 4 chains. **No UI change yet.** Default routes stay `cloud` so behavior is preserved. |
| 3 | `LlmProgress` types + `useLlmProgressTracker` hook + `onProgress` parameter on chain calls + wire into `callGemmaLocal` + `callCloud` | new `LlmProgress.ts`, `LlmProgressTracker.ts`, `providers/gemma.ts`, `providers/cloud.ts`, 4 chains (signature only — callers don't pass onProgress yet). |
| 4 | Settings UI rewrite — tabbed layout, 5 tabs, KeyField with eye toggle | `settings/ai.tsx` substantial rewrite, `settings/index.tsx` smaller. |
| 5 | Wire `onProgress` into the calling components (per-chain UI integration) | feature components (vlog editor, interpret modal, todos banner). |

Commits 1 + 2 ship together comfortably (related refactor, no UI surface). Commit 3 is mechanical but touches signatures across the codebase. Commits 4 + 5 are user-visible — 4 lands the new UI, 5 lights up the loaders.

## Risks

| Risk | Mitigation |
|---|---|
| llama.rn's completion callback shape may differ from my `(data) => ...` sketch | Read llama.rn source/docs at Commit 3 start; adjust the wire-up before writing the chain integration. |
| Cache provider field semantic change (specific-model → on-device/cloud) means old cache rows go stale | Bump `PROMPT_VERSION` in all 4 chains in Commit 1 or 2 — old rows naturally expire by missing the new key. |
| Token counts from llama.rn may not be available per-call; estimated counts only | LlmProgress already has an `estimated` boolean. Mirror dryrun's "estimated until done" pattern. |
| Tab UI without an RN tab library may feel janky | Use a horizontal scrollable row of styled Pressables. Matches existing aesthetic; ~30 LOC. |
| Strict-local mode under per-chain routing semantics: when ON, does it force on-device even for chains set to 'cloud'? | YES — strict-local is a hard kill-switch on all cloud paths. Tested in chain helpers' first branch. |
| Removing Together breaks any user who actually entered a Together key | Migration: on first launch after upgrade, log + clear the `gemma_cloud_api_key` SecureStore entry. Surface a one-time Settings → AI notice if needed (optional). |

## Out of scope

- Token usage tracking and the dryrun "Usage" tab (no data layer for it today; defer).
- Per-feature provider tuning beyond the four buffr chains.
- Global "AI is busy" status bar at app level.
- Multimodal Gemma on-device.
- KV cache persistence.

## Open questions

1. **Cloud picker on UI:** dryrun has Anthropic primary, OpenAI fallback — no user toggle for "use OpenAI as primary." Buffr currently lets the user pick. Keep the user toggle (more flexible) or drop it for parity with dryrun (simpler)?
2. **Per-chain default routes:** all `'cloud'` for safe upgrade? Or default `summarize` and `caption` to `'cloud'` (quality-sensitive) and `classify` to `'on-device'` (high volume, cheap on-device)?
3. **Eval substrate (recon TRACK #1):** still the gate per the Gemma plan v3 for any default-flip to on-device. This refactor doesn't change that — it just makes the routing controllable. Default routes stay `'cloud'` until evals justify flipping.

## Cross-references

- `.aipe/plans/gemma-integration.md` — the originating Gemma plan (this refactor supersedes that plan's "Together as cloud Gemma" assumption)
- `.aipe/audits/recon-2026-06-03.md` — the readiness audit; eval substrate still gates default flip
- `.aipe/drills/eval-design-llm-judge-classify.md` — the eval drill writeup
- `.aipe/TODO.md` — the eval gold.json substrate todo
- dryrun reference files:
  - `app/src/main/java/com/dryrun/app/ui/settings/SettingsScreen.kt`
  - `app/src/main/java/com/dryrun/app/ai/LlmProgress.kt`
  - `app/src/main/java/com/dryrun/app/ui/common/LlmProgressTracker.kt`
  - `app/src/main/java/com/dryrun/app/ai/ondevice/OnDeviceLlmClient.kt` (the streaming wiring reference)
