// Cloud orchestrator — Anthropic primary + OpenAI fallback, mirroring
// dryrun's RoutingLlmClient pattern. The user picks which cloud provider
// is primary via getProvider() (stored in KEY_PROVIDER); the other becomes
// the fallback when the primary is unavailable for a transient reason
// (5xx, 429, network).
//
// This module owns ONLY the primary/fallback orchestration. The actual
// callClaude / callOpenAI implementations stay in each chain file
// because each chain uses different models (Sonnet vs Haiku, gpt-4o vs
// gpt-4o-mini) and different prompt shapes. orchestrateCloud takes the
// already-built call functions and wires them together.

import type { AIProvider } from '../config';

export type OrchestratorParams<T> = {
  primary: AIProvider;
  callClaude: () => Promise<T>;
  callOpenAI: () => Promise<T>;
  hasClaudeKey: boolean;
  hasOpenAIKey: boolean;
};

export type OrchestratorResult<T> = {
  result: T;
  servedBy: AIProvider;
};

// Transient errors that justify falling through to the secondary
// provider. Non-transient errors (auth, malformed request) re-throw
// and the chain handles them under its existing failure contract.
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(5\d\d|429|fetch|network|timeout|connection|ECONN)\b/i.test(msg);
}

export async function orchestrateCloud<T>(p: OrchestratorParams<T>): Promise<OrchestratorResult<T>> {
  const primaryHasKey = p.primary === 'claude' ? p.hasClaudeKey : p.hasOpenAIKey;
  const fallbackHasKey = p.primary === 'claude' ? p.hasOpenAIKey : p.hasClaudeKey;
  const fallback: AIProvider = p.primary === 'claude' ? 'openai' : 'claude';

  if (!primaryHasKey && !fallbackHasKey) {
    throw new Error('No API key configured');
  }

  const tryPrimary = p.primary === 'claude' ? p.callClaude : p.callOpenAI;
  const tryFallback = p.primary === 'claude' ? p.callOpenAI : p.callClaude;

  // Primary not configured — go straight to fallback.
  if (!primaryHasKey) {
    return { result: await tryFallback(), servedBy: fallback };
  }

  // Try primary. On transient error, try fallback if it's configured.
  try {
    return { result: await tryPrimary(), servedBy: p.primary };
  } catch (err) {
    if (fallbackHasKey && isTransient(err)) {
      console.warn(`[buffr ai] cloud primary (${p.primary}) failed, trying fallback (${fallback}):`, err instanceof Error ? err.message : err);
      return { result: await tryFallback(), servedBy: fallback };
    }
    throw err;
  }
}
