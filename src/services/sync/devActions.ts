// Dev-menu-only sync actions. Destructive operations gated behind a
// hidden long-press in the Cloud Sync settings page. Phase A only — these
// don't ship as a public UX surface (spec §5.2).
import { getDatabase } from '../database';
import { getSupabase, isCloudConfigured, PHASE_A_USER_ID } from './client';
import { pushAll } from './orchestrator';
import { firstPullAll } from './firstPull';
import type { PushResult } from './types';
import type { PullResult } from './pull';

const SYNCED_TABLES = [
  'entries', 'projects', 'day_meta', 'vlogs', 'ai_summaries',
  'nutrition', 'habits', 'todo_meta', 'threads', 'thread_mentions',
];

/**
 * Re-push every local row by clearing synced_at first. Useful after a
 * "reset cloud database" when local hasn't changed but cloud is empty.
 * Bypasses the normal "updated_at > synced_at" gating.
 */
export async function forcePushAll(): Promise<PushResult[]> {
  const db = await getDatabase();
  for (const t of SYNCED_TABLES) {
    await db.runAsync(`UPDATE ${t} SET synced_at = NULL`);
  }
  return pushAll();
}

/**
 * Drop every cloud row for the Phase A dummy user. Local untouched.
 * After this runs, forcePushAll() rebuilds cloud from local.
 */
export async function resetCloud(): Promise<{ ok: boolean; error?: string; deleted: Record<string, number> }> {
  const supabase = getSupabase();
  if (!supabase) return { ok: false, error: 'Supabase not configured', deleted: {} };
  const deleted: Record<string, number> = {};
  for (const t of SYNCED_TABLES) {
    // Children before parents to avoid FK cascade noise — delete reverse
    // pull-order, which is roughly (mentions/nutrition/todo_meta) before
    // (threads/habits/entries).
    const { error, count } = await supabase
      .from(t)
      .delete({ count: 'exact' })
      .eq('user_id', PHASE_A_USER_ID);
    if (error) {
      return { ok: false, error: `${t}: ${error.message}`, deleted };
    }
    deleted[t] = count ?? 0;
  }
  return { ok: true, deleted };
}

/**
 * Wipe local synced tables + sync_meta + bootstrap flag, then run firstPull.
 * The "I trust cloud, rebuild local from it" recovery path. Very destructive.
 *
 * Does NOT delete .env / SecureStore-managed secrets, AI keys, Notion token,
 * or the cloud_initial_push_done flag itself (we re-set it after firstPull).
 *
 * Caller MUST double-confirm before invoking.
 */
export async function resetLocalFromCloud(): Promise<{
  ok: boolean;
  error?: string;
  pulled: PullResult[];
}> {
  if (!isCloudConfigured()) {
    return { ok: false, error: 'Supabase not configured', pulled: [] };
  }
  const db = await getDatabase();

  // Drop sync_deletions too (it's local-only, doesn't matter for cloud).
  // Don't drop schema — just truncate. Children before parents to avoid
  // cascade-delete order issues (sqlite has no enforced FKs but clean is clean).
  const truncationOrder = [
    'thread_mentions', 'nutrition', 'todo_meta', 'threads', 'habits',
    'ai_summaries', 'vlogs', 'day_meta', 'projects', 'entries',
    'sync_deletions', 'sync_meta',
  ];
  for (const t of truncationOrder) {
    try {
      await db.runAsync(`DELETE FROM ${t}`);
    } catch (err) {
      // sync_deletions might not exist if a fresh install never had Notion.
      console.warn(`[buffr sync] resetLocalFromCloud: skipped ${t}:`, err instanceof Error ? err.message : err);
    }
  }
  // Pull everything from cloud.
  const pulled = await firstPullAll();
  return { ok: true, pulled };
}
