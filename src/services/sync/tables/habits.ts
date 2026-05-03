// habits — booleans for archived; cadence_days is JSON-encoded as TEXT
// locally and JSONB in cloud. Notion fields dropped.
import { getDatabase } from '../../database';
import type { SyncableTable } from '../types';

type HabitLocalRow = {
  id: string;
  label: string;
  sort_order: number | null;
  slug: string | null;
  icon: string | null;
  color: string | null;
  cadence_type: string | null;
  cadence_days: string | null;
  cadence_count: number | null;
  archived: number | null;
  time_of_day: string | null;
  notion_page_id: string | null;
  notion_last_synced: string | null;
  updated_at: string | null;
  synced_at: string | null;
  deleted_at: string | null;
};

type HabitCloudRow = {
  user_id: string;
  id: string;
  label: string;
  sort_order: number;
  slug: string | null;
  icon: string | null;
  color: string | null;
  cadence_type: string;
  cadence_days: unknown;
  cadence_count: number | null;
  archived: boolean;
  time_of_day: string;
  updated_at: string;
  deleted_at: string | null;
};

const parseJson = (s: string | null): unknown => {
  if (s == null || s === '') return null;
  try { return JSON.parse(s); } catch { return null; }
};

export const habitsSyncable: SyncableTable<HabitLocalRow, HabitCloudRow> = {
  tableName: 'habits',
  pushOrder: 7,
  pullOrder: 5,
  cloudConflictColumns: ['user_id', 'id'],
  localIdColumn: 'id',

  getId: row => row.id,

  localToCloud(row, userId) {
    return {
      user_id: userId,
      id: row.id,
      label: row.label,
      sort_order: row.sort_order ?? 0,
      slug: row.slug,
      icon: row.icon,
      color: row.color,
      cadence_type: row.cadence_type ?? 'daily',
      cadence_days: parseJson(row.cadence_days),
      cadence_count: row.cadence_count,
      archived: row.archived === 1,
      time_of_day: row.time_of_day ?? 'anytime',
      updated_at: row.updated_at ?? new Date().toISOString(),
      deleted_at: row.deleted_at,
    };
  },

  cloudToLocal(row) {
    return {
      id: row.id,
      label: row.label,
      sort_order: row.sort_order,
      slug: row.slug,
      icon: row.icon,
      color: row.color,
      cadence_type: row.cadence_type,
      cadence_days: row.cadence_days == null ? null : JSON.stringify(row.cadence_days),
      cadence_count: row.cadence_count,
      archived: row.archived ? 1 : 0,
      time_of_day: row.time_of_day,
      notion_page_id: null,
      notion_last_synced: null,
      updated_at: row.updated_at,
      synced_at: null,
      deleted_at: row.deleted_at,
    };
  },

  async localQueryDirty() {
    const db = await getDatabase();
    return db.getAllAsync<HabitLocalRow>(
      `SELECT * FROM habits WHERE synced_at IS NULL OR (updated_at IS NOT NULL AND updated_at > synced_at)`,
    );
  },

  async localMarkSynced(id, syncedAt) {
    const db = await getDatabase();
    await db.runAsync('UPDATE habits SET synced_at = ? WHERE id = ?', [syncedAt, id]);
  },

  async localUpsert(row) {
    const db = await getDatabase();
    await db.runAsync(
      `INSERT INTO habits (
         id, label, sort_order, slug, icon, color, cadence_type, cadence_days,
         cadence_count, archived, time_of_day, notion_page_id, notion_last_synced,
         updated_at, synced_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         sort_order = excluded.sort_order,
         slug = excluded.slug,
         icon = excluded.icon,
         color = excluded.color,
         cadence_type = excluded.cadence_type,
         cadence_days = excluded.cadence_days,
         cadence_count = excluded.cadence_count,
         archived = excluded.archived,
         time_of_day = excluded.time_of_day,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at,
         deleted_at = excluded.deleted_at`,
      [
        row.id, row.label, row.sort_order, row.slug, row.icon, row.color,
        row.cadence_type, row.cadence_days, row.cadence_count, row.archived,
        row.time_of_day, row.notion_page_id, row.notion_last_synced,
        row.updated_at, row.synced_at, row.deleted_at,
      ],
    );
  },
};
