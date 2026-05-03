import {
  getDatabase,
  getThreads, getThreadById, getThreadBySlug,
  insertThread, updateThread, deleteThread,
} from '../database';
import { generateId } from '../../utils/id';
import { slugify } from '../habits/migrate';
import type { Thread } from '../../types/thread';
import type { TimeOfDay } from '../../types/entry';

export type CreateThreadInput = {
  name: string;
  slug?: string;
  icon?: string | null;
  color?: string | null;
  targetCadenceDays?: number | null;
  pinned?: boolean;
  timeOfDay?: TimeOfDay;
};

// Result type so callers can branch on slug-collision UI without throwing.
export type CreateResult =
  | { ok: true; thread: Thread }
  | { ok: false; error: 'empty-name' | 'slug-taken'; slug?: string };

export async function listThreads(includeArchived = false): Promise<Thread[]> {
  return getThreads(includeArchived);
}

export async function getThread(id: string): Promise<Thread | null> {
  return getThreadById(id);
}

export async function findThreadBySlug(slug: string): Promise<Thread | null> {
  return getThreadBySlug(slug);
}

export async function createThread(input: CreateThreadInput): Promise<CreateResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'empty-name' };

  const slug = (input.slug?.trim() || slugify(name));
  if (!slug) return { ok: false, error: 'empty-name' };

  const existing = await getThreadBySlug(slug);
  if (existing) return { ok: false, error: 'slug-taken', slug };

  const now = new Date().toISOString();
  const thread: Thread = {
    id: generateId('thread'),
    name,
    slug,
    icon: input.icon ?? null,
    color: input.color ?? null,
    targetCadenceDays: input.targetCadenceDays ?? null,
    archived: false,
    pinned: input.pinned ?? false,
    timeOfDay: input.timeOfDay ?? 'anytime',
    createdAt: now,
    updatedAt: now,
  };
  await insertThread(thread);
  return { ok: true, thread };
}

// Editing — slug uniqueness checked unless the new slug equals the old one.
// The actual mention re-scan happens lazily on the next entry edit (per
// plan decision #3, option b).
export async function editThread(thread: Thread): Promise<{ ok: true } | { ok: false; error: 'slug-taken' }> {
  const collision = await getThreadBySlug(thread.slug);
  if (collision && collision.id !== thread.id) {
    return { ok: false, error: 'slug-taken' };
  }
  await updateThread({ ...thread, updatedAt: new Date().toISOString() });
  return { ok: true };
}

export async function archiveThread(id: string): Promise<void> {
  const t = await getThreadById(id);
  if (!t) return;
  await updateThread({ ...t, archived: true, updatedAt: new Date().toISOString() });
}

export async function unarchiveThread(id: string): Promise<void> {
  const t = await getThreadById(id);
  if (!t) return;
  await updateThread({ ...t, archived: false, updatedAt: new Date().toISOString() });
}

export async function setThreadPinned(id: string, pinned: boolean): Promise<void> {
  const t = await getThreadById(id);
  if (!t) return;
  await updateThread({ ...t, pinned, updatedAt: new Date().toISOString() });
}

// Hard delete — only callable from the UI on archived threads. Cascades to
// drop all mentions (via the database layer's deleteThread).
export async function destroyThread(id: string): Promise<void> {
  await deleteThread(id);
}

// Autocomplete source: non-archived threads whose slug starts with the
// (lowercased) query. Recency-sorted by most-recent mention; threads that
// have never been mentioned land below mentioned ones, alphabetically.
export async function getThreadSuggestions(query: string, limit = 8): Promise<Thread[]> {
  const db = await getDatabase();
  const q = query.trim().toLowerCase();
  const like = `${q}%`;
  type Row = {
    id: string;
    last_at: string | null;
  };
  // Pull thread IDs ordered by recency. LEFT JOIN preserves never-mentioned
  // threads (with last_at = NULL).
  const rows = await db.getAllAsync<Row>(
    `SELECT t.id AS id, MAX(m.created_at) AS last_at
     FROM threads t
     LEFT JOIN thread_mentions m ON m.thread_id = t.id AND m.deleted_at IS NULL
     WHERE t.archived = 0
       AND t.deleted_at IS NULL
       AND (? = '' OR t.slug LIKE ? COLLATE NOCASE)
     GROUP BY t.id
     ORDER BY last_at DESC NULLS LAST, t.name COLLATE NOCASE ASC
     LIMIT ?`,
    [q, like, limit],
  );
  if (rows.length === 0) return [];
  // Materialize each row's full thread.
  const out: Thread[] = [];
  for (const r of rows) {
    const t = await getThreadById(r.id);
    if (t) out.push(t);
  }
  return out;
}
