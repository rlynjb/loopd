import * as SecureStore from 'expo-secure-store';
import { getDatabase } from '../database';

const BACKFILL_KEY = 'habits_cadence_backfill_v1_done';

// One-time backfill that fills in slug values for existing habits. The
// cadence_type, cadence_days, cadence_count, archived columns get their
// defaults from the ALTER TABLE migration (cadence_type='daily', archived=0,
// rest NULL), so the only thing left to populate is `slug`.
//
// Slug is derived from label: lowercase, non-alphanumerics → hyphens, trim
// hyphens. Collisions get -1, -2, ... appended.
//
// SecureStore-gated; runs once per install.
export async function backfillHabitsCadence(): Promise<{
  scanned: number;
  slugged: number;
  skipped: boolean;
}> {
  const done = await SecureStore.getItemAsync(BACKFILL_KEY);
  if (done) return { scanned: 0, slugged: 0, skipped: true };

  const db = await getDatabase();
  const rows = await db.getAllAsync<{ id: string; label: string; slug: string | null }>(
    'SELECT id, label, slug FROM habits'
  );

  const usedSlugs = new Set<string>();
  for (const r of rows) {
    if (r.slug) usedSlugs.add(r.slug);
  }

  let slugged = 0;
  for (const r of rows) {
    if (r.slug) continue;
    const base = slugify(r.label) || r.id;
    let candidate = base;
    let n = 1;
    while (usedSlugs.has(candidate)) {
      candidate = `${base}-${n++}`;
    }
    usedSlugs.add(candidate);
    await db.runAsync('UPDATE habits SET slug = ? WHERE id = ?', [candidate, r.id]);
    slugged++;
  }

  await SecureStore.setItemAsync(BACKFILL_KEY, new Date().toISOString());
  return { scanned: rows.length, slugged, skipped: false };
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
