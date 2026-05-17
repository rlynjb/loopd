// Generic incremental pull. See docs/buffr-cloud-sync-spec.md §4.2 + §4.7.
//
// 1. Get server time via RPC (avoids clock-skew bugs where a device's local
//    clock disagrees with the server's).
// 2. Query cloud for rows with updated_at > last_pull_at (per sync_meta).
// 3. For each row, run chooseWinner against local. Cloud or tie → upsert
//    local + stamp synced_at (so we don't immediately repush). Local → skip.
// 4. Stamp sync_meta.last_pull_at = server_time on success.
import { getSupabase } from './client';
import { chooseWinner } from './conflict';
import { getSyncMeta, recordPullSuccess, recordSyncError } from './syncMeta';
import type { SyncableTable } from './types';
import { getDatabase } from '../database';

export type PullResult = {
  tableName: string;
  fetched: number;
  applied: number;
  skipped: number;
  error?: string;
};

const PAGE_SIZE = 200;

async function getServerTime(): Promise<string> {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.rpc('get_server_time');
  if (error) throw new Error(`get_server_time RPC failed: ${error.message}`);
  if (!data) throw new Error('get_server_time RPC returned no data');
  return typeof data === 'string' ? data : new Date(data as number | Date).toISOString();
}

export async function pullTable<TLocal extends { updated_at: string | null; deleted_at: string | null }, TCloud extends { updated_at: string; deleted_at: string | null }>(
  table: SyncableTable<TLocal, TCloud>,
): Promise<PullResult> {
  const supabase = getSupabase();
  if (!supabase) {
    return { tableName: table.tableName, fetched: 0, applied: 0, skipped: 0, error: 'Supabase not configured' };
  }
  if (!table.localUpsert) {
    return { tableName: table.tableName, fetched: 0, applied: 0, skipped: 0, error: 'localUpsert not implemented' };
  }

  let serverTime: string;
  try {
    serverTime = await getServerTime();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordSyncError(table.tableName, msg);
    return { tableName: table.tableName, fetched: 0, applied: 0, skipped: 0, error: msg };
  }

  const meta = await getSyncMeta(table.tableName);
  const since = meta?.lastPullAt ?? '1970-01-01T00:00:00.000Z';

  let fetched = 0;
  let applied = 0;
  let skipped = 0;
  let lastErr: string | undefined;

  // Paginate by updated_at ASC so we never miss a row that lands during the loop.
  let cursor = since;
  for (;;) {
    const { data, error } = await supabase
      .from(table.tableName)
      .select('*')
      .gt('updated_at', cursor)
      .order('updated_at', { ascending: true })
      .limit(PAGE_SIZE);

    if (error) {
      lastErr = error.message;
      await recordSyncError(table.tableName, error.message);
      break;
    }
    if (!data || data.length === 0) break;

    fetched += data.length;
    for (const cloudRow of data as TCloud[]) {
      const localRow = table.cloudToLocal(cloudRow);
      const localId = table.getId(localRow);
      const existing = await fetchLocalRow<TLocal>(table.tableName, table.localIdColumn, localId);

      let winner: 'local' | 'cloud' | 'tie' = 'cloud';
      if (existing && existing.updated_at) {
        winner = chooseWinner(
          { updated_at: existing.updated_at, deleted_at: existing.deleted_at },
          { updated_at: cloudRow.updated_at, deleted_at: cloudRow.deleted_at },
        );
      }

      if (winner === 'local') {
        skipped++;
        continue;
      }

      // Stamp synced_at so the just-pulled row isn't re-flagged as dirty.
      const stampedRow = { ...localRow, synced_at: serverTime } as TLocal;
      await table.localUpsert(stampedRow);
      applied++;
    }

    // Advance cursor to the highest updated_at in this page; loop will
    // terminate when the next query returns empty.
    cursor = (data[data.length - 1] as TCloud).updated_at;
    if (data.length < PAGE_SIZE) break;
  }

  if (!lastErr) {
    await recordPullSuccess(table.tableName, serverTime);
  }
  return { tableName: table.tableName, fetched, applied, skipped, error: lastErr };
}

// Tiny local row fetcher — avoids forcing every SyncableTable to expose a
// localGetById method when the WHERE clause is identical across tables.
async function fetchLocalRow<TLocal>(
  tableName: string,
  idColumn: string,
  id: string,
): Promise<TLocal | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<TLocal>(
    `SELECT * FROM ${tableName} WHERE ${idColumn} = ?`,
    [id],
  );
  return row ?? null;
}
