// day_meta is keyed on `date` (no separate id column). Both push and pull
// treat date as the identity column.
import { getDatabase } from '../../database';
import type { SyncableTable } from '../types';

type DayMetaLocalRow = {
  date: string;
  title: string | null;
  updated_at: string | null;
  synced_at: string | null;
  deleted_at: string | null;
};

type DayMetaCloudRow = {
  user_id: string;
  date: string;
  title: string;
  updated_at: string;
  deleted_at: string | null;
};

export const dayMetaSyncable: SyncableTable<DayMetaLocalRow, DayMetaCloudRow> = {
  tableName: 'day_meta',
  pushOrder: 2,
  pullOrder: 2,
  cloudConflictColumns: ['user_id', 'date'],
  localIdColumn: 'date',

  getId: row => row.date,

  localToCloud(row, userId) {
    return {
      user_id: userId,
      date: row.date,
      title: row.title ?? '',
      updated_at: row.updated_at ?? new Date().toISOString(),
      deleted_at: row.deleted_at,
    };
  },

  cloudToLocal(row) {
    return {
      date: row.date,
      title: row.title,
      updated_at: row.updated_at,
      synced_at: null,
      deleted_at: row.deleted_at,
    };
  },

  async localQueryDirty() {
    const db = await getDatabase();
    return db.getAllAsync<DayMetaLocalRow>(
      `SELECT * FROM day_meta WHERE synced_at IS NULL OR (updated_at IS NOT NULL AND updated_at > synced_at)`,
    );
  },

  async localMarkSynced(date, syncedAt) {
    const db = await getDatabase();
    await db.runAsync('UPDATE day_meta SET synced_at = ? WHERE date = ?', [syncedAt, date]);
  },

  async localUpsert(row) {
    const db = await getDatabase();
    await db.runAsync(
      `INSERT INTO day_meta (date, title, updated_at, synced_at, deleted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at,
         deleted_at = excluded.deleted_at`,
      [row.date, row.title, row.updated_at, row.synced_at, row.deleted_at],
    );
  },
};
