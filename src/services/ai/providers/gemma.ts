// Gemma provider — cloud (Together.ai) for Phase B; on-device (llama.rn)
// for Phase C. Single shared module so chain files don't each duplicate
// the Together call shape or the on-device routing decision.
//
// Together.ai serves Gemma 3 4B free as of mid-2026 and exposes an
// OpenAI-compatible /v1/chat/completions endpoint, so callGemmaCloud
// mirrors the existing per-chain callOpenAI implementations almost
// exactly. callGemmaLocal is intentionally a stub here — implementing
// it is the bulk of Phase C and pulls in a native binding.

const TOGETHER_ENDPOINT = 'https://api.together.xyz/v1/chat/completions';

// Cloud model identifier. Phase A research named Gemma 3 4B as the
// universal default. VERIFY this exact identifier against Together's
// current model list at first call; adjust if the canonical name on
// Together differs.
export const GEMMA_CLOUD_MODEL = 'google/gemma-3-4b-it';

// On-device target model. Q4-quantized GGUF, downloaded lazily in Phase C.
// Falls back to gemma-3-1b on devices with <4 GB RAM (decision made in
// Phase C's device-class detection, not here).
export const GEMMA_LOCAL_MODEL = 'gemma-3-4b-it-q4';

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

// On-device Gemma. Phase C lands the llama.rn binding behind this. Until
// then it throws so chains naturally fall through to cloud Gemma (when
// strict-local is off) or surface the chain's existing failure shape
// (when strict-local is on).
export async function callGemmaLocal(
  _system: string,
  _user: string,
  _maxTokens: number,
  _temperature?: number,
): Promise<string> {
  throw new Error('callGemmaLocal: on-device Gemma not implemented (Phase C pending)');
}

// Routing decision: should this chain attempt on-device Gemma first?
// Phase B: always false. Phase C flips this to true when (a) the model
// is downloaded, (b) device-class detection passed, (c) the user hasn't
// opted out for this chain. Centralized here so chain files don't each
// re-derive the rule.
export async function shouldUseGemmaLocal(): Promise<boolean> {
  return false;
}
