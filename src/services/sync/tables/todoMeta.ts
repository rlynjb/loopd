// todo_meta — references entries via entry_id. Boolean for user_overridden_type.
// Identity column is todo_id (not id).
import { getDatabase } from '../../database';
import type { SyncableTable } from '../types';

type TodoMetaLocalRow = {
  todo_id: string;
  entry_id: string;
  entry_date: string;
  type: string | null;
  stage: string | null;
  expanded_md: string | null;
  expanded_at: string | null;
  model: string | null;
  classifier_confidence: string | null;
  classifier_model: string | null;
  user_overridden_type: number | null;
  position: number | null;
  pinned: number | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  deleted_at: string | null;
};

type TodoMetaCloudRow = {
  user_id: string;
  todo_id: string;
  entry_id: string;
  entry_date: string;
  type: string;
  stage: string;
  expanded_md: string | null;
  expanded_at: string | null;
  model: string | null;
  classifier_confidence: string | null;
  classifier_model: string | null;
  user_overridden_type: boolean;
  position: number | null;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export const todoMetaSyncable: SyncableTable<TodoMetaLocalRow, TodoMetaCloudRow> = {
  tableName: 'todo_meta',
  pushOrder: 5,
  pullOrder: 7,
  cloudConflictColumns: ['user_id', 'todo_id'],
  localIdColumn: 'todo_id',

  getId: row => row.todo_id,

  localToCloud(row, userId) {
    return {
      user_id: userId,
      todo_id: row.todo_id,
      entry_id: row.entry_id,
      entry_date: row.entry_date,
      type: row.type ?? 'todo',
      stage: row.stage ?? 'todo',
      expanded_md: row.expanded_md,
      expanded_at: row.expanded_at,
      model: row.model,
      classifier_confidence: row.classifier_confidence,
      classifier_model: row.classifier_model,
      user_overridden_type: row.user_overridden_type === 1,
      position: row.position,
      pinned: row.pinned === 1,
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
    };
  },

  cloudToLocal(row) {
    return {
      todo_id: row.todo_id,
      entry_id: row.entry_id,
      entry_date: row.entry_date,
      type: row.type,
      stage: row.stage,
      expanded_md: row.expanded_md,
      expanded_at: row.expanded_at,
      model: row.model,
      classifier_confidence: row.classifier_confidence,
      classifier_model: row.classifier_model,
      user_overridden_type: row.user_overridden_type ? 1 : 0,
      position: row.position,
      pinned: row.pinned ? 1 : 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
      synced_at: null,
      deleted_at: row.deleted_at,
    };
  },

  async localQueryDirty() {
    const db = await getDatabase();
    return db.getAllAsync<TodoMetaLocalRow>(
      `SELECT * FROM todo_meta WHERE synced_at IS NULL OR (updated_at IS NOT NULL AND updated_at > synced_at)`,
    );
  },

  async localMarkSynced(todoId, syncedAt) {
    const db = await getDatabase();
    await db.runAsync('UPDATE todo_meta SET synced_at = ? WHERE todo_id = ?', [syncedAt, todoId]);
  },

  async localUpsert(row) {
    const db = await getDatabase();
    await db.runAsync(
      `INSERT INTO todo_meta (
         todo_id, entry_id, entry_date, type, stage, expanded_md, expanded_at,
         model, classifier_confidence, classifier_model, user_overridden_type,
         position, pinned, created_at, updated_at, synced_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(todo_id) DO UPDATE SET
         entry_id = excluded.entry_id,
         entry_date = excluded.entry_date,
         type = excluded.type,
         stage = excluded.stage,
         expanded_md = excluded.expanded_md,
         expanded_at = excluded.expanded_at,
         model = excluded.model,
         classifier_confidence = excluded.classifier_confidence,
         classifier_model = excluded.classifier_model,
         user_overridden_type = excluded.user_overridden_type,
         position = excluded.position,
         pinned = excluded.pinned,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at,
         deleted_at = excluded.deleted_at`,
      [
        row.todo_id, row.entry_id, row.entry_date, row.type, row.stage,
        row.expanded_md, row.expanded_at, row.model, row.classifier_confidence,
        row.classifier_model, row.user_overridden_type, row.position,
        row.pinned ?? 0, row.created_at, row.updated_at, row.synced_at, row.deleted_at,
      ],
    );
  },
};
