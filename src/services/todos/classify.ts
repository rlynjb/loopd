import {
  getAnthropicKey, getOpenAIKey,
  getGemmaCloudKey, getStrictLocalMode,
  type AIProvider,
} from '../ai/config';
import {
  callGemmaCloud, callGemmaLocal, shouldUseGemmaLocal,
  GEMMA_CLOUD_MODEL, GEMMA_LOCAL_MODEL,
} from '../ai/providers/gemma';
import { getCached, writeCachedSafe, type CacheKeyInput } from '../ai/cache';
import { emit } from '../../utils/events';
import type { TodoType, ClassifierConfidence } from '../../types/todoMeta';

// Cheapest available models for classification — single-pass JSON out.
// Both are fast and ~$0.0001 per call at this prompt size.
const OPENAI_MODEL = 'gpt-4o-mini';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 50;

// Bump on meaningful prompt or output-format changes.
const PROMPT_VERSION = 'classify-v1';

// Per spec §5.3 — context-free for speed and cost. Surrounding entry
// context comes back in at expansion time (Phase C), not here.
const SYSTEM_PROMPT = `You classify short personal thoughts into one of five thinking modes.
Read the thought. Pick the mode that matches the kind of thinking it needs.
Output ONLY a JSON object — no preamble, no markdown.

Modes:
- todo: a plain action item the writer intends to do.
- idea: a possibility, a "what if", an unproven direction.
- knowledge: an observation or insight worth remembering.
- study: an intention to learn a topic — "study X", "want to learn Y", "read paper / book / docs on Z". Distinct from knowledge (already absorbed) and idea (unproven possibility).
- reflect: something to *sit with* and re-examine — past-facing introspection. "reflect on X", "process that conversation", "think about why Y happened". Distinct from knowledge (an absorbed insight).

Respond with: {"type":"<mode>","confidence":"high|medium|low"}`;

export type ClassifyResult = {
  type: TodoType;
  confidence: Exclude<ClassifierConfidence, 'heuristic'>;
  model: string;
};

// Module-level in-flight counter so the /todos banner can show progress.
// Updated atomically in classifyTodo's try/finally; subscribers listen on
// the events bus. Cache hits do NOT tick this counter — no LLM work
// happened, no progress to surface.
let _inFlight = 0;
export function getClassifyInFlight(): number { return _inFlight; }
export const CLASSIFY_PROGRESS_EVENT = 'classify-progress';

async function callClaude(apiKey: string, text: string): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const r = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text }],
  });
  return r.content[0]?.type === 'text' ? r.content[0].text : '';
}

async function callOpenAI(apiKey: string, text: string): Promise<string> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? '';
}

const VALID_TYPES = new Set<TodoType>([
  'todo', 'idea', 'knowledge', 'study', 'reflect',
]);
const VALID_CONFIDENCES = new Set<string>(['high', 'medium', 'low']);

