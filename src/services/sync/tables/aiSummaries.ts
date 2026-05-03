// ai_summaries is keyed on `date`. summary_json carries both the structured
// AISummary and the optional relatable-caption fields per spec §3.7.
import { getDatabase } from '../../database';
import type { SyncableTable } from '../types';

type AISummaryLocalRow = {
  date: string;
  summary_json: string;
  generated_at: string;
  model: string;
  updated_at: string | null;
  synced_at: string | null;
  deleted_at: string | null;
};

type AISummaryCloudRow = {
  user_id: string;
  date: string;
  summary_json: unknown;
  generated_at: string;
  model: string;
  updated_at: string;
  deleted_at: string | null;
};

const parseJson = (s: string | null): unknown => {
  if (s == null || s === '') return null;
  try { return JSON.parse(s); } catch { return null; }
};

export const aiSummariesSyncable: SyncableTable<AISummaryLocalRow, AISummaryCloudRow> = {
  tableName: 'ai_summaries',
  pushOrder: 4,
  pullOrder: 4,
  cloudConflictColumns: ['user_id', 'date'],
  localIdColumn: 'date',

  getId: row => row.date,

  localToCloud(row, userId) {
    return {
      user_id: userId,
      date: row.date,
      summary_json: parseJson(row.summary_json) ?? {},
      generated_at: row.generated_at,
      model: row.model,
      updated_at: row.updated_at ?? row.generated_at,
      deleted_at: row.deleted_at,
    };
  },

  cloudToLocal(row) {
    return {
      date: row.date,
      summary_json: row.summary_json == null ? '' : JSON.stringify(row.summary_json),
      generated_at: row.generated_at,
      model: row.model,
      updated_at: row.updated_at,
      synced_at: null,
      deleted_at: row.deleted_at,
    };
  },

  async localQueryDirty() {
    const db = await getDatabase();
    return db.getAllAsync<AISummaryLocalRow>(
      `SELECT * FROM ai_summaries WHERE synced_at IS NULL OR (updated_at IS NOT NULL AND updated_at > synced_at)`,
    );
  },

  async localMarkSynced(date, syncedAt) {
    const db = await getDatabase();
    await db.runAsync('UPDATE ai_summaries SET synced_at = ? WHERE date = ?', [syncedAt, date]);
  },

  async localUpsert(row) {
    const db = await getDatabase();
    await db.runAsync(
      `INSERT INTO ai_summaries (
         date, summary_json, generated_at, model, updated_at, synced_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         summary_json = excluded.summary_json,
         generated_at = excluded.generated_at,
         model = excluded.model,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at,
         deleted_at = excluded.deleted_at`,
      [
        row.date, row.summary_json, row.generated_at, row.model,
        row.updated_at, row.synced_at, row.deleted_at,
      ],
    );
  },
};
