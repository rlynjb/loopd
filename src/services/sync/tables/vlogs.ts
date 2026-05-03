// vlogs.export_uri is a device-local file path; sync round-trips it but the
// URI is meaningless on a different device (spec §12 open question). Other
// metadata fields (clip_count, habit_count, caption, duration_seconds) are
// portable.
import { getDatabase } from '../../database';
import type { SyncableTable } from '../types';

type VlogLocalRow = {
  id: string;
  date: string;
  clip_count: number | null;
  habit_count: number | null;
  caption: string | null;
  duration_seconds: number | null;
  export_uri: string | null;
  created_at: string;
  updated_at: string | null;
  synced_at: string | null;
  deleted_at: string | null;
};

type VlogCloudRow = {
  user_id: string;
  id: string;
  date: string;
  clip_count: number;
  habit_count: number;
  caption: string | null;
  duration_seconds: number | null;
  export_uri: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export const vlogsSyncable: SyncableTable<VlogLocalRow, VlogCloudRow> = {
  tableName: 'vlogs',
  pushOrder: 3,
  pullOrder: 3,
  cloudConflictColumns: ['user_id', 'id'],
  localIdColumn: 'id',

  getId: row => row.id,

  localToCloud(row, userId) {
    return {
      user_id: userId,
      id: row.id,
      date: row.date,
      clip_count: row.clip_count ?? 0,
      habit_count: row.habit_count ?? 0,
      caption: row.caption,
      duration_seconds: row.duration_seconds,
      export_uri: row.export_uri,
      created_at: row.created_at,
      updated_at: row.updated_at ?? row.created_at,
      deleted_at: row.deleted_at,
    };
  },

  cloudToLocal(row) {
    return {
      id: row.id,
      date: row.date,
      clip_count: row.clip_count,
      habit_count: row.habit_count,
      caption: row.caption,
      duration_seconds: row.duration_seconds,
      export_uri: row.export_uri,
      created_at: row.created_at,
      updated_at: row.updated_at,
      synced_at: null,
      deleted_at: row.deleted_at,
    };
  },

  async localQueryDirty() {
    const db = await getDatabase();
    return db.getAllAsync<VlogLocalRow>(
      `SELECT * FROM vlogs WHERE synced_at IS NULL OR (updated_at IS NOT NULL AND updated_at > synced_at)`,
    );
  },

  async localMarkSynced(id, syncedAt) {
    const db = await getDatabase();
    await db.runAsync('UPDATE vlogs SET synced_at = ? WHERE id = ?', [syncedAt, id]);
  },

  async localUpsert(row) {
    const db = await getDatabase();
    await db.runAsync(
      `INSERT INTO vlogs (
         id, date, clip_count, habit_count, caption, duration_seconds,
         export_uri, created_at, updated_at, synced_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         date = excluded.date,
         clip_count = excluded.clip_count,
         habit_count = excluded.habit_count,
         caption = excluded.caption,
         duration_seconds = excluded.duration_seconds,
         export_uri = excluded.export_uri,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at,
         deleted_at = excluded.deleted_at`,
      [
        row.id, row.date, row.clip_count, row.habit_count, row.caption,
        row.duration_seconds, row.export_uri, row.created_at, row.updated_at,
        row.synced_at, row.deleted_at,
      ],
    );
  },
};
