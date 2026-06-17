# Plan — Settings dryrun-parity: remaining work (Commits 3 + 4 + 5)

**Parent plan:** `.aipe/plans/settings-dryrun-parity.md`
**Status doc:** `.aipe/plans/settings-dryrun-parity-status.md`
**Drafted:** 2026-06-17 — after Commits 1+2 shipped (`4ac3771`)

## What's left

Commits 1+2 landed the structural refactor (Gemma local-only + per-chain routing). Three commits remain to complete dryrun parity:

| # | Scope | Native dep | Behavior change |
|---|---|---|---|
| 3 | `LlmProgress` types + `useLlmProgressTracker` hook + `onProgress` through chains | none | infrastructure only — no UI surface |
| 4 | Tabbed Settings UI (5 tabs) | none | user-visible — Settings looks like dryrun |
| 5 | Wire `onProgress` into feature components | none | user-visible — live loaders during chain calls |

Commits 3 and 4 are independent — either can ship first. Commit 5 depends on Commit 3.

## Commit 3 — `LlmProgress` + tracker + `onProgress` wiring

Ports dryrun's `LlmProgressTracker` to React Native. The tracker holds an in-flight LLM call's progress (phase + tokens + elapsed time) and updates 4x/second so a UI can render a live loader.

### New files

**`src/services/ai/LlmProgress.ts`** — types only

```ts
// One progress update from an LLM call, surfaced through the run helpers'
// onProgress callback. On-device streams climbing outputTokens; cloud emits
// one done:true update with parsed usage.
export type LlmProgress = {
  phase: string;        // human-readable label like "Analyzing"
  inputTokens?: number;
  outputTokens?: number;
  estimated?: boolean;  // true while streaming; false on final done
  done?: boolean;
};

// UI-facing snapshot. Same fields as LlmProgress plus elapsedMs tracked by
// the 250ms ticker.
export type LlmLoadState = {
  phase: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
  elapsedMs: number;
  done: boolean;
};
```

**`src/services/ai/useLlmProgressTracker.ts`** — React hook

```ts
import { useCallback, useRef, useState } from 'react';
import type { LlmProgress, LlmLoadState } from './LlmProgress';

export function useLlmProgressTracker(): {
  state: LlmLoadState | null;
  track: <T>(label: string, block: (onProgress: (p: LlmProgress) => void) => Promise<T>) => Promise<T>;
  clear: () => void;
} {
  const [state, setState] = useState<LlmLoadState | null>(null);
  const startRef = useRef(0);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clear = useCallback(() => {
    if (tickerRef.current) clearInterval(tickerRef.current);
    tickerRef.current = null;
    setState(null);
  }, []);

  const track = useCallback(async <T,>(
    label: string,
    block: (onProgress: (p: LlmProgress) => void) => Promise<T>,
  ): Promise<T> => {
    startRef.current = Date.now();
    setState({ phase: label, inputTokens: 0, outputTokens: 0, estimated: false, elapsedMs: 0, done: false });
    // 250ms ticker for elapsed-time updates while the call is in flight.
    tickerRef.current = setInterval(() => {
      setState(cur => cur ? { ...cur, elapsedMs: Date.now() - startRef.current } : cur);
    }, 250);
    try {
      return await block((p) => {
        setState(cur => {
          const base = cur ?? { phase: label, inputTokens: 0, outputTokens: 0, estimated: false, elapsedMs: 0, done: false };
          return {
            phase: p.phase || base.phase,
            inputTokens: p.inputTokens && p.inputTokens > 0 ? p.inputTokens : base.inputTokens,
            outputTokens: (p.outputTokens && p.outputTokens > 0) || p.done ? (p.outputTokens ?? base.outputTokens) : base.outputTokens,
            estimated: p.estimated ?? base.estimated,
            elapsedMs: Date.now() - startRef.current,
            done: p.done ?? base.done,
          };
        });
      });
    } finally {
      if (tickerRef.current) clearInterval(tickerRef.current);
      tickerRef.current = null;
      // Always settle to done so the loader stops even if the call threw.
      setState(cur => cur ? { ...cur, elapsedMs: Date.now() - startRef.current, done: true } : cur);
    }
  }, []);

  return { state, track, clear };
}
```

### Changes to existing files

**`src/services/ai/providers/gemma.ts`** — `callGemmaLocal` accepts optional `onProgress` callback. Wires llama.rn's streaming token callback to emit `LlmProgress` events with climbing `outputTokens`. Final emission has `done: true`:

