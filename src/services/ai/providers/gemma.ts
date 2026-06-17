// Gemma provider — on-device only via llama.rn.
//
// Runs Gemma 3 4B (Q4_K_M GGUF) on-device through llama.rn
// (mybigday/llama.rn — React Native binding of llama.cpp). CPU-only on
// Android — GPU offload is "improving but not production stable" per
// Phase A research; revisit when llama.rn ships stable Android GPU.
//
// The context is initialized lazily on first call and cached for the
// session (initLlama loads the full ~2.5 GB model into memory; we
// never want to do that twice).
//
// Latency probe: each callGemmaLocal records the wall-clock time
// against the per-chain budget. Three consecutive over-budget runs
// auto-skip that chain from the on-device path until the user re-
// downloads the model (which clears the skip flags).
//
// The cloud-Gemma (Together.ai) path that existed in earlier phases
// was removed in the dryrun-parity refactor — cloud is always Anthropic
// primary + OpenAI fallback now; Gemma is local-only.

import { initLlama } from 'llama.rn';
import { Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import type { LlmProgress } from '../LlmProgress';

// On-device model. The bartowski community quantization of Gemma 3 4B
// Instruct, Q4_K_M variant — ~2.5 GB; the standard pick for mobile.
export const GEMMA_LOCAL_MODEL = 'gemma-3-4b-it-q4_k_m';
export const MODEL_FILENAME = 'gemma-3-4b-it-Q4_K_M.gguf';

// Where the model file lives on the device. The document directory
// survives app updates and is removed only on uninstall.
export function getModelPath(): string {
  return `${Paths.document.uri}/buffr/models/${MODEL_FILENAME}`;
}

// Per-chain latency budgets (ms) for on-device Gemma. Sustained over-
// budget runs auto-skip that chain. Tune up if Gemma local turns out
// faster than expected (probe resets cleanly via resetGemmaLocalSkip()).
const BUDGETS_MS: Record<string, number> = {
  classify: 1500,
  caption: 3000,
  summarize: 10000,
  interpret: 15000,
};

const STRIKES_TO_SKIP = 3;
const KEY_GEMMA_SKIP_PREFIX = 'gemma_local_skip_';
const KEY_GEMMA_STREAK_PREFIX = 'gemma_local_streak_';

// Chains the probe knows about. Used by resetGemmaLocalSkip() when
// clearing all probe state on model re-download.
const KNOWN_CHAINS = ['classify', 'caption', 'summarize', 'interpret'] as const;

// Singleton llama.rn context. initLlama loads the GGUF (~2.5 GB) into
// memory — multi-second op; we cache the result for the session.
// _initPromise handles concurrent first-callers racing on init.
type LlamaContext = Awaited<ReturnType<typeof initLlama>>;
let _llamaContext: LlamaContext | null = null;
let _initPromise: Promise<LlamaContext> | null = null;

async function getLlamaContext(): Promise<LlamaContext> {
  if (_llamaContext) return _llamaContext;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const modelPath = getModelPath();
    const ctx = await initLlama({
      model: `file://${modelPath}`,
      n_ctx: 2048,
      // CPU-only. Flip to >0 once Android GPU offload (OpenCL/Vulkan in
      // llama.cpp) is production-stable.
      n_gpu_layers: 0,
      // mlock pins the model in RAM. Risky on mobile where the OS may
      // need to page; let it page if memory pressure spikes.
      use_mlock: false,
    });
    _llamaContext = ctx;
    return ctx;
  })();

  try {
    return await _initPromise;
  } finally {
    _initPromise = null;
  }
}

// On-device Gemma. Throws on init failure (model file missing, native
// module not built into the binary) so the chain code falls through to
// the cloud — unless strict-local mode is on, in which case the chain
// surfaces its existing failure.
//
// The first arg (chain) is the chain name — 'classify' / 'caption' /
// 'summarize' / 'interpret'. Used by the latency probe to track over-
// budget runs per chain and auto-disable when sustained.
//
// Optional onProgress receives an LlmProgress event per streamed token
// (estimated:true with climbing outputTokens), then a final done:true
// event with the same total on completion. Surfaces directly into the
// useLlmProgressTracker hook on the UI side.
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
  const result = await ctx.completion(
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      n_predict: maxTokens,
      ...(temperature !== undefined ? { temperature } : {}),
      // Gemma's primary stop token + common fallbacks. The tokenizer
      // embedded in the GGUF usually self-stops; these guard against
      // runaway generation if it doesn't.
      stop: ['<end_of_turn>', '</s>', '<|end_of_text|>'],
    },
    (data: { token?: string }) => {
      // llama.rn fires this callback once per generated token. We use
      // its presence as the climb signal — we don't accumulate the
      // tokens themselves (the SDK returns the full text via result).
      if (data?.token !== undefined && onProgress) {
        outputTokens++;
        onProgress({ phase: chain, outputTokens, estimated: true });
      }
    },
  );
  const elapsed = Date.now() - start;
  await updateGemmaLocalProbe(chain, elapsed);
  onProgress?.({ phase: chain, outputTokens, estimated: false, done: true });
  return result.text ?? '';
}

