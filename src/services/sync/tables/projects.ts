import { getDatabase } from '../../database';
import type { SyncableTable } from '../types';

type ProjectLocalRow = {
  id: string;
  date: string;
  status: string | null;
  clips_json: string | null;
  removed_clip_source_keys_json: string | null;
  text_overlays_json: string | null;
  filter_overlays_json: string | null;
  export_uri: string | null;
  updated_at: string | null;
  synced_at: string | null;
  deleted_at: string | null;
};

type ProjectCloudRow = {
  user_id: string;
  id: string;
  date: string;
  status: string;
  clips_json: unknown;
  removed_clip_source_keys_json: unknown;
  text_overlays_json: unknown;
  filter_overlays_json: unknown;
  export_uri: string | null;
  updated_at: string;
  deleted_at: string | null;
};

const parseJson = (s: string | null): unknown => {
  if (s == null || s === '') return null;
  try { return JSON.parse(s); } catch { return null; }
};
const stringifyOrNull = (v: unknown): string | null => v == null ? null : JSON.stringify(v);

export const projectsSyncable: SyncableTable<ProjectLocalRow, ProjectCloudRow> = {
  tableName: 'projects',
  pushOrder: 1,
  pullOrder: 1,
  cloudConflictColumns: ['user_id', 'id'],
  localIdColumn: 'id',

  getId: row => row.id,

  localToCloud(row, userId) {
    return {
      user_id: userId,
      id: row.id,
      date: row.date,
      status: row.status ?? 'draft',
      clips_json: parseJson(row.clips_json) ?? [],
      removed_clip_source_keys_json: parseJson(row.removed_clip_source_keys_json) ?? [],
      text_overlays_json: parseJson(row.text_overlays_json) ?? [],
      filter_overlays_json: parseJson(row.filter_overlays_json) ?? [],
      export_uri: row.export_uri,
      updated_at: row.updated_at ?? new Date().toISOString(),
      deleted_at: row.deleted_at,
    };
  },

  cloudToLocal(row) {
    return {
      id: row.id,
      date: row.date,
      status: row.status,
      clips_json: stringifyOrNull(row.clips_json),
      removed_clip_source_keys_json: stringifyOrNull(row.removed_clip_source_keys_json),
      text_overlays_json: stringifyOrNull(row.text_overlays_json),
      filter_overlays_json: stringifyOrNull(row.filter_overlays_json),
      export_uri: row.export_uri,
      updated_at: row.updated_at,
      synced_at: null,
      deleted_at: row.deleted_at,
    };
  },

  async localQueryDirty() {
    const db = await getDatabase();
    return db.getAllAsync<ProjectLocalRow>(
      `SELECT * FROM projects WHERE synced_at IS NULL OR (updated_at IS NOT NULL AND updated_at > synced_at)`,
    );
  },

  async localMarkSynced(id, syncedAt) {
    const db = await getDatabase();
    await db.runAsync('UPDATE projects SET synced_at = ? WHERE id = ?', [syncedAt, id]);
  },

  async localUpsert(row) {
    const db = await getDatabase();
    await db.runAsync(
      `INSERT INTO projects (
         id, date, status, clips_json, removed_clip_source_keys_json,
         text_overlays_json, filter_overlays_json, export_uri,
         updated_at, synced_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         date = excluded.date,
         status = excluded.status,
         clips_json = excluded.clips_json,
         removed_clip_source_keys_json = excluded.removed_clip_source_keys_json,
         text_overlays_json = excluded.text_overlays_json,
         filter_overlays_json = excluded.filter_overlays_json,
         export_uri = excluded.export_uri,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at,
         deleted_at = excluded.deleted_at`,
      [
        row.id, row.date, row.status, row.clips_json, row.removed_clip_source_keys_json,
        row.text_overlays_json, row.filter_overlays_json, row.export_uri,
        row.updated_at, row.synced_at, row.deleted_at,
      ],
    );
  },
};
