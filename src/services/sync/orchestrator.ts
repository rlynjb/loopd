// Cloud sync orchestrator. Walks the SyncableTable registry in defined
// order; failures log + continue (don't block other tables). Spec §4.4.
//
// M2 ships push + incremental pull on all 10 synced tables. M4 adds the
// bootstrap path that picks initial-push vs first-pull vs no-op.
import { isCloudConfigured } from './client';
import { pushTable } from './push';
import { pullTable, type PullResult } from './pull';
import type { PushResult, SyncableTable } from './types';
import { entriesSyncable } from './tables/entries';
import { projectsSyncable } from './tables/projects';
import { dayMetaSyncable } from './tables/dayMeta';
import { vlogsSyncable } from './tables/vlogs';
import { aiSummariesSyncable } from './tables/aiSummaries';
import { nutritionSyncable } from './tables/nutrition';
import { habitsSyncable } from './tables/habits';
import { todoMetaSyncable } from './tables/todoMeta';

// Cast to the type-erased shape for the registry — each table's TLocal /
// TCloud generics differ, but the orchestrator only calls interface methods.
type AnySyncable = SyncableTable<{ updated_at: string | null; deleted_at: string | null }, { updated_at: string; deleted_at: string | null }>;

const REGISTRY: AnySyncable[] = [
  entriesSyncable as unknown as AnySyncable,
  projectsSyncable as unknown as AnySyncable,
  dayMetaSyncable as unknown as AnySyncable,
  vlogsSyncable as unknown as AnySyncable,
  aiSummariesSyncable as unknown as AnySyncable,
  nutritionSyncable as unknown as AnySyncable,
  habitsSyncable as unknown as AnySyncable,
  todoMetaSyncable as unknown as AnySyncable,
];

export async function pushAll(): Promise<PushResult[]> {
  if (!isCloudConfigured()) {
    console.log('[buffr sync] pushAll skipped: cloud not configured');
    return [];
  }
  const ordered = [...REGISTRY].sort((a, b) => a.pushOrder - b.pushOrder);
  const results: PushResult[] = [];
  for (const table of ordered) {
    try {
      const r = await pushTable(table);
      results.push(r);
      if (r.succeeded > 0 || r.failed > 0) {
        console.log(`[buffr sync] push ${r.tableName}: ${r.succeeded} ok, ${r.failed} failed`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[buffr sync] push ${table.tableName} threw:`, msg);
      results.push({ tableName: table.tableName, attempted: 0, succeeded: 0, failed: 0, error: msg });
    }
  }
  return results;
}

export async function pullAll(): Promise<PullResult[]> {
  if (!isCloudConfigured()) {
    console.log('[buffr sync] pullAll skipped: cloud not configured');
    return [];
  }
  const ordered = [...REGISTRY].sort((a, b) => a.pullOrder - b.pullOrder);
  const results: PullResult[] = [];
  for (const table of ordered) {
    try {
      const r = await pullTable(table);
      results.push(r);
      if (r.applied > 0 || r.fetched > 0) {
        console.log(`[buffr sync] pull ${r.tableName}: ${r.applied} applied, ${r.skipped} skipped (of ${r.fetched})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[buffr sync] pull ${table.tableName} threw:`, msg);
      results.push({ tableName: table.tableName, fetched: 0, applied: 0, skipped: 0, error: msg });
    }
  }
  return results;
}
