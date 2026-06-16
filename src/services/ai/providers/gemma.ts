// Gemma provider — cloud (Together.ai) and on-device (llama.rn).
//
// Together.ai serves Gemma 3 4B free as of mid-2026 and exposes an
// OpenAI-compatible /v1/chat/completions endpoint, so callGemmaCloud
// mirrors the existing per-chain callOpenAI implementations.
//
// callGemmaLocal runs Gemma 3 4B (Q4_K_M GGUF) on-device via llama.rn
// (mybigday/llama.rn — React Native binding of llama.cpp). CPU-only on
// Android in Phase 5a — GPU offload is "improving but not production
// stable" per Phase A research; revisit when llama.rn ships stable
// Android GPU. The context is initialized lazily on first call and
// cached for the session (initLlama loads the full ~2.5 GB model into
// memory; we never want to do that twice).

import { initLlama } from 'llama.rn';
import { Paths } from 'expo-file-system';

const TOGETHER_ENDPOINT = 'https://api.together.xyz/v1/chat/completions';

// Cloud model identifier. Together's catalog as of Phase A research
// (mid-2026); adjust if Together's canonical name shifts.
export const GEMMA_CLOUD_MODEL = 'google/gemma-3-4b-it';

// On-device model. The bartowski community quantization of Gemma 3 4B
// Instruct, Q4_K_M variant — ~2.5 GB; the standard pick for mobile.
export const GEMMA_LOCAL_MODEL = 'gemma-3-4b-it-q4_k_m';
export const MODEL_FILENAME = 'gemma-3-4b-it-Q4_K_M.gguf';

// Where the model file lives on the device. The document directory
// survives app updates and is removed only on uninstall. Phase 5b's
// download flow writes here.
export function getModelPath(): string {
  return `${Paths.document.uri}/buffr/models/${MODEL_FILENAME}`;
}

// Cloud Gemma via Together. Same input/output shape as callOpenAI in the
// chain files so it can be wired in symmetrically. Throws on non-2xx so
// callers can fall through to their existing claude/openai fallback.
export async function callGemmaCloud(
  apiKey: string,
  system: string,
  user: string,
  maxTokens: number,
  temperature?: number,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: GEMMA_CLOUD_MODEL,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (temperature !== undefined) body.temperature = temperature;

  const res = await fetch(TOGETHER_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Together API error: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

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
      // CPU-only for Phase 5a. Flip to >0 once Android GPU offload
      // (OpenCL/Vulkan in llama.cpp) is production-stable.
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

// On-device Gemma. Replaces the Phase B stub. Throws on init failure
// (model file missing, native module not built into the binary) so the
// chain code falls through to the next provider — unless strict-local
// mode is on, in which case the chain surfaces its existing failure.
export async function callGemmaLocal(
  system: string,
  user: string,
  maxTokens: number,
  temperature?: number,
): Promise<string> {
  const ctx = await getLlamaContext();
  const result = await ctx.completion({
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
  });
  return result.text ?? '';
}

// True when the GGUF file exists at the expected path. Phase 5b's
// download UX and Phase 5d's readiness check both consult this.
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
// Phase 5a leaves this at false — the implementation above is in place
// but unreachable until Phase 5d flips this to consult isModelDownloaded
// + device class + user opt-out state.
export async function shouldUseGemmaLocal(): Promise<boolean> {
  return false;
}

// Releases the cached llama context. Called when the user clears the
// downloaded model (Phase 5b) or switches device-class manually
// (forces re-init with the new variant on next call).
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
