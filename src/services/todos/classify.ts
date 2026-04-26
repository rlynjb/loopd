import { getAnthropicKey, getOpenAIKey } from '../ai/config';
import { emit } from '../../utils/events';
import type { TodoType, ClassifierConfidence } from '../../types/todoMeta';

// Cheapest available models for classification — single-pass JSON out.
// Both are fast and ~$0.0001 per call at this prompt size.
const OPENAI_MODEL = 'gpt-4o-mini';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

// Per spec §5.3 — context-free for speed and cost. Surrounding entry
// context comes back in at expansion time (Phase C), not here.
const SYSTEM_PROMPT = `You classify short developer thoughts into one of seven thinking modes.
Read the thought. Pick the mode that matches the kind of thinking it needs.
Output ONLY a JSON object — no preamble, no markdown.

Modes:
- todo: a plain action item the writer intends to do.
- idea: a possibility, a "what if", an unproven direction.
- bug: something is broken or behaving unexpectedly.
- question: an unresolved question, often ending with "?" but not always.
- decision: a choice that has been made or is being committed to.
- knowledge: an observation or insight worth remembering.
- content: a thing the writer wants to publish, post, or share.

Respond with: {"type":"<mode>","confidence":"high|medium|low"}`;

export type ClassifyResult = {
  type: TodoType;
  confidence: Exclude<ClassifierConfidence, 'heuristic'>;
  model: string;
};

// Module-level in-flight counter so the /todos banner can show progress.
// Updated atomically in classifyTodo's try/finally; subscribers listen on
// the events bus.
let _inFlight = 0;
export function getClassifyInFlight(): number { return _inFlight; }
export const CLASSIFY_PROGRESS_EVENT = 'classify-progress';

async function callClaude(apiKey: string, text: string): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const r = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 50,
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
      max_tokens: 50,
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
  'todo', 'idea', 'bug', 'question', 'decision', 'knowledge', 'content',
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

// Picks the cheapest configured model (OpenAI mini preferred). Returns null
// when no AI is configured or the call fails — caller should leave the
// meta row at type='todo', classifier_confidence=null and try again later.
export async function classifyTodo(text: string): Promise<ClassifyResult | null> {
  const openaiKey = await getOpenAIKey();
  const anthropicKey = await getAnthropicKey();
  if (!openaiKey && !anthropicKey) return null;
  if (!text.trim()) return null;

  _inFlight++;
  emit(CLASSIFY_PROGRESS_EVENT);

  try {
    const useOpenAI = !!openaiKey;
    const raw = useOpenAI
      ? await callOpenAI(openaiKey!, text)
      : await callClaude(anthropicKey!, text);
    const parsed = parseClassifyJson(raw);
    if (!parsed?.type || !parsed?.confidence) return null;
    if (!VALID_TYPES.has(parsed.type as TodoType)) return null;
    if (!VALID_CONFIDENCES.has(parsed.confidence)) return null;
    return {
      type: parsed.type as TodoType,
      confidence: parsed.confidence as ClassifyResult['confidence'],
      model: useOpenAI ? OPENAI_MODEL : CLAUDE_MODEL,
    };
  } catch (err) {
    console.warn('[classify] failed:', err);
    return null;
  } finally {
    _inFlight--;
    emit(CLASSIFY_PROGRESS_EVENT);
  }
}

export async function isClassifierAvailable(): Promise<boolean> {
  const [openaiKey, anthropicKey] = await Promise.all([getOpenAIKey(), getAnthropicKey()]);
  return !!openaiKey || !!anthropicKey;
}