```ts
import type { LlmProgress } from '../LlmProgress';

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
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    n_predict: maxTokens,
    ...(temperature !== undefined ? { temperature } : {}),
    stop: ['<end_of_turn>', '</s>', '<|end_of_text|>'],
  }, (data: { token?: string }) => {
    if (data?.token && onProgress) {
      outputTokens++;
      onProgress({ phase: chain, outputTokens, estimated: true });
    }
  });
  const elapsed = Date.now() - start;
  await updateGemmaLocalProbe(chain, elapsed);
  onProgress?.({ phase: chain, outputTokens, estimated: false, done: true });
  return result.text ?? '';
}
```

**`src/services/ai/providers/cloud.ts`** — `orchestrateCloud` accepts optional `onProgress`. Emits a single `done: true` event after the response parses successfully. Cloud doesn't stream in this implementation, so input/output tokens are populated from the response usage where available; estimated when absent:

```ts
export type OrchestratorParams<T> = {
  primary: AIProvider;
  callClaude: () => Promise<T>;
  callOpenAI: () => Promise<T>;
  hasClaudeKey: boolean;
  hasOpenAIKey: boolean;
  onProgress?: (p: LlmProgress) => void;  // ← new
};
```

After a successful call: `onProgress?.({ phase: 'cloud', done: true, estimated: usage ? false : true, inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens })`. Per-chain `callClaude`/`callOpenAI` functions get an optional `usage` return — they can either expose usage or skip it (estimated stays true).

**4 chain files** — `runXxxLLM` helpers grow an optional `onProgress` parameter, threaded through to `callGemmaLocal` and `orchestrateCloud`. Each chain's entry point (`summarize`, `interpretEntry`, `generateCaption`, `classifyTodo`) also grows an optional `onProgress` param so callers can opt into progress reporting.

### Test plan

- [ ] tsc clean
- [ ] On-device call (Gemma): UI subscribes to tracker, sees outputTokens climb, sees `done: true` on completion
- [ ] Cloud call: UI sees single `done: true` event with usage tokens when API returns them
- [ ] Tracker stops cleanly on call throw (finally block in `track`)

## Commit 4 — Tabbed Settings UI

Replaces the current single-scrolling Settings → AI page with a 5-tab layout matching dryrun's `SettingsScreen.kt`.

### Tab inventory

| # | Tab | Content |
|---|---|---|
| 1 | **Routing** | Per-chain rows (4): title + description + on-device/cloud chip pair. On-device chip disabled when device class is 'disabled' or model not downloaded. Strict-local toggle below the rows. Cloud-primary picker (Anthropic / OpenAI) at top of tab — placement TBD; could also be a small affordance |
| 2 | **On-Device** | Device class + RAM + model state (NotDownloaded / Downloading / Ready / Error). Download / Remove buttons. Per-chain auto-skip status from latency probe + reset-skip button |
| 3 | **Anthropic** | `KeyField` with show/hide eye toggle. Save / Clear / Test Connection. One-line description |
| 4 | **OpenAI** | Same shape (fallback) |
| 5 | **Cloud Sync** | The existing cloud-sync content, moved out of the menu and into this tab |

### Reusable primitives

- **`Tabs`** — hand-rolled (RN doesn't ship one). Horizontal scrollable row of styled `Pressable`s above a single panel. ~30 LOC. Active tab uses the existing `providerBtnActive` style; the row uses `providerRow`.
- **`Chip`** — pair of `Pressable`s using existing `providerBtn` / `providerBtnActive` styles. Already exists in pattern; lift to a shared component.
- **`KeyField`** — `TextInput` (`secureTextEntry`) + eye `Pressable` overlay. Tap to toggle visibility. Use the existing `input` style + an `Icon` for the eye.
- **`Card`** — wrap each tab's content in the existing `gemmaCard` style for consistency.

### Routing tab UX detail

Each per-chain row:

```
Summarize
[ on-device ]  [ cloud ✓ ]      ← chip pair, current pick highlighted
Generates the day's AI summary card.
```

On-device chip is `disabled` when:
- device class is `'disabled'` (< 2 GB RAM); OR
- model not downloaded; OR
- per-chain auto-skip flag is set

Tap auto-skipped chip → toast: "Auto-skipped after 3 slow runs — Reset in On-Device tab."

Strict-local toggle below the rows uses the existing two-button pattern. Hint text changes based on toggle state.

### On-Device tab UX detail

Reuses the existing `gemmaCard` content but lifted out of the bottom of the page into its own tab. Adds:

- Per-chain auto-skip status (from `gemma_local_skip_<chain>` SecureStore keys)
- "Reset auto-skip" button — calls `resetGemmaLocalSkip()` from `providers/gemma.ts`

### Cloud Sync tab

Move the existing `app/settings/cloud-sync.tsx` content INTO this tab as a component (or render `<CloudSyncTab />` from inside the Settings page). The standalone `cloud-sync.tsx` route can stay for deep-link compatibility OR be deleted — design choice.

### Settings menu (`app/settings/index.tsx`)

Now down to one entry — AI Settings — since Cloud Sync moves into a tab. Could either:
- A) Keep the menu page; tap AI Settings → tabbed page
- B) Remove the menu page; the AI Settings page becomes `/settings/index.tsx` directly

