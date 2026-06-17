import {
  getAnthropicKey, getOpenAIKey, getProvider,
  getStrictLocalMode, getChainRoute,
  type RouteChoice,
} from '../ai/config';
import {
  callGemmaLocal, shouldUseGemmaLocal,
  GEMMA_LOCAL_MODEL,
} from '../ai/providers/gemma';
import { orchestrateCloud } from '../ai/providers/cloud';
import { getCached, writeCachedSafe, type CacheKeyInput } from '../ai/cache';
import type { LlmProgress } from '../ai/LlmProgress';
import { emit } from '../../utils/events';
import type { TodoType, ClassifierConfidence } from '../../types/todoMeta';

// Cheapest available models for classification — single-pass JSON out.
// Both are fast and ~$0.0001 per call at this prompt size.
const OPENAI_MODEL = 'gpt-4o-mini';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 50;

// Bump on meaningful prompt or output-format changes.
const PROMPT_VERSION = 'classify-v2';

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
// Cache hits do NOT tick this counter — no LLM work happened.
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

// Predicts which route the cascade will take — 'on-device' or 'cloud'.
// Used to derive the cache lookup key so swapping the route invalidates
// the cache naturally.
async function predictClassifyRoute(strictLocal: boolean): Promise<RouteChoice> {
  if (strictLocal) return 'on-device';
  const route = await getChainRoute('classify');
  if (route === 'on-device' && (await shouldUseGemmaLocal('classify'))) return 'on-device';
  return 'cloud';
}

// Classifies a single todo line. Routes per the chain's setting:
//   - strict-local: on-device only; fails if not ready.
//   - route='on-device': try local, fall back to cloud on failure.
//   - route='cloud': straight to cloud cascade.
// Cloud cascade uses orchestrateCloud (Anthropic primary + OpenAI
// fallback per the user's getProvider() pick) with the cheap models
// (Haiku, gpt-4o-mini). Returns null when no path can serve — caller
// leaves the meta row at type='todo', classifier_confidence=null and
// tries again later.
export async function classifyTodo(
  text: string,
  onProgress?: (p: LlmProgress) => void,
): Promise<ClassifyResult | null> {
  if (!text.trim()) return null;

  const strictLocal = await getStrictLocalMode();
  const cacheRoute = await predictClassifyRoute(strictLocal);
  const cacheInput: CacheKeyInput = {
    chain: 'classify',
    provider: cacheRoute,
    promptVersion: PROMPT_VERSION,
    system: SYSTEM_PROMPT,
    user: text,
  };

  // Cache lookup BEFORE the cascade. A hit skips the LLM call entirely
  // and doesn't tick the in-flight counter (no work being done).
  const cached = await getCached(cacheInput);
  if (cached) {
    return parseAndReturn(cached.result, cached.modelServed);
  }

  // Strict-local: on-device only.
  if (strictLocal) {
    if (!(await shouldUseGemmaLocal('classify'))) return null;
    _inFlight++;
    emit(CLASSIFY_PROGRESS_EVENT);
    try {
      const raw = await callGemmaLocal('classify', SYSTEM_PROMPT, text, MAX_TOKENS, undefined, onProgress);
      const result = parseAndReturn(raw, GEMMA_LOCAL_MODEL);
      if (result) await writeCachedSafe(cacheInput, GEMMA_LOCAL_MODEL, raw);
      return result;
    } catch (err) {
      console.warn('[classify] strict-local failed:', err);
      return null;
    } finally {
      _inFlight--;
      emit(CLASSIFY_PROGRESS_EVENT);
    }
  }

  // Non-strict: route decides whether to try on-device first.
  const userRoute = await getChainRoute('classify');
  const tryLocal = userRoute === 'on-device' && (await shouldUseGemmaLocal('classify'));

  const [openaiKey, anthropicKey] = await Promise.all([
    getOpenAIKey(),
    getAnthropicKey(),
  ]);
  const cloudReady = !!openaiKey || !!anthropicKey;

  if (!tryLocal && !cloudReady) return null;

  _inFlight++;
  emit(CLASSIFY_PROGRESS_EVENT);

  try {
    let raw: string | null = null;
    let usedModel: string = '';

    if (tryLocal) {
      try {
        raw = await callGemmaLocal('classify', SYSTEM_PROMPT, text, MAX_TOKENS, undefined, onProgress);
        usedModel = GEMMA_LOCAL_MODEL;
      } catch (err) {
        console.warn('[classify] gemma local failed, falling back to cloud:', err instanceof Error ? err.message : err);
      }
    }

    if (raw === null && cloudReady) {
      const primary = await getProvider();
      try {
        const { result, servedBy } = await orchestrateCloud({
          primary,
          callClaude: () => callClaude(anthropicKey ?? '', text),
          callOpenAI: () => callOpenAI(openaiKey ?? '', text),
          hasClaudeKey: !!anthropicKey,
          hasOpenAIKey: !!openaiKey,
          onProgress,
          phase: 'classify',
        });
        raw = result;
        usedModel = servedBy === 'claude' ? CLAUDE_MODEL : OPENAI_MODEL;
      } catch (err) {
        console.warn('[classify] cloud cascade failed:', err instanceof Error ? err.message : err);
      }
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
  if (strictLocal) return shouldUseGemmaLocal('classify');
  const [openaiKey, anthropicKey, useGemmaLocal] = await Promise.all([
    getOpenAIKey(),
    getAnthropicKey(),
    shouldUseGemmaLocal('classify'),
  ]);
  return useGemmaLocal || !!openaiKey || !!anthropicKey;
}
