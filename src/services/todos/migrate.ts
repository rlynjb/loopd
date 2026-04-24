import * as SecureStore from 'expo-secure-store';
import { getAllEntries, updateEntry } from '../database';
import { scanTodosFromText } from './scanTodos';

// Bumping this key forces the backfill to run again on next boot — do that
// if the scanner's extraction rules ever change in a way that needs a re-run.
const BACKFILL_KEY = 'drops_backfill_v1_done';

// One-time pass over every entry's text so any "[]" / "[x]" lines authored
// before the checkbox-drop scanner shipped are picked up and materialized
// into todos_json. Also assigns sourceLine to every matched todo so the
// scanner's two-pass matching can track edits from here on.
//
// Gated by a SecureStore flag so it runs at most once per install. Cost on
// typical entry volumes is tens of milliseconds — single cheap scan per
// entry plus an UPDATE when anything changed.
export async function backfillTodosFromText(): Promise<{
  scanned: number;
  updated: number;
  skipped: boolean;
}> {
  const done = await SecureStore.getItemAsync(BACKFILL_KEY);
  if (done) return { scanned: 0, updated: 0, skipped: true };

  const entries = await getAllEntries();
  let updated = 0;
  for (const entry of entries) {
    const existing = entry.todos ?? [];
    const next = scanTodosFromText(entry.text, existing);
    if (differs(existing, next)) {
      await updateEntry({ ...entry, todos: next });
      updated++;
    }
  }

  await SecureStore.setItemAsync(BACKFILL_KEY, new Date().toISOString());
  return { scanned: entries.length, updated, skipped: false };
}

// Shallow change detection: length or any positional field (text, done,
// sourceLine, completedAt) differs.
function differs(a: { text: string; done: boolean; sourceLine?: number; completedAt: string | null }[],
                 b: { text: string; done: boolean; sourceLine?: number; completedAt: string | null }[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.text !== y.text) return true;
    if (x.done !== y.done) return true;
    if (x.sourceLine !== y.sourceLine) return true;
    if (x.completedAt !== y.completedAt) return true;
  }
  return false;
}