function parseClassifyJson(raw: string): { type?: string; confidence?: string } | null {
  try {
    const cleaned = raw.replace(/```(?:json)?\s*|```\s*/g, '').trim();
    const match = cleaned.match(/\{[^}]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// Predicts which provider the cascade will try FIRST. Used to derive the
// cache lookup key. Per the v3 plan's "model_id in cache key" intent: the
// cache is provider-aware so cloud Gemma and on-device Gemma (and
// Claude/OpenAI) don't share entries, and switching providers doesn't
// return stale outputs from the previous one. If the cascade actually
// falls back from the predicted provider to a different one, the write
// happens under the predicted key — next call with same configuration
// hits naturally.
async function predictClassifyProvider(strictLocal: boolean): Promise<AIProvider> {
  if (strictLocal) return 'gemma';
  if (await shouldUseGemmaLocal()) return 'gemma';
  if (await getGemmaCloudKey()) return 'gemma';
  if (await getOpenAIKey()) return 'openai';
  return 'claude';
}

// Picks the cheapest configured model. Gemma (free, local or cloud) takes
// precedence over OpenAI mini and Claude Haiku. Returns null when no AI
// is configured or the call fails — caller leaves the meta row at
// type='todo', classifier_confidence=null and tries again later.
//
// Routing precedence under non-strict mode:
//   1. Gemma local (free, fastest, private)
//   2. Gemma cloud / Together (free, fast)
//   3. OpenAI mini (~$0.0001/call)
//   4. Claude Haiku (~$0.0001/call)
//
// Under strict-local mode, only step 1 is attempted. Cloud paths are off.
//
// Cache layer: lookup happens BEFORE the cascade; hits short-circuit the
// entire function (no LLM call, no _inFlight tick). Cache writes happen
// AFTER cascade success under the predicted-provider key.
export async function classifyTodo(text: string): Promise<ClassifyResult | null> {
  if (!text.trim()) return null;

  const strictLocal = await getStrictLocalMode();
  const predicted = await predictClassifyProvider(strictLocal);
  const cacheInput: CacheKeyInput = {
    chain: 'classify',
    provider: predicted,
    promptVersion: PROMPT_VERSION,
    system: SYSTEM_PROMPT,
    user: text,
  };

  // Cache lookup first. A hit avoids both the LLM call and the in-flight
  // counter increment.
  const cached = await getCached(cacheInput);
  if (cached) {
    return parseAndReturn(cached.result, cached.modelServed);
  }

  // Strict-local: on-device Gemma only.
  if (strictLocal) {
    if (!(await shouldUseGemmaLocal())) return null;
    _inFlight++;
    emit(CLASSIFY_PROGRESS_EVENT);
    try {
      const raw = await callGemmaLocal(SYSTEM_PROMPT, text, MAX_TOKENS);
      const result = parseAndReturn(raw, GEMMA_LOCAL_MODEL);
      if (result) await writeCachedSafe(cacheInput, GEMMA_LOCAL_MODEL, raw);
      return result;
    } catch (err) {
      console.warn('[classify] failed:', err);
      return null;
    } finally {
      _inFlight--;
      emit(CLASSIFY_PROGRESS_EVENT);
    }
  }

  // Non-strict: collect all candidate paths up front.
  const useGemmaLocal = await shouldUseGemmaLocal();
  const gemmaCloudKey = await getGemmaCloudKey();
  const openaiKey = await getOpenAIKey();
  const anthropicKey = await getAnthropicKey();

  if (!useGemmaLocal && !gemmaCloudKey && !openaiKey && !anthropicKey) return null;

  _inFlight++;
  emit(CLASSIFY_PROGRESS_EVENT);

  try {
    let raw: string | null = null;
    let usedModel: string = '';

    if (useGemmaLocal) {
      try {
        raw = await callGemmaLocal(SYSTEM_PROMPT, text, MAX_TOKENS);
        usedModel = GEMMA_LOCAL_MODEL;
      } catch (err) {
        console.warn('[classify] gemma local failed, falling back:', err instanceof Error ? err.message : err);
      }
    }
    if (raw === null && gemmaCloudKey) {
      try {
        raw = await callGemmaCloud(gemmaCloudKey, SYSTEM_PROMPT, text, MAX_TOKENS);
        usedModel = GEMMA_CLOUD_MODEL;
      } catch (err) {
        console.warn('[classify] gemma cloud failed, falling back:', err instanceof Error ? err.message : err);
      }
    }
    if (raw === null && openaiKey) {
      try {
        raw = await callOpenAI(openaiKey, text);
        usedModel = OPENAI_MODEL;
      } catch (err) {
        console.warn('[classify] openai failed, falling back:', err instanceof Error ? err.message : err);
      }
    }
    if (raw === null && anthropicKey) {
      raw = await callClaude(anthropicKey, text);
      usedModel = CLAUDE_MODEL;
    }

    if (raw === null) return null;
    const result = parseAndReturn(raw, usedModel);
    if (result) await writeCachedSafe(cacheInput, usedModel, raw);
    return result;
  } catch (err) {
    console.warn('[classify] failed:', err);
    return null;
  } finally {
    _inFlight--;
    emit(CLASSIFY_PROGRESS_EVENT);
  }
}

function parseAndReturn(raw: string, model: string): ClassifyResult | null {
  const parsed = parseClassifyJson(raw);
  if (!parsed?.type || !parsed?.confidence) return null;
  if (!VALID_TYPES.has(parsed.type as TodoType)) return null;
  if (!VALID_CONFIDENCES.has(parsed.confidence)) return null;
  return {
    type: parsed.type as TodoType,
    confidence: parsed.confidence as ClassifyResult['confidence'],
    model,
  };
}

export async function isClassifierAvailable(): Promise<boolean> {
  const strictLocal = await getStrictLocalMode();
  if (strictLocal) return shouldUseGemmaLocal();
  const [openaiKey, anthropicKey, gemmaKey, useGemmaLocal] = await Promise.all([
    getOpenAIKey(),
    getAnthropicKey(),
    getGemmaCloudKey(),
    shouldUseGemmaLocal(),
  ]);
  return useGemmaLocal || !!gemmaKey || !!openaiKey || !!anthropicKey;
}
