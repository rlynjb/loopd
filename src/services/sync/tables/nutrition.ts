// nutrition rows reference entries via entry_id. Notion page id is dropped
// from the cloud mirror.
import { getDatabase } from '../../database';
import type { SyncableTable } from '../types';

type NutritionLocalRow = {
  id: string;
  name: string;
  kcal: number;
  entry_id: string;
  entry_date: string;
  source_line: number | null;
  notion_page_id: string | null;
  created_at: string;
  updated_at: string | null;
  synced_at: string | null;
  deleted_at: string | null;
};

type NutritionCloudRow = {
  user_id: string;
  id: string;
  name: string;
  kcal: number;
  entry_id: string;
  entry_date: string;
  source_line: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export const nutritionSyncable: SyncableTable<NutritionLocalRow, NutritionCloudRow> = {
  tableName: 'nutrition',
  pushOrder: 6,
  pullOrder: 8,
  cloudConflictColumns: ['user_id', 'id'],
  localIdColumn: 'id',

  getId: row => row.id,

  localToCloud(row, userId) {
    return {
      user_id: userId,
      id: row.id,
      name: row.name,
      kcal: row.kcal,
      entry_id: row.entry_id,
      entry_date: row.entry_date,
      source_line: row.source_line,
      created_at: row.created_at,
      updated_at: row.updated_at ?? row.created_at,
      deleted_at: row.deleted_at,
    };
  },

  cloudToLocal(row) {
    return {
      id: row.id,
      name: row.name,
      kcal: row.kcal,
      entry_id: row.entry_id,
      entry_date: row.entry_date,
      source_line: row.source_line,
      notion_page_id: null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      synced_at: null,
      deleted_at: row.deleted_at,
    };
  },

  async localQueryDirty() {
    const db = await getDatabase();
    return db.getAllAsync<NutritionLocalRow>(
      `SELECT * FROM nutrition WHERE synced_at IS NULL OR (updated_at IS NOT NULL AND updated_at > synced_at)`,
    );
  },

  async localMarkSynced(id, syncedAt) {
    const db = await getDatabase();
    await db.runAsync('UPDATE nutrition SET synced_at = ? WHERE id = ?', [syncedAt, id]);
  },

  async localUpsert(row) {
    const db = await getDatabase();
    await db.runAsync(
      `INSERT INTO nutrition (
         id, name, kcal, entry_id, entry_date, source_line, notion_page_id,
         created_at, updated_at, synced_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         kcal = excluded.kcal,
         entry_id = excluded.entry_id,
         entry_date = excluded.entry_date,
         source_line = excluded.source_line,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at,
         deleted_at = excluded.deleted_at`,
      [
        row.id, row.name, row.kcal, row.entry_id, row.entry_date, row.source_line,
        row.notion_page_id, row.created_at, row.updated_at, row.synced_at, row.deleted_at,
      ],
    );
  },
};
