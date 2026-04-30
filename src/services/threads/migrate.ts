import * as SecureStore from 'expo-secure-store';
import { getAllEntries, getThreads } from '../database';
import { scanThreadsForEntry } from './scanThreads';

const BACKFILL_KEY = 'thread_mentions_backfill_v1_done';

// One-time pass over every entry to pick up #tag mentions in prose written
// before the threads scanner shipped. Runs lazily — only useful once the
// user has at least one thread to match against, otherwise it scans through
// thousands of entries to find zero matches.
//
// Caller (auto-init or first thread create) should invoke this; it short-
// circuits if the SecureStore flag is set OR if there are no threads.
export async function backfillThreadMentions(): Promise<{
  scanned: number;
  skipped: boolean;
  reason?: 'flag-set' | 'no-threads';
}> {
  const done = await SecureStore.getItemAsync(BACKFILL_KEY);
  if (done) return { scanned: 0, skipped: true, reason: 'flag-set' };

  const threads = await getThreads(true);
  if (threads.length === 0) {
    // Don't set the flag — re-check after the user creates their first thread.
    return { scanned: 0, skipped: true, reason: 'no-threads' };
  }

  const entries = await getAllEntries();
  for (const entry of entries) {
    try {
      await scanThreadsForEntry(entry.id, entry.date, entry.text, entry.todos ?? []);
    } catch (err) {
      console.warn('[threads backfill] entry failed:', entry.id, err);
    }
  }
  await SecureStore.setItemAsync(BACKFILL_KEY, new Date().toISOString());
  return { scanned: entries.length, skipped: false };
}
