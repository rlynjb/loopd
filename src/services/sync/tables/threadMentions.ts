// thread_mentions — junction. NULL entry_id AND NULL todo_id is permitted
// (manual-touch deviation per spec §6.6). updated_at was added in M0 so
// sync uniformity works.
import { getDatabase } from '../../database';
import type { SyncableTable } from '../types';

type ThreadMentionLocalRow = {
  id: string;
  thread_id: string;
  entry_id: string | null;
  entry_date: string;
  todo_id: string | null;
  source_line: number | null;
  tag_text: string;
  created_at: string;
  updated_at: string | null;
  synced_at: string | null;
  deleted_at: string | null;
};

type ThreadMentionCloudRow = {
  user_id: string;
  id: string;
  thread_id: string;
  entry_id: string | null;
  entry_date: string;
  todo_id: string | null;
  source_line: number;
  tag_text: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export const threadMentionsSyncable: SyncableTable<ThreadMentionLocalRow, ThreadMentionCloudRow> = {
  tableName: 'thread_mentions',
  pushOrder: 9,
  pullOrder: 9,
  cloudConflictColumns: ['user_id', 'id'],
  localIdColumn: 'id',

  getId: row => row.id,

  localToCloud(row, userId) {
    return {
      user_id: userId,
      id: row.id,
      thread_id: row.thread_id,
      entry_id: row.entry_id,
      entry_date: row.entry_date,
      todo_id: row.todo_id,
      source_line: row.source_line ?? 0,
      tag_text: row.tag_text,
      created_at: row.created_at,
      updated_at: row.updated_at ?? row.created_at,
      deleted_at: row.deleted_at,
    };
  },

  cloudToLocal(row) {
    return {
      id: row.id,
      thread_id: row.thread_id,
      entry_id: row.entry_id,
      entry_date: row.entry_date,
      todo_id: row.todo_id,
      source_line: row.source_line,
      tag_text: row.tag_text,
      created_at: row.created_at,
      updated_at: row.updated_at,
      synced_at: null,
      deleted_at: row.deleted_at,
    };
  },

  async localQueryDirty() {
    const db = await getDatabase();
    return db.getAllAsync<ThreadMentionLocalRow>(
      `SELECT * FROM thread_mentions WHERE synced_at IS NULL OR (updated_at IS NOT NULL AND updated_at > synced_at)`,
    );
  },

  async localMarkSynced(id, syncedAt) {
    const db = await getDatabase();
    await db.runAsync('UPDATE thread_mentions SET synced_at = ? WHERE id = ?', [syncedAt, id]);
  },

  async localUpsert(row) {
    const db = await getDatabase();
    await db.runAsync(
      `INSERT INTO thread_mentions (
         id, thread_id, entry_id, entry_date, todo_id, source_line, tag_text,
         created_at, updated_at, synced_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         thread_id = excluded.thread_id,
         entry_id = excluded.entry_id,
         entry_date = excluded.entry_date,
         todo_id = excluded.todo_id,
         source_line = excluded.source_line,
         tag_text = excluded.tag_text,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at,
         deleted_at = excluded.deleted_at`,
      [
        row.id, row.thread_id, row.entry_id, row.entry_date, row.todo_id,
        row.source_line, row.tag_text, row.created_at, row.updated_at,
        row.synced_at, row.deleted_at,
      ],
    );
  },
};
