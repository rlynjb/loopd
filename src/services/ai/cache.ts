// Content-hashed cache for LLM chain outputs. Backed by the local
// chain_cache table (see migrate() in src/services/database.ts).
//
// Key derivation includes the chain name, the provider, an explicit
// prompt-version string, and the literal system + user content. This
// covers the three drift sources called out in the Gemma plan v3:
//   1. cloud Gemma vs on-device Gemma — different served models, must
//      not share cache entries (model_served column records which)
//   2. user switches provider (Claude → Gemma) — must not return the
//      previous provider's cached output
//   3. prompt template changes — bumping prompt_version invalidates
//      the affected chain naturally
//
// Two-part hash (djb2 + length suffix) keeps the key short enough for
// an indexed PRIMARY KEY while making accidental collisions negligible
// at this scale (would need both djb2 hash AND length to match).

import { getDatabase } from '../database';
import type { RouteChoice } from './config';

// `provider` here is the route axis — 'on-device' or 'cloud' — not the
// specific cloud provider (Anthropic vs OpenAI). The dryrun-parity
// refactor narrowed this from AIProvider to RouteChoice: switching the
// per-chain route changes the cache key naturally, while transient
// cloud failovers (Anthropic → OpenAI) stay under the same key.
export type CacheKeyInput = {
  chain: string;
  provider: RouteChoice;
  promptVersion: string;
  system: string;
  user: string;
};

const NULL_BYTE = '\x00';

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h |= 0; // coerce to 32-bit
  }
  return (h >>> 0).toString(36);
}

export function deriveCacheKey(input: CacheKeyInput): string {
  const composite = [
    input.chain,
    input.provider,
    input.promptVersion,
    input.system,
    input.user,
  ].join(NULL_BYTE);
  return `${djb2(composite)}-${composite.length.toString(36)}`;
}

// Returns the cached result + model that served it, or null on miss.
// Callers that hit can skip the LLM call entirely and use the cached
// result as if it just came from the provider.
export async function getCached(input: CacheKeyInput): Promise<{
  result: string;
  modelServed: string;
} | null> {
  const db = await getDatabase();
  const key = deriveCacheKey(input);
  const row = await db.getFirstAsync<{
    result: string;
    model_served: string;
  }>('SELECT result, model_served FROM chain_cache WHERE cache_key = ?', [key]);
  if (!row) return null;
  return { result: row.result, modelServed: row.model_served };
}

// INSERT OR REPLACE — re-running the same chain with the same input
// overwrites the cached row with the latest output. Cheap; preserves
// invariant "one row per cache_key".
export async function setCached(
  input: CacheKeyInput,
  modelServed: string,
  result: string,
): Promise<void> {
  const db = await getDatabase();
  const key = deriveCacheKey(input);
  await db.runAsync(
    `INSERT OR REPLACE INTO chain_cache
     (cache_key, chain, provider, model_served, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [key, input.chain, input.provider, modelServed, result, Date.now()],
  );
}

// Wipes the whole cache. Wired to a Settings → AI → Clear cache button
// in a later commit; also useful if a chain regresses and needs a fresh
// start across the whole user base.
export async function clearAllCache(): Promise<number> {
  const db = await getDatabase();
  const r = await db.runAsync('DELETE FROM chain_cache');
  return r.changes;
}

// Reports row count + per-chain breakdown. Used by the Settings page
// (later commit) to surface "N cached entries" and let the user decide
// whether to clear.
export async function getCacheStats(): Promise<{
  rows: number;
  perChain: Record<string, number>;
}> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ chain: string; n: number }>(
    'SELECT chain, COUNT(*) as n FROM chain_cache GROUP BY chain',
  );
  const perChain: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    perChain[r.chain] = r.n;
    total += r.n;
  }
  return { rows: total, perChain };
}

// Convenience wrapper: lookup → call → write. Cache write failures are
// swallowed and logged — they never fail the user-facing call. This is
// the integration point most chain helpers use; classify's cascade has
// its own integration because it predicts the provider before calling
// (the cascade can fall back).
export async function cachedCall(
  input: CacheKeyInput,
  call: () => Promise<{ text: string; modelServed: string }>,
): Promise<{ text: string; modelServed: string }> {
  const cached = await getCached(input);
  if (cached) {
    return { text: cached.result, modelServed: cached.modelServed };
  }
  const result = await call();
  try {
    await setCached(input, result.modelServed, result.text);
  } catch (err) {
    console.warn('[buffr ai cache] setCached failed:', err);
  }
  return result;
}

// Best-effort cache write. Used by classify (and any chain that runs the
// LLM directly rather than through cachedCall) to avoid duplicating the
// try/catch boilerplate.
export async function writeCachedSafe(
  input: CacheKeyInput,
  modelServed: string,
  result: string,
): Promise<void> {
  try {
    await setCached(input, modelServed, result);
  } catch (err) {
    console.warn('[buffr ai cache] setCached failed:', err);
  }
}

// Optional cap: keep only the most-recent N rows. Exposed for a future
// maintenance pass; not currently wired. Useful if the cache grows
// unboundedly on a long-lived install.
export async function pruneCacheTo(maxRows: number): Promise<number> {
  const db = await getDatabase();
  const r = await db.runAsync(
    `DELETE FROM chain_cache WHERE cache_key IN (
       SELECT cache_key FROM chain_cache
       ORDER BY created_at DESC
       LIMIT -1 OFFSET ?
     )`,
    [maxRows],
  );
  return r.changes;
}
