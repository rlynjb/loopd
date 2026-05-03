// First-pull (full restore) entry point. Used by bootstrap when local is
// empty AND cloud has data — typically a fresh device replacing a wiped one.
//
// Mechanics: resets sync_meta.last_pull_at to NULL for every table, then
// runs the regular pullAll(). pullAll's existing logic already pulls from
// epoch when last_pull_at is unset and paginates by updated_at ASC, so we
// don't need a separate code path — just guarantee the "from scratch"
// starting point.
//
// See docs/loopd-cloud-sync-spec.md §4.2.
import { getDatabase } from '../database';
import { pullAll } from './orchestrator';
import type { PullResult } from './pull';

const SYNCED_TABLES = [
  'entries', 'projects', 'day_meta', 'vlogs', 'ai_summaries',
  'nutrition', 'habits', 'todo_meta', 'threads', 'thread_mentions',
];

export async function firstPullAll(): Promise<PullResult[]> {
  const db = await getDatabase();
  for (const t of SYNCED_TABLES) {
    await db.runAsync(
      `INSERT INTO sync_meta (table_name, last_pull_at) VALUES (?, NULL)
         ON CONFLICT(table_name) DO UPDATE SET last_pull_at = NULL`,
      [t],
    );
  }
  return pullAll();
}
