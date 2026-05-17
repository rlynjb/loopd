// Cloud sync bootstrap detection. Runs on first cold start after the
// cloud-sync feature ships; decides whether to:
//   - no-op (both sides empty)
//   - initial-push (local has data, cloud is empty)
//   - first-pull (local is empty, cloud has data — fresh device recovery)
//   - default to initial-push (both populated — solo Phase A)
//
// SecureStore-gated by `cloud_initial_push_done` so it only runs once per
// install. After the flag is set, normal incremental sync takes over.
//
// See docs/buffr-cloud-sync-spec.md §5.3.
import * as SecureStore from 'expo-secure-store';
import { getDatabase } from '../database';
import { getSupabase, isCloudConfigured, PHASE_A_USER_ID } from './client';
import { pushAll } from './orchestrator';
import { firstPullAll } from './firstPull';

const BOOTSTRAP_KEY = 'cloud_initial_push_done';

export type BootstrapDecision =
  | { action: 'skipped'; reason: 'not-configured' | 'flag-set' }
  | { action: 'no-op'; reason: 'both-empty' }
  | { action: 'initial-push'; pushed: number }
  | { action: 'first-pull'; pulled: number }
  | { action: 'initial-push-fallback'; pushed: number; reason: 'both-populated' };

export async function isBootstrapDone(): Promise<boolean> {
  const v = await SecureStore.getItemAsync(BOOTSTRAP_KEY);
  return !!v;
}

async function markBootstrapDone(): Promise<void> {
  await SecureStore.setItemAsync(BOOTSTRAP_KEY, '1');
}

async function localHasData(): Promise<boolean> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM entries WHERE deleted_at IS NULL',
  );
  return (row?.c ?? 0) > 0;
}

async function cloudHasData(): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { count, error } = await supabase
    .from('entries')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', PHASE_A_USER_ID)
    .is('deleted_at', null);
  if (error) {
    console.warn('[buffr sync] bootstrap cloudHasData check failed:', error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

export async function bootstrapCloudSync(): Promise<BootstrapDecision> {
  if (!isCloudConfigured()) {
    return { action: 'skipped', reason: 'not-configured' };
  }
  if (await isBootstrapDone()) {
    return { action: 'skipped', reason: 'flag-set' };
  }

  const [hasLocal, hasCloud] = await Promise.all([localHasData(), cloudHasData()]);

  if (!hasLocal && !hasCloud) {
    await markBootstrapDone();
    return { action: 'no-op', reason: 'both-empty' };
  }

  if (hasLocal && !hasCloud) {
    const results = await pushAll();
    const pushed = results.reduce((sum, r) => sum + r.succeeded, 0);
    await markBootstrapDone();
    return { action: 'initial-push', pushed };
  }

  if (!hasLocal && hasCloud) {
    const results = await firstPullAll();
    const pulled = results.reduce((sum, r) => sum + r.applied, 0);
    await markBootstrapDone();
    return { action: 'first-pull', pulled };
  }

  // Both populated. Solo Phase A doesn't need a UI prompt — log and default
  // to initial push (assumes local is the trusted source). Phase B should
  // expose a "pick which side wins" dialog before any destructive action.
  console.warn('[buffr sync] bootstrap: both local AND cloud have data. Defaulting to initial push (local is canonical).');
  const results = await pushAll();
  const pushed = results.reduce((sum, r) => sum + r.succeeded, 0);
  await markBootstrapDone();
  return { action: 'initial-push-fallback', pushed, reason: 'both-populated' };
}
