import { getDatabase, insertMention, deleteMention } from '../database';
import { generateId } from '../../utils/id';

// "Touch a thread for today" — the dashboard uses this to let users tap a
// thread row and mark it as worked-on, the same way they tap a habit row.
//
// Implementation note: this writes a manual `thread_mentions` row with
// (entry_id = NULL, todo_id = NULL, entry_date = today). That bends
// principle 11 ("mentions are derived from prose") because the row isn't
// produced by the scanner — it's a direct toggle. Justified because:
//   - DB schema already permits NULL for both entry_id and todo_id (the
//     constraint was app-level, not a CHECK).
//   - The 14-day strip + staleness math both consume thread_mentions
//     uniformly, so touched-today rows compose with prose-derived ones.
//   - Toggling off deletes only the manual row; prose-derived mentions
//     for today (if any) are untouched.

export async function isThreadTouchedToday(threadId: string, dateStr: string): Promise<string | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM thread_mentions
     WHERE thread_id = ? AND entry_date = ?
       AND entry_id IS NULL AND todo_id IS NULL
       AND deleted_at IS NULL
     LIMIT 1`,
    [threadId, dateStr],
  );
  return row?.id ?? null;
}

// Returns the new state: true if the thread is now touched today, false if
// the touch was removed.
export async function toggleThreadTouchToday(
  threadId: string,
  slug: string,
  dateStr: string,
): Promise<boolean> {
  const existingId = await isThreadTouchedToday(threadId, dateStr);
  if (existingId) {
    await deleteMention(existingId);
    return false;
  }
  await insertMention({
    id: generateId('mention'),
    threadId,
    entryId: null,
    entryDate: dateStr,
    todoId: null,
    sourceLine: 0,
    tagText: slug,
    createdAt: new Date().toISOString(),
  });
  return true;
}
