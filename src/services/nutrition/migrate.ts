import * as SecureStore from 'expo-secure-store';
import { getAllEntries } from '../database';
import { scanNutritionForEntry } from './scanNutrition';

// Bump this to force the backfill to rerun if the parser ever changes shape.
const BACKFILL_KEY = 'nutrition_backfill_v1_done';

// One-time pass over every entry to pick up "** <food> <n> kcal" lines
// written before the nutrition scanner shipped. Runs at most once per install
// — gated by a SecureStore flag.
//
// Per-entry cost is the same as a normal commit-time scan, so ~linear in
// (entries × lines-per-entry). Typical totals under 100ms even for hundreds
// of entries.
export async function backfillNutritionFromText(): Promise<{
  scanned: number;
  skipped: boolean;
}> {
  const done = await SecureStore.getItemAsync(BACKFILL_KEY);
  if (done) return { scanned: 0, skipped: true };

  const entries = await getAllEntries();
  for (const entry of entries) {
    if (!entry.text) continue;
    try {
      await scanNutritionForEntry(entry.id, entry.date, entry.text);
    } catch (err) {
      console.warn('[nutrition backfill] entry failed:', entry.id, err);
    }
  }
  await SecureStore.setItemAsync(BACKFILL_KEY, new Date().toISOString());
  return { scanned: entries.length, skipped: false };
}
