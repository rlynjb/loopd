// Cloud sync orchestrator. Walks the SyncableTable registry in defined
// order; failures log + continue (don't block other tables). Spec §4.4.
//
// M1 ships push-only on a single table. M2 adds the rest of the registry
// and the pull half. M4 adds the bootstrap path that picks initial-push vs
// first-pull vs no-op.
import { isCloudConfigured } from './client';
import { pushTable } from './push';
import type { PushResult, SyncableTable } from './types';
import { entriesSyncable } from './tables/entries';

// Single registry, ordered by pushOrder for push, pullOrder for pull.
// Adding a table = import + register here. The orchestrator does the rest.
const REGISTRY: SyncableTable<unknown, unknown>[] = [
  entriesSyncable as unknown as SyncableTable<unknown, unknown>,
  // M2 will register: projects, dayMeta, vlogs, aiSummaries, nutrition,
  // habits, todoMeta, threads, threadMentions
];

export async function pushAll(): Promise<PushResult[]> {
  if (!isCloudConfigured()) {
    console.log('[loopd sync] pushAll skipped: cloud not configured');
    return [];
  }
  const ordered = [...REGISTRY].sort((a, b) => a.pushOrder - b.pushOrder);
  const results: PushResult[] = [];
  for (const table of ordered) {
    try {
      const r = await pushTable(table);
      results.push(r);
      if (r.succeeded > 0 || r.failed > 0) {
        console.log(`[loopd sync] push ${r.tableName}: ${r.succeeded} ok, ${r.failed} failed`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[loopd sync] push ${table.tableName} threw:`, msg);
      results.push({ tableName: table.tableName, attempted: 0, succeeded: 0, failed: 0, error: msg });
    }
  }
  return results;
}

// Pull stub for M1. M2 implements the real version.
export async function pullAll(): Promise<void> {
  if (!isCloudConfigured()) return;
  // Intentionally a no-op until M2.
}
