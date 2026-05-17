// CRUD for the local `sync_meta` table — per-table sync ledger.
// See docs/buffr-cloud-sync-spec.md §3.5.
import { getDatabase } from '../database';

export type SyncMetaRow = {
  tableName: string;
  lastPullAt: string | null;
  lastPushAt: string | null;
  pendingPushes: number;
  lastError: string | null;
  lastErrorAt: string | null;
};

type RawRow = {
  table_name: string;
  last_pull_at: string | null;
  last_push_at: string | null;
  pending_pushes: number;
  last_error: string | null;
  last_error_at: string | null;
};

function mapRow(r: RawRow): SyncMetaRow {
  return {
    tableName: r.table_name,
    lastPullAt: r.last_pull_at,
    lastPushAt: r.last_push_at,
    pendingPushes: r.pending_pushes,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
  };
}

export async function getSyncMeta(tableName: string): Promise<SyncMetaRow | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<RawRow>(
    'SELECT * FROM sync_meta WHERE table_name = ?',
    [tableName],
  );
  return row ? mapRow(row) : null;
}

export async function getAllSyncMeta(): Promise<SyncMetaRow[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<RawRow>('SELECT * FROM sync_meta ORDER BY table_name ASC');
  return rows.map(mapRow);
}

export async function recordPushSuccess(
  tableName: string,
  pushedAt: string,
  pendingPushes: number,
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO sync_meta (table_name, last_push_at, pending_pushes, last_error, last_error_at)
       VALUES (?, ?, ?, NULL, NULL)
     ON CONFLICT(table_name) DO UPDATE SET
       last_push_at = excluded.last_push_at,
       pending_pushes = excluded.pending_pushes,
       last_error = NULL,
       last_error_at = NULL`,
    [tableName, pushedAt, pendingPushes],
  );
}

export async function recordPullSuccess(
  tableName: string,
  serverPullAt: string,
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO sync_meta (table_name, last_pull_at, last_error, last_error_at)
       VALUES (?, ?, NULL, NULL)
     ON CONFLICT(table_name) DO UPDATE SET
       last_pull_at = excluded.last_pull_at,
       last_error = NULL,
       last_error_at = NULL`,
    [tableName, serverPullAt],
  );
}

export async function recordSyncError(tableName: string, message: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO sync_meta (table_name, last_error, last_error_at)
       VALUES (?, ?, ?)
     ON CONFLICT(table_name) DO UPDATE SET
       last_error = excluded.last_error,
       last_error_at = excluded.last_error_at`,
    [tableName, message, now],
  );
}
