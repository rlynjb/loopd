// SyncableTable for the `entries` table — first implementation, used by M1
// to validate the push half of the orchestrator end-to-end before the other
// nine tables land in M2.
//
// Local row carries TEXT JSON columns (habits_json / todos_json / clips_json)
// and ISO TEXT timestamps. Cloud row uses JSONB and TIMESTAMPTZ; supabase-js
// serializes JS objects/strings transparently for both.
//
// notion_page_id is intentionally dropped from the cloud mirror — Notion is
// being deprecated. The local column stays during the dual-run window.
import { getDatabase } from '../../database';
import type { SyncableTable } from '../types';

export type EntryLocalRow = {
  id: string;
  date: string;
  text: string | null;
  habits_json: string | null;
  todos_json: string | null;
  clip_uri: string | null;
  clip_duration_ms: number | null;
  clips_json: string | null;
  created_at: string;
  notion_page_id: string | null;
  updated_at: string | null;
  synced_at: string | null;
  deleted_at: string | null;
};

export type EntryCloudRow = {
  user_id: string;
  id: string;
  date: string;
  text: string | null;
  habits_json: unknown;
  todos_json: unknown;
  clip_uri: string | null;
  clip_duration_ms: number | null;
  clips_json: unknown;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

function safeJson(s: string | null): unknown {
  if (s == null || s === '') return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function jsonOrEmpty(s: string | null): unknown {
  // For habits_json / todos_json we want [] not null in cloud, so the dashboard
  // ranking + JSONB array operators behave consistently.
  return safeJson(s) ?? [];
}

export const entriesSyncable: SyncableTable<EntryLocalRow, EntryCloudRow> = {
  tableName: 'entries',
  pushOrder: 0,
  pullOrder: 0,
  cloudConflictColumns: ['user_id', 'id'],
  localIdColumn: 'id',

  getId(row) {
    return row.id;
  },

  localToCloud(row, userId) {
    return {
      user_id: userId,
      id: row.id,
      date: row.date,
      text: row.text,
      habits_json: jsonOrEmpty(row.habits_json),
      todos_json: jsonOrEmpty(row.todos_json),
      clip_uri: row.clip_uri,
      clip_duration_ms: row.clip_duration_ms,
      clips_json: jsonOrEmpty(row.clips_json),
      created_at: row.created_at,
      updated_at: row.updated_at ?? row.created_at,
      deleted_at: row.deleted_at,
    };
  },

  cloudToLocal(row) {
    return {
      id: row.id,
      date: row.date,
      text: row.text,
      habits_json: row.habits_json == null ? null : JSON.stringify(row.habits_json),
      todos_json: row.todos_json == null ? null : JSON.stringify(row.todos_json),
      clip_uri: row.clip_uri,
      clip_duration_ms: row.clip_duration_ms,
      clips_json: row.clips_json == null ? null : JSON.stringify(row.clips_json),
      created_at: row.created_at,
      notion_page_id: null,
      updated_at: row.updated_at,
      synced_at: null,
      deleted_at: row.deleted_at,
    };
  },

  async localQueryDirty() {
    const db = await getDatabase();
    return db.getAllAsync<EntryLocalRow>(
      `SELECT * FROM entries
       WHERE synced_at IS NULL
          OR (updated_at IS NOT NULL AND updated_at > synced_at)`,
    );
  },

  async localMarkSynced(id, syncedAt) {
    const db = await getDatabase();
    await db.runAsync('UPDATE entries SET synced_at = ? WHERE id = ?', [syncedAt, id]);
  },

  async localUpsert(row) {
    const db = await getDatabase();
    await db.runAsync(
      `INSERT INTO entries (
         id, date, text, habits_json, todos_json, clip_uri, clip_duration_ms,
         clips_json, created_at, notion_page_id, updated_at, synced_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         date = excluded.date,
         text = excluded.text,
         habits_json = excluded.habits_json,
         todos_json = excluded.todos_json,
         clip_uri = excluded.clip_uri,
         clip_duration_ms = excluded.clip_duration_ms,
         clips_json = excluded.clips_json,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at,
         deleted_at = excluded.deleted_at`,
      [
        row.id, row.date, row.text, row.habits_json, row.todos_json,
        row.clip_uri, row.clip_duration_ms, row.clips_json,
        row.created_at, row.notion_page_id, row.updated_at, row.synced_at, row.deleted_at,
      ],
    );
  },
};