// Latency probe — best-effort, never propagates errors. A single
// over-budget run isn't enough to skip; we wait for STRIKES_TO_SKIP
// consecutive over-budget runs to filter out one-off slow calls
// (cold start, thermal throttle clearing, etc).
async function updateGemmaLocalProbe(chain: string, elapsedMs: number): Promise<void> {
  const budget = BUDGETS_MS[chain];
  if (!budget) return;

  const streakKey = `${KEY_GEMMA_STREAK_PREFIX}${chain}`;
  try {
    if (elapsedMs <= budget) {
      await SecureStore.deleteItemAsync(streakKey);
      return;
    }
    const currentStreak = parseInt(
      (await SecureStore.getItemAsync(streakKey)) ?? '0',
      10,
    );
    const newStreak = currentStreak + 1;
    if (newStreak >= STRIKES_TO_SKIP) {
      await SecureStore.setItemAsync(`${KEY_GEMMA_SKIP_PREFIX}${chain}`, '1');
      await SecureStore.deleteItemAsync(streakKey);
      console.warn(
        `[buffr ai] gemma local for ${chain} skipped after ${STRIKES_TO_SKIP} slow runs (last: ${elapsedMs}ms > ${budget}ms budget)`,
      );
    } else {
      await SecureStore.setItemAsync(streakKey, String(newStreak));
    }
  } catch {
    // probe is best-effort; never fail the call
  }
}

// True when the GGUF file exists at the expected path. The download UX
// and shouldUseGemmaLocal both consult this.
export async function isModelDownloaded(): Promise<boolean> {
  try {
    const { File: FSFile } = await import('expo-file-system');
    const file = new FSFile(getModelPath());
    return file.exists;
  } catch {
    return false;
  }
}

// Routing decision: should this chain attempt on-device Gemma first?
// Returns true when ALL of these hold:
//   - the GGUF model file exists at getModelPath()
//   - the device class is not 'disabled' (>= 2 GB RAM)
//   - the per-chain auto-skip flag is not set (latency probe)
// The optional `chain` arg gates the per-chain skip check. Callers that
// don't pass it (e.g. warmLlamaContext) get the device-and-model gates
// only.
export async function shouldUseGemmaLocal(chain?: string): Promise<boolean> {
  const { detectDeviceClass } = await import('../deviceClass');
  const cls = await detectDeviceClass();
  if (cls === 'disabled') return false;
  if (!(await isModelDownloaded())) return false;
  if (chain) {
    try {
      const skipped = await SecureStore.getItemAsync(`${KEY_GEMMA_SKIP_PREFIX}${chain}`);
      if (skipped === '1') return false;
    } catch {
      // SecureStore failure shouldn't disable on-device routing.
    }
  }
  return true;
}

// Clears the auto-skip + streak state for one chain (or all chains if
// no arg). Called by the download flow on successful (re-)download:
// the user expects fresh perf after re-installing the model.
export async function resetGemmaLocalSkip(chain?: string): Promise<void> {
  const chains = chain ? [chain] : Array.from(KNOWN_CHAINS);
  for (const c of chains) {
    try {
      await SecureStore.deleteItemAsync(`${KEY_GEMMA_SKIP_PREFIX}${c}`);
      await SecureStore.deleteItemAsync(`${KEY_GEMMA_STREAK_PREFIX}${c}`);
    } catch {
      // ignore; best-effort cleanup
    }
  }
}

// Eagerly loads the llama context if conditions are met. Called once at
// app start so the first chain call doesn't pay the multi-second
// model-load cost. No-op when on-device isn't ready (device too small,
// model not downloaded) — fire-and-forget at the call site, never blocks
// UI rendering.
export async function warmLlamaContext(): Promise<void> {
  if (!(await shouldUseGemmaLocal())) return;
  try {
    await getLlamaContext();
  } catch (err) {
    console.warn('[buffr ai] llama warm failed:', err instanceof Error ? err.message : err);
  }
}

// Releases the cached llama context. Called when the user clears the
// downloaded model or switches device-class manually (forces re-init
// with the new variant on next call).
export async function unloadLlamaContext(): Promise<void> {
  if (_llamaContext) {
    try {
      await _llamaContext.release();
    } catch (err) {
      console.warn('[buffr ai] llama context release failed:', err);
    }
    _llamaContext = null;
  }
  _initPromise = null;
}