Option B is cleaner with one entry. Pick B.

### Test plan

- [ ] tsc clean
- [ ] Visual regression — Settings page looks structurally like dryrun's
- [ ] Each tab renders without crashing
- [ ] Per-chain chips update SecureStore and survive app restart
- [ ] Switching tabs preserves draft state in API key inputs
- [ ] Eye toggle on key fields shows/hides correctly

## Commit 5 — Wire `onProgress` into feature components

For each chain that has a user-facing loader surface, install a `useLlmProgressTracker()` instance and pass its `onProgress` to the chain call. Render the tracker state below or alongside the feature.

### Feature surfaces

| Chain | Surface | Loader location |
|---|---|---|
| summarize | Vlog editor (auto-compose card) | Existing "Generating..." pill becomes the live tracker render |
| caption | 4-variant caption panel | New inline loader during generation |
| interpret | Interpret modal | New loader at the top of the modal during generation |
| classify | `/todos` banner | Replace the existing `_inFlight` counter with the per-call tracker — show classified todo text + token count |

### Loader render shape (proposed)

```tsx
<View style={loaderRow}>
  <Text style={phaseText}>{state.phase}</Text>
  <Text style={tokenText}>
    {state.outputTokens} tokens
    {state.estimated ? ' ~' : ''}
  </Text>
  <Text style={elapsedText}>
    {(state.elapsedMs / 1000).toFixed(1)}s
  </Text>
</View>
```

Hide when `state === null` or `state.done === true` (with a brief settle delay so the final number doesn't flash off).

### Optional: global busy indicator

A status bar at the app shell level showing "AI working…" when ANY chain is in flight. Deferred unless it proves useful in testing — the per-feature loaders should be enough.

### Test plan

- [ ] tsc clean
- [ ] Trigger each chain; verify loader appears and updates
- [ ] Loader stops on call completion (or throw)
- [ ] On-device call shows climbing outputTokens
- [ ] Cloud call shows single done event with usage tokens

## Suggested ordering

1. **Commit 3 first** — infrastructure-only, low UI risk. Lets the tracker bake before any UI depends on it.
2. **Commit 5 partially** — wire onProgress into one chain (probably classify, simplest) to validate end-to-end.
3. **Commit 4** — UI rewrite. Standalone visual change; doesn't depend on the tracker.
4. **Commit 5 fully** — wire remaining chains.

Or if the user wants user-visible progress first:

1. **Commit 4** — UI rewrite.
2. **Commit 3 + 5** — tracker + wiring as one bigger commit.

## Out of scope (deferred to a later session)

- Token usage tracking and the dryrun "Usage" tab (no data layer for it today)
- Custom on-device model URL field (advanced)
- Eval substrate `tests/evals/classify.gold.json` — recon TRACK #1; gates flipping defaults to on-device for the quality-sensitive chains
- KV cache persistence across calls
- Variant-aware `MODEL_FILENAME`

## Cross-references

- `.aipe/plans/settings-dryrun-parity.md` — parent plan
- `.aipe/plans/settings-dryrun-parity-status.md` — progress tracker
- `.aipe/plans/settings-dryrun-parity-pr.md` — PR description for Commits 1+2 (already merged)
- `.aipe/plans/gemma-integration.md` — Phase B + C of the originating Gemma plan
- `../dryrun/app/src/main/java/com/dryrun/app/ui/settings/SettingsScreen.kt` — reference UI
- `../dryrun/app/src/main/java/com/dryrun/app/ai/LlmProgress.kt` — reference types
- `../dryrun/app/src/main/java/com/dryrun/app/ui/common/LlmProgressTracker.kt` — reference tracker
