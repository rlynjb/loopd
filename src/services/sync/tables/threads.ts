// threads — booleans for archived + pinned. Notion fields dropped.
import { getDatabase } from '../../database';
import type { SyncableTable } from '../types';

type ThreadLocalRow = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  color: string | null;
  target_cadence_days: number | null;
  archived: number | null;
  pinned: number | null;
  time_of_day: string | null;
  notion_page_id: string | null;
  notion_last_synced: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
};

type ThreadCloudRow = {
  user_id: string;
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  color: string | null;
  target_cadence_days: number | null;
  archived: boolean;
  pinned: boolean;
  time_of_day: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export const threadsSyncable: SyncableTable<ThreadLocalRow, ThreadCloudRow> = {
  tableName: 'threads',
  pushOrder: 8,
  pullOrder: 6,
  cloudConflictColumns: ['user_id', 'id'],
  localIdColumn: 'id',

  getId: row => row.id,

  localToCloud(row, userId) {
    return {
      user_id: userId,
      id: row.id,
      name: row.name,
      slug: row.slug,
      icon: row.icon,
      color: row.color,
      target_cadence_days: row.target_cadence_days,
      archived: row.archived === 1,
      pinned: row.pinned === 1,
      time_of_day: row.time_of_day ?? 'anytime',
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
    };
  },

  cloudToLocal(row) {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      icon: row.icon,
      color: row.color,
      target_cadence_days: row.target_cadence_days,
      archived: row.archived ? 1 : 0,
      pinned: row.pinned ? 1 : 0,
      time_of_day: row.time_of_day,
      notion_page_id: null,
      notion_last_synced: null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      synced_at: null,
      deleted_at: row.deleted_at,
    };
  },

  async localQueryDirty() {
    const db = await getDatabase();
    return db.getAllAsync<ThreadLocalRow>(
      `SELECT * FROM threads WHERE synced_at IS NULL OR (updated_at IS NOT NULL AND updated_at > synced_at)`,
    );
  },

  async localMarkSynced(id, syncedAt) {
    const db = await getDatabase();
    await db.runAsync('UPDATE threads SET synced_at = ? WHERE id = ?', [syncedAt, id]);
  },

  async localUpsert(row) {
    const db = await getDatabase();
    await db.runAsync(
      `INSERT INTO threads (
         id, name, slug, icon, color, target_cadence_days, archived, pinned,
         time_of_day, notion_page_id, notion_last_synced,
         created_at, updated_at, synced_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         slug = excluded.slug,
         icon = excluded.icon,
         color = excluded.color,
         target_cadence_days = excluded.target_cadence_days,
         archived = excluded.archived,
         pinned = excluded.pinned,
         time_of_day = excluded.time_of_day,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at,
         deleted_at = excluded.deleted_at`,
      [
        row.id, row.name, row.slug, row.icon, row.color, row.target_cadence_days,
        row.archived, row.pinned, row.time_of_day, row.notion_page_id,
        row.notion_last_synced, row.created_at, row.updated_at,
        row.synced_at, row.deleted_at,
      ],
    );
  },
};
