// Generic push: query rows where updated_at > synced_at, batch-upsert to
// cloud, stamp synced_at on success. See docs/loopd-cloud-sync-spec.md §4.2.
import { getSupabase, PHASE_A_USER_ID } from './client';
import { recordPushSuccess, recordSyncError } from './syncMeta';
import type { PushResult, SyncableTable } from './types';

const BATCH_SIZE = 50;

export async function pushTable<TLocal, TCloud>(
  table: SyncableTable<TLocal, TCloud>,
): Promise<PushResult> {
  const supabase = getSupabase();
  if (!supabase) {
    return { tableName: table.tableName, attempted: 0, succeeded: 0, failed: 0, error: 'Supabase not configured' };
  }

  const dirty = await table.localQueryDirty();
  if (dirty.length === 0) {
    await recordPushSuccess(table.tableName, new Date().toISOString(), 0);
    return { tableName: table.tableName, attempted: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;
  let lastErr: string | undefined;

  for (let offset = 0; offset < dirty.length; offset += BATCH_SIZE) {
    const batch = dirty.slice(offset, offset + BATCH_SIZE);
    const cloudRows = batch.map(row => table.localToCloud(row, PHASE_A_USER_ID));

    const { error } = await supabase
      .from(table.tableName)
      .upsert(cloudRows as object[], {
        onConflict: table.cloudConflictColumns.join(','),
      });

    if (error) {
      failed += batch.length;
      lastErr = error.message;
      console.warn(`[loopd sync] push ${table.tableName} batch failed:`, error.message);
      // Don't stamp synced_at on the failed batch — it'll retry next push.
      continue;
    }

    // Stamp synced_at on each row in the batch. Single timestamp per batch
    // is fine — the precision of our scheduling doesn't need per-row.
    const stampedAt = new Date().toISOString();
    for (const row of batch) {
      await table.localMarkSynced(table.getId(row), stampedAt);
    }
    succeeded += batch.length;
  }

  if (failed === 0) {
    await recordPushSuccess(table.tableName, new Date().toISOString(), 0);
  } else {
    await recordSyncError(table.tableName, lastErr ?? 'unknown push error');
  }

  return {
    tableName: table.tableName,
    attempted: dirty.length,
    succeeded,
    failed,
    error: lastErr,
  };
}
