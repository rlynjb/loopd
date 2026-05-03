import * as SQLite from 'expo-sqlite';
import { File as FSFile, Paths } from 'expo-file-system';
import type { Entry, Habit, Vlog } from '../types/entry';
import type { EditorProject } from '../types/project';
import { normalizeClipUriForStorage, resolveClipUri } from './fileManager';
import { schedulePush } from './sync/schedulePush';

let db: SQLite.SQLiteDatabase | null = null;

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync('loopd.db');
  await migrate(db);
  repairBareClipUris(db).catch(e => console.warn('[loopd] Clip URI repair error:', e));
  return db;
}

/** Fix bare-filename clip URIs left by Notion sync overwriting full paths */
async function repairBareClipUris(database: SQLite.SQLiteDatabase): Promise<void> {
  const rows = await database.getAllAsync<{ id: string; date: string; clips_json: string | null; clip_uri: string | null }>(
    "SELECT id, date, clips_json, clip_uri FROM entries WHERE clips_json IS NOT NULL AND clips_json != '[]'"
  );
  const baseDir = `${Paths.document.uri}/loopd/clips`;
  for (const row of rows) {
    if (!row.clips_json) continue;
    let clips: { uri: string; durationMs: number }[];
    try { clips = JSON.parse(row.clips_json); } catch { continue; }
    let changed = false;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      if (c.uri.includes('/')) continue; // already a full path
      const fullUri = `${baseDir}/${row.date}/${c.uri}`;
      try {
        const file = new FSFile(fullUri);
        if (file.exists) {
          clips[i] = { ...c, uri: fullUri };
          changed = true;
        }
      } catch { /* skip */ }
    }
    if (changed) {
      const newClipUri = clips[0]?.uri ?? row.clip_uri;
      await database.runAsync(
        'UPDATE entries SET clips_json = ?, clip_uri = ? WHERE id = ?',
        [JSON.stringify(clips), newClipUri, row.id]
      );
    }
  }
}

async function migrate(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS habits (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      text TEXT,
      habits_json TEXT,
      clip_uri TEXT,
      clip_duration_ms INTEGER,
      clips_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      status TEXT DEFAULT 'draft',
      clips_json TEXT,
      removed_clip_source_keys_json TEXT,
      text_overlays_json TEXT,
      filter_overlays_json TEXT,
      export_uri TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vlogs (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      clip_count INTEGER DEFAULT 0,
      habit_count INTEGER DEFAULT 0,
      caption TEXT,
      duration_seconds INTEGER,
      export_uri TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS day_meta (
      date TEXT PRIMARY KEY,
      title TEXT DEFAULT '',
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
    CREATE INDEX IF NOT EXISTS idx_projects_date ON projects(date);
  `);

  // Migrations — add columns if missing (safe for existing installs)
  const addColumn = async (table: string, col: string, type: string) => {
    try { await database.execAsync(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* exists */ }
  };
  await addColumn('entries', 'clips_json', 'TEXT');
  await addColumn('entries', 'todos_json', 'TEXT');
  await addColumn('entries', 'notion_page_id', 'TEXT');
  await addColumn('entries', 'updated_at', 'TEXT');
  await addColumn('habits', 'notion_page_id', 'TEXT');
  await addColumn('day_meta', 'updated_at', 'TEXT');
  await addColumn('habits', 'updated_at', 'TEXT');
  await addColumn('projects', 'removed_clip_source_keys_json', 'TEXT');
  // Habits cadence + metadata — added 2026-04-29 for the today/threads feature.
  // CHECK on cadence_type is omitted here (SQLite ALTER TABLE limitation);
  // TS literal-union enforces the same set at the API boundary.
  await addColumn('habits', 'slug', 'TEXT');
  await addColumn('habits', 'icon', 'TEXT');
  await addColumn('habits', 'color', 'TEXT');
  await addColumn('habits', 'cadence_type', `TEXT NOT NULL DEFAULT 'daily'`);
  await addColumn('habits', 'cadence_days', 'TEXT');
  await addColumn('habits', 'cadence_count', 'INTEGER');
  await addColumn('habits', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn('habits', 'notion_last_synced', 'TEXT');
  // Time-of-day bucket — morning / midday / evening / anytime. Default
  // 'anytime' so existing habits land in the catch-all bucket. CHECK
  // omitted (ALTER TABLE limitation); TS literal-union enforces.
  await addColumn('habits', 'time_of_day', `TEXT NOT NULL DEFAULT 'anytime'`);
  // Lifecycle stage on todo_meta — added 2026-04-26. Defaults to 'todo'
  // for every existing row.
  await addColumn('todo_meta', 'stage', `TEXT NOT NULL DEFAULT 'todo'`);
  // User-set position on todo_meta — added 2026-04-26. NULL by default;
  // populated lazily on first reorder action via ensureAllTodoPositions().
  await addColumn('todo_meta', 'position', 'INTEGER');

  // Sync deletions tracking table
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS sync_deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      notion_page_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    );
  `);

  // Indexes for sync
  await database.execAsync(`
    CREATE INDEX IF NOT EXISTS idx_entries_notion ON entries(notion_page_id);
    CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries(updated_at);
    CREATE INDEX IF NOT EXISTS idx_habits_notion ON habits(notion_page_id);
    CREATE INDEX IF NOT EXISTS idx_habits_archived ON habits(archived);
    CREATE INDEX IF NOT EXISTS idx_habits_slug ON habits(slug);
  `);

  // Nutrition entries — one row per "** <name> <kcal> kcal" line in prose.
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS nutrition (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kcal INTEGER NOT NULL,
      entry_id TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      source_line INTEGER,
      notion_page_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_nutrition_entry ON nutrition(entry_id);
    CREATE INDEX IF NOT EXISTS idx_nutrition_date ON nutrition(entry_date);
    CREATE INDEX IF NOT EXISTS idx_nutrition_name ON nutrition(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_nutrition_notion ON nutrition(notion_page_id);
  `);

  // Todo meta — 1:1 with each TodoItem in entries.todos_json. Holds the
  // thinking-mode classification + (Phase C) the expansion result. The
  // scanner enforces the 1:1 invariant by writing both rows in a single
  // SQLite transaction.
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS todo_meta (
      todo_id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'todo',
      stage TEXT NOT NULL DEFAULT 'todo',
      expanded_md TEXT,
      expanded_at TEXT,
      model TEXT,
      classifier_confidence TEXT,
      classifier_model TEXT,
      user_overridden_type INTEGER NOT NULL DEFAULT 0,
      position INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (type IN ('todo','idea','bug','question','decision','knowledge','content')),
      CHECK (stage IN ('todo','in_progress','backlog')),
      CHECK (classifier_confidence IS NULL OR classifier_confidence IN ('high','medium','low','heuristic'))
    );
    CREATE INDEX IF NOT EXISTS idx_todo_meta_entry ON todo_meta(entry_id);
    CREATE INDEX IF NOT EXISTS idx_todo_meta_date ON todo_meta(entry_date);
    CREATE INDEX IF NOT EXISTS idx_todo_meta_type ON todo_meta(type);
    CREATE INDEX IF NOT EXISTS idx_todo_meta_updated ON todo_meta(updated_at);
    CREATE INDEX IF NOT EXISTS idx_todo_meta_created ON todo_meta(created_at);
  `);

  // AI summaries table
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS ai_summaries (
      date TEXT PRIMARY KEY,
      summary_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      model TEXT NOT NULL
    );
  `);

  // Threads — lightweight project-attribution metadata. Mirrors habits.
  // The `slug` column is the matching key for #tag mentions in prose; UNIQUE
  // is enforced by the index. `archived` and `pinned` stored as 0/1.
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      icon TEXT,
      color TEXT,
      target_cadence_days INTEGER,
      archived INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      time_of_day TEXT NOT NULL DEFAULT 'anytime',
      notion_page_id TEXT,
      notion_last_synced TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_slug ON threads(slug);
    CREATE INDEX IF NOT EXISTS idx_threads_archived ON threads(archived);
    CREATE INDEX IF NOT EXISTS idx_threads_notion ON threads(notion_page_id);
  `);
  // Migration for existing installs that already have threads without time_of_day.
  await addColumn('threads', 'time_of_day', `TEXT NOT NULL DEFAULT 'anytime'`);

  // Thread mentions — junction between threads and entries/todos. One row
  // per #tag occurrence. Constraint: every mention has either an entry_id
  // or a todo_id (enforced in the scanner; SQLite CHECK omitted because
  // partial indexes / partial CHECK is awkward to evolve).
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS thread_mentions (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      entry_id TEXT,
      entry_date TEXT NOT NULL,
      todo_id TEXT,
      source_line INTEGER NOT NULL DEFAULT 0,
      tag_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_thread_mentions_thread ON thread_mentions(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_thread_mentions_entry ON thread_mentions(entry_id);
    CREATE INDEX IF NOT EXISTS idx_thread_mentions_todo ON thread_mentions(todo_id);
    CREATE INDEX IF NOT EXISTS idx_thread_mentions_date ON thread_mentions(entry_date);
  `);

  // Migration: drop dead columns (type, mood, category) from entries
  try {
    const entriesSchema = await database.getFirstAsync<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='entries'"
    );
    if (entriesSchema?.sql?.includes('mood TEXT') || entriesSchema?.sql?.includes('type TEXT') || entriesSchema?.sql?.includes('category TEXT')) {
      await database.execAsync(`
        CREATE TABLE entries_new (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          text TEXT,
          habits_json TEXT,
          clip_uri TEXT,
          clip_duration_ms INTEGER,
          clips_json TEXT,
          created_at TEXT NOT NULL,
          todos_json TEXT,
          notion_page_id TEXT,
          updated_at TEXT
        );
        INSERT INTO entries_new SELECT
          id, date, text, habits_json,
          clip_uri, clip_duration_ms, clips_json, created_at,
          todos_json, notion_page_id, updated_at
        FROM entries;
        DROP TABLE entries;
        ALTER TABLE entries_new RENAME TO entries;
        CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
        CREATE INDEX IF NOT EXISTS idx_entries_notion ON entries(notion_page_id);
        CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries(updated_at);
      `);
      console.log('[loopd] Migrated entries: removed dead columns (type, mood, category)');
    }
  } catch (e) {
    console.warn('[loopd] Dead column migration error:', e);
  }

  // Migration: drop dead columns (mood, categories_json) from vlogs
  try {
    const vlogsSchema = await database.getFirstAsync<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='vlogs'"
    );
    if (vlogsSchema?.sql?.includes('mood TEXT') || vlogsSchema?.sql?.includes('categories_json TEXT')) {
      await database.execAsync(`
        CREATE TABLE vlogs_new (
          id TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          clip_count INTEGER DEFAULT 0,
          habit_count INTEGER DEFAULT 0,
          caption TEXT,
          duration_seconds INTEGER,
          export_uri TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO vlogs_new SELECT
          id, date, clip_count, habit_count, caption,
          duration_seconds, export_uri, created_at
        FROM vlogs;
        DROP TABLE vlogs;
        ALTER TABLE vlogs_new RENAME TO vlogs;
      `);
      console.log('[loopd] Migrated vlogs: removed dead columns (mood, categories_json)');
    }
  } catch (e) {
    console.warn('[loopd] Vlogs migration error:', e);
  }

  // Migration: drop emoji column from habits
  try {
    const habitsSchema = await database.getFirstAsync<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='habits'"
    );
    if (habitsSchema?.sql?.includes('emoji')) {
      await database.execAsync(`
        CREATE TABLE habits_new (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          sort_order INTEGER DEFAULT 0,
          notion_page_id TEXT,
          updated_at TEXT
        );
        INSERT INTO habits_new SELECT id, label, sort_order, notion_page_id, updated_at FROM habits;
        DROP TABLE habits;
        ALTER TABLE habits_new RENAME TO habits;
        CREATE INDEX IF NOT EXISTS idx_habits_notion ON habits(notion_page_id);
      `);
      console.log('[loopd] Migrated habits: removed emoji column');
    }
  } catch (e) {
    console.warn('[loopd] Habits emoji migration error:', e);
  }

  // ── Cloud sync (Supabase) — M0 schema additions ──
  // Every synced table gains:
  //   - synced_at TEXT  — last successful push timestamp (LOCAL ONLY)
  //   - deleted_at TEXT — soft-delete timestamp; row hidden when set
  // Both are nullable. Read paths gain `WHERE deleted_at IS NULL` in M3.
  // ai_summaries also gains `updated_at` so the sync layer can treat every
  // table uniformly (its existing `generated_at` is the data event; the new
  // `updated_at` mirrors it and is what sync compares against).
  for (const t of ['entries', 'projects', 'vlogs', 'day_meta', 'ai_summaries',
                   'nutrition', 'habits', 'todo_meta', 'threads', 'thread_mentions']) {
    await addColumn(t, 'synced_at', 'TEXT');
    await addColumn(t, 'deleted_at', 'TEXT');
  }
  // Tables that never had updated_at locally need it now so the sync layer
  // can use a single "dirty since X" query shape across every table.
  // Backfill from created_at / generated_at so existing rows stamp correctly.
  await addColumn('ai_summaries', 'updated_at', 'TEXT');
  await addColumn('vlogs', 'updated_at', 'TEXT');
  await addColumn('thread_mentions', 'updated_at', 'TEXT');
  await database.execAsync(`UPDATE ai_summaries SET updated_at = generated_at WHERE updated_at IS NULL`);
  await database.execAsync(`UPDATE vlogs SET updated_at = created_at WHERE updated_at IS NULL`);
  await database.execAsync(`UPDATE thread_mentions SET updated_at = created_at WHERE updated_at IS NULL`);

  // sync_meta — per-table sync-state ledger. NOT itself synced.
  // Eleven rows after first run (one per synced table; sync_deletions excluded).
  await database.execAsync(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      table_name TEXT PRIMARY KEY,
      last_pull_at TEXT,
      last_push_at TEXT,
      pending_pushes INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_error_at TEXT
    );
  `);

  // Backfill updated_at
  await database.execAsync(`UPDATE entries SET updated_at = created_at WHERE updated_at IS NULL`);
  await database.execAsync(`UPDATE habits SET updated_at = datetime('now') WHERE updated_at IS NULL`);

  // Seed habits if empty (don't re-seed if user has soft-deleted them all)
  const count = await database.getFirstAsync<{ c: number }>('SELECT COUNT(*) as c FROM habits WHERE deleted_at IS NULL');
  if (count && count.c === 0) {
    await database.execAsync(`
      INSERT INTO habits (id, label, sort_order) VALUES
        ('workout', 'Workout', 0),
        ('study', 'Study', 1),
        ('vlog', 'Vlog', 2),
        ('meditate', 'Meditate', 3),
        ('read', 'Read', 4);
    `);
  }
}

// ── Habits ──

import type { CadenceType, TimeOfDay } from '../types/entry';

type HabitRow = {
  id: string;
  label: string;
  sort_order: number;
  slug: string | null;
  icon: string | null;
  color: string | null;
  cadence_type: string | null;
  cadence_days: string | null;
  cadence_count: number | null;
  time_of_day: string | null;
  notion_page_id: string | null;
  notion_last_synced: string | null;
  updated_at: string | null;
};

function mapRowToHabit(r: HabitRow): Habit {
  let cadenceDays: number[] | null = null;
  if (r.cadence_days) {
    try { cadenceDays = JSON.parse(r.cadence_days); } catch { cadenceDays = null; }
  }
  return {
    id: r.id,
    label: r.label,
    sortOrder: r.sort_order,
    slug: r.slug,
    icon: r.icon,
    color: r.color,
    cadenceType: (r.cadence_type ?? 'daily') as CadenceType,
    cadenceDays,
    cadenceCount: r.cadence_count,
    timeOfDay: (r.time_of_day ?? 'anytime') as TimeOfDay,
    notionPageId: r.notion_page_id,
    notionLastSynced: r.notion_last_synced,
    updatedAt: r.updated_at,
  };
}

// SQL-side bucket sort: morning(0) → midday(1) → evening(2) → anytime(3),
// then sort_order ASC within bucket. Done in SQL so the dashboard doesn't
// need to re-sort.
const TIME_OF_DAY_ORDER_SQL = `
  CASE COALESCE(time_of_day, 'anytime')
    WHEN 'morning' THEN 0
    WHEN 'midday' THEN 1
    WHEN 'evening' THEN 2
    ELSE 3
  END
`;

export async function getHabits(): Promise<Habit[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<HabitRow>(
    `SELECT * FROM habits WHERE deleted_at IS NULL ORDER BY ${TIME_OF_DAY_ORDER_SQL}, sort_order`
  );
  return rows.map(mapRowToHabit);
}

export async function getHabitById(id: string): Promise<Habit | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<HabitRow>('SELECT * FROM habits WHERE id = ? AND deleted_at IS NULL', [id]);
  return row ? mapRowToHabit(row) : null;
}

// ── Row mapper ──

type EntryRow = {
  id: string; date: string; text: string | null;
  habits_json: string | null;
  todos_json: string | null;
  clip_uri: string | null; clip_duration_ms: number | null;
  clips_json: string | null; created_at: string;
  notion_page_id: string | null; updated_at: string | null;
};

function mapRowToEntry(r: EntryRow): Entry {
  // Once `clips_json` has ever been written for an entry (including the
  // empty array `'[]'`), it is authoritative. The legacy `clip_uri` column
  // only comes into play for pre-clips_json entries.
  const hasClipsJson = r.clips_json != null;
  const rawClips: { uri: string; durationMs: number }[] = hasClipsJson
    ? JSON.parse(r.clips_json!)
    : (r.clip_uri ? [{ uri: r.clip_uri, durationMs: r.clip_duration_ms ?? 0 }] : []);
  const effectiveClipUri = hasClipsJson ? (rawClips[0]?.uri ?? null) : r.clip_uri;
  const effectiveClipDurationMs = hasClipsJson ? (rawClips[0]?.durationMs ?? null) : r.clip_duration_ms;
  return {
    id: r.id,
    date: r.date,
    text: r.text,
    habits: r.habits_json ? JSON.parse(r.habits_json) : [],
    todos: r.todos_json ? JSON.parse(r.todos_json) : [],
    clipUri: resolveClipUri(effectiveClipUri),
    clipDurationMs: effectiveClipDurationMs,
    clips: rawClips.map(c => ({ ...c, uri: resolveClipUri(c.uri) ?? c.uri })),
    createdAt: r.created_at,
    notionPageId: r.notion_page_id,
    updatedAt: r.updated_at,
  };
}

function entryClipsForStorage(entry: Entry): {
  clipUri: string | null;
  clipsJson: string;
} {
  const normalizedClips = entry.clips.map(c => ({ ...c, uri: normalizeClipUriForStorage(c.uri) ?? c.uri }));
  return {
    clipUri: normalizeClipUriForStorage(entry.clipUri),
    clipsJson: JSON.stringify(normalizedClips),
  };
}

// ── Entries ──

export async function getEntriesByDate(date: string): Promise<Entry[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<EntryRow>(
    'SELECT * FROM entries WHERE date = ? AND deleted_at IS NULL ORDER BY created_at ASC', [date]
  );

  return rows.map(r => mapRowToEntry(r));
}

export async function insertEntry(entry: Entry): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const { clipUri, clipsJson } = entryClipsForStorage(entry);
  await db.runAsync(
    `INSERT INTO entries (id, date, text, habits_json, todos_json, clip_uri, clip_duration_ms, clips_json, created_at, notion_page_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id, entry.date, entry.text,
      JSON.stringify(entry.habits), JSON.stringify(entry.todos ?? []),
      clipUri, entry.clipDurationMs,
      clipsJson, entry.createdAt, entry.notionPageId ?? null, now,
    ]
  );
  schedulePush();
}

export async function updateEntry(entry: Entry): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const { clipUri, clipsJson } = entryClipsForStorage(entry);
  // Keep the legacy `clip_uri` / `clip_duration_ms` columns in sync with
  // clips_json. Otherwise removing all clips leaves the legacy value in the
  // DB, and mapRowToEntry's fallback resurrects the old clip on next read.
  await db.runAsync(
    `UPDATE entries SET text = ?, habits_json = ?, todos_json = ?, clip_uri = ?, clip_duration_ms = ?, clips_json = ?, updated_at = ? WHERE id = ?`,
    [entry.text, JSON.stringify(entry.habits), JSON.stringify(entry.todos ?? []), clipUri, entry.clipDurationMs, clipsJson, now, entry.id]
  );
  schedulePush();
}

// Soft-delete: stamp deleted_at + bump updated_at so the row stays in the
// DB (hidden from reads via WHERE deleted_at IS NULL) and propagates to
// cloud as a normal sync event. The 30-day vacuum (M4) hard-deletes later.
// During the Notion dual-run we also still write to sync_deletions so the
// Notion archival path keeps working until M7 removes that code.
export async function deleteEntry(id: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();

  // Notion archival queue (dual-run only — drops in M7).
  const row = await db.getFirstAsync<{ notion_page_id: string | null }>('SELECT notion_page_id FROM entries WHERE id = ?', [id]);
  if (row?.notion_page_id) {
    await db.runAsync(
      'INSERT INTO sync_deletions (entity_type, entity_id, notion_page_id, deleted_at) VALUES (?, ?, ?, ?)',
      ['entry', id, row.notion_page_id, now]
    );
  }
  // Cascade soft-delete nutrition + queue for Notion archive.
  const nutRows = await db.getAllAsync<{ id: string; notion_page_id: string | null }>(
    'SELECT id, notion_page_id FROM nutrition WHERE entry_id = ? AND deleted_at IS NULL', [id]
  );
  for (const n of nutRows) {
    if (n.notion_page_id) {
      await db.runAsync(
        'INSERT INTO sync_deletions (entity_type, entity_id, notion_page_id, deleted_at) VALUES (?, ?, ?, ?)',
        ['nutrition', n.id, n.notion_page_id, now]
      );
    }
  }
  await db.runAsync(
    'UPDATE nutrition SET deleted_at = ?, updated_at = ? WHERE entry_id = ? AND deleted_at IS NULL',
    [now, now, id],
  );
  // Cascade soft-delete todo_meta.
  await db.runAsync(
    'UPDATE todo_meta SET deleted_at = ?, updated_at = ? WHERE entry_id = ? AND deleted_at IS NULL',
    [now, now, id],
  );
  // Cascade soft-delete thread_mentions referencing this entry. Local schema
  // never had this cascade; soft delete makes it explicit so cloud sync sees
  // a consistent view (no mention left dangling against a deleted entry).
  await db.runAsync(
    'UPDATE thread_mentions SET deleted_at = ?, updated_at = ? WHERE entry_id = ? AND deleted_at IS NULL',
    [now, now, id],
  );
  // Soft-delete the entry itself.
  await db.runAsync(
    'UPDATE entries SET deleted_at = ?, updated_at = ? WHERE id = ?',
    [now, now, id],
  );
  schedulePush();
}

// ── Nutrition CRUD ──

import type { NutritionEntry, NutritionSuggestion } from '../types/nutrition';

function mapRowToNutrition(row: {
  id: string; name: string; kcal: number; entry_id: string; entry_date: string;
  source_line: number | null; notion_page_id: string | null; created_at: string; updated_at: string | null;
}): NutritionEntry {
  return {
    id: row.id,
    name: row.name,
    kcal: row.kcal,
    entryId: row.entry_id,
    entryDate: row.entry_date,
    sourceLine: row.source_line ?? undefined,
    notionPageId: row.notion_page_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getNutritionByEntry(entryId: string): Promise<NutritionEntry[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<Parameters<typeof mapRowToNutrition>[0]>(
    `SELECT id, name, kcal, entry_id, entry_date, source_line, notion_page_id, created_at, updated_at
     FROM nutrition WHERE entry_id = ? AND deleted_at IS NULL ORDER BY source_line ASC, created_at ASC`,
    [entryId],
  );
  return rows.map(mapRowToNutrition);
}

export async function insertNutrition(n: NutritionEntry): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO nutrition (id, name, kcal, entry_id, entry_date, source_line, notion_page_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [n.id, n.name, n.kcal, n.entryId, n.entryDate, n.sourceLine ?? null, n.notionPageId ?? null, n.createdAt, now],
  );
  schedulePush();
}

export async function updateNutrition(
  id: string,
  updates: Partial<Pick<NutritionEntry, 'name' | 'kcal' | 'sourceLine'>>,
): Promise<void> {
  const db = await getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  if ('name' in updates) { fields.push('name = ?'); values.push(updates.name ?? ''); }
  if ('kcal' in updates) { fields.push('kcal = ?'); values.push(updates.kcal ?? 0); }
  if ('sourceLine' in updates) { fields.push('source_line = ?'); values.push(updates.sourceLine ?? null); }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  await db.runAsync(`UPDATE nutrition SET ${fields.join(', ')} WHERE id = ?`, values);
  schedulePush();
}

export async function deleteNutrition(id: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const row = await db.getFirstAsync<{ notion_page_id: string | null }>(
    'SELECT notion_page_id FROM nutrition WHERE id = ?', [id],
  );
  if (row?.notion_page_id) {
    await db.runAsync(
      'INSERT INTO sync_deletions (entity_type, entity_id, notion_page_id, deleted_at) VALUES (?, ?, ?, ?)',
      ['nutrition', id, row.notion_page_id, now],
    );
  }
  await db.runAsync(
    'UPDATE nutrition SET deleted_at = ?, updated_at = ? WHERE id = ?',
    [now, now, id],
  );
  schedulePush();
}

// Autocomplete source: distinct food names matching a prefix, each with its
// most-recently-logged kcal value. Returns at most `limit` rows, ordered by
// recency. Case-insensitive LIKE via the idx_nutrition_name COLLATE NOCASE index.
export async function getNutritionSuggestions(query: string, limit = 8): Promise<NutritionSuggestion[]> {
  const db = await getDatabase();
  // Empty query → return the most recently-used foods overall.
  const like = `${query.trim()}%`;
  const rows = await db.getAllAsync<{ name: string; kcal: number; created_at: string }>(
    `SELECT name, kcal, created_at
     FROM nutrition
     WHERE deleted_at IS NULL AND (? = '' OR name LIKE ? COLLATE NOCASE)
     ORDER BY created_at DESC
     LIMIT 200`,
    [query.trim(), like],
  );
  const seen = new Set<string>();
  const out: NutritionSuggestion[] = [];
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: r.name, kcal: r.kcal, lastLoggedAt: r.created_at });
    if (out.length >= limit) break;
  }
  return out;
}

export async function getAllNutrition(): Promise<NutritionEntry[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<Parameters<typeof mapRowToNutrition>[0]>(
    `SELECT id, name, kcal, entry_id, entry_date, source_line, notion_page_id, created_at, updated_at
     FROM nutrition WHERE deleted_at IS NULL ORDER BY created_at DESC`,
  );
  return rows.map(mapRowToNutrition);
}

// ── Todo meta CRUD ──

import type { TodoMeta, TodoType, TodoStage, ClassifierConfidence } from '../types/todoMeta';

type TodoMetaRow = {
  todo_id: string;
  entry_id: string;
  entry_date: string;
  type: string;
  stage: string | null;
  expanded_md: string | null;
  expanded_at: string | null;
  model: string | null;
  classifier_confidence: string | null;
  classifier_model: string | null;
  user_overridden_type: number;
  position: number | null;
  created_at: string;
  updated_at: string;
};

function mapRowToTodoMeta(row: TodoMetaRow): TodoMeta {
  return {
    todoId: row.todo_id,
    entryId: row.entry_id,
    entryDate: row.entry_date,
    type: row.type as TodoType,
    stage: (row.stage ?? 'todo') as TodoStage,
    expandedMd: row.expanded_md,
    expandedAt: row.expanded_at,
    model: row.model,
    classifierConfidence: row.classifier_confidence as ClassifierConfidence | null,
    classifierModel: row.classifier_model,
    userOverriddenType: row.user_overridden_type === 1,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getTodoMeta(todoId: string): Promise<TodoMeta | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<TodoMetaRow>(
    `SELECT * FROM todo_meta WHERE todo_id = ? AND deleted_at IS NULL`, [todoId],
  );
  return row ? mapRowToTodoMeta(row) : null;
}

export async function getTodoMetasByEntry(entryId: string): Promise<TodoMeta[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<TodoMetaRow>(
    `SELECT * FROM todo_meta WHERE entry_id = ? AND deleted_at IS NULL`, [entryId],
  );
  return rows.map(mapRowToTodoMeta);
}

export async function getAllTodoMetas(): Promise<TodoMeta[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<TodoMetaRow>(`SELECT * FROM todo_meta WHERE deleted_at IS NULL`);
  return rows.map(mapRowToTodoMeta);
}

// Insert a new meta row. Caller must wrap in a transaction together with the
// matching todos_json write to honor the 1:1 lifecycle invariant.
export async function insertTodoMeta(meta: TodoMeta): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO todo_meta (
       todo_id, entry_id, entry_date, type, stage, expanded_md, expanded_at,
       model, classifier_confidence, classifier_model, user_overridden_type,
       position, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meta.todoId, meta.entryId, meta.entryDate, meta.type, meta.stage,
      meta.expandedMd, meta.expandedAt, meta.model,
      meta.classifierConfidence, meta.classifierModel,
      meta.userOverriddenType ? 1 : 0,
      meta.position ?? null,
      meta.createdAt, meta.updatedAt,
    ],
  );
  schedulePush();
}

export async function updateTodoMeta(
  todoId: string,
  updates: Partial<Omit<TodoMeta, 'todoId' | 'createdAt'>>,
): Promise<void> {
  const db = await getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  if ('entryId' in updates) { fields.push('entry_id = ?'); values.push(updates.entryId ?? ''); }
  if ('entryDate' in updates) { fields.push('entry_date = ?'); values.push(updates.entryDate ?? ''); }
  if ('type' in updates) { fields.push('type = ?'); values.push(updates.type ?? 'todo'); }
  if ('stage' in updates) { fields.push('stage = ?'); values.push(updates.stage ?? 'todo'); }
  if ('expandedMd' in updates) { fields.push('expanded_md = ?'); values.push(updates.expandedMd ?? null); }
  if ('expandedAt' in updates) { fields.push('expanded_at = ?'); values.push(updates.expandedAt ?? null); }
  if ('model' in updates) { fields.push('model = ?'); values.push(updates.model ?? null); }
  if ('classifierConfidence' in updates) { fields.push('classifier_confidence = ?'); values.push(updates.classifierConfidence ?? null); }
  if ('classifierModel' in updates) { fields.push('classifier_model = ?'); values.push(updates.classifierModel ?? null); }
  if ('userOverriddenType' in updates) { fields.push('user_overridden_type = ?'); values.push(updates.userOverriddenType ? 1 : 0); }
  if ('position' in updates) { fields.push('position = ?'); values.push(updates.position ?? null); }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(todoId);
  await db.runAsync(`UPDATE todo_meta SET ${fields.join(', ')} WHERE todo_id = ?`, values);
  schedulePush();
}

export async function deleteTodoMeta(todoId: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE todo_meta SET deleted_at = ?, updated_at = ? WHERE todo_id = ?`,
    [now, now, todoId],
  );
  schedulePush();
}

export async function deleteTodoMetasByEntry(entryId: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE todo_meta SET deleted_at = ?, updated_at = ? WHERE entry_id = ? AND deleted_at IS NULL`,
    [now, now, entryId],
  );
  schedulePush();
}

// ── Threads ──

import type { Thread, ThreadMention } from '../types/thread';

type ThreadRow = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  color: string | null;
  target_cadence_days: number | null;
  archived: number;
  pinned: number;
  time_of_day: string | null;
  notion_page_id: string | null;
  notion_last_synced: string | null;
  created_at: string;
  updated_at: string;
};

function mapRowToThread(r: ThreadRow): Thread {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    icon: r.icon,
    color: r.color,
    targetCadenceDays: r.target_cadence_days,
    archived: r.archived === 1,
    pinned: r.pinned === 1,
    timeOfDay: (r.time_of_day ?? 'anytime') as TimeOfDay,
    notionPageId: r.notion_page_id,
    notionLastSynced: r.notion_last_synced,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Reusable bucket-order CASE — keep in sync with TIME_OF_DAY_ORDER_SQL above.
const THREAD_TIME_OF_DAY_ORDER_SQL = `
  CASE COALESCE(time_of_day, 'anytime')
    WHEN 'morning' THEN 0
    WHEN 'midday' THEN 1
    WHEN 'evening' THEN 2
    ELSE 3
  END
`;

export async function getThreads(includeArchived = false): Promise<Thread[]> {
  const db = await getDatabase();
  // Sort: pinned first, then by time-of-day bucket, then alphabetic within.
  const rows = await db.getAllAsync<ThreadRow>(
    includeArchived
      ? `SELECT * FROM threads WHERE deleted_at IS NULL ORDER BY pinned DESC, ${THREAD_TIME_OF_DAY_ORDER_SQL}, name COLLATE NOCASE ASC`
      : `SELECT * FROM threads WHERE archived = 0 AND deleted_at IS NULL ORDER BY pinned DESC, ${THREAD_TIME_OF_DAY_ORDER_SQL}, name COLLATE NOCASE ASC`
  );
  return rows.map(mapRowToThread);
}

export async function getThreadBySlug(slug: string): Promise<Thread | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<ThreadRow>(
    'SELECT * FROM threads WHERE slug = ? COLLATE NOCASE AND deleted_at IS NULL',
    [slug]
  );
  return row ? mapRowToThread(row) : null;
}

export async function getThreadById(id: string): Promise<Thread | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<ThreadRow>('SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL', [id]);
  return row ? mapRowToThread(row) : null;
}

export async function insertThread(thread: Thread): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO threads (
       id, name, slug, icon, color, target_cadence_days,
       archived, pinned, time_of_day, notion_page_id, notion_last_synced,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      thread.id, thread.name, thread.slug,
      thread.icon ?? null, thread.color ?? null, thread.targetCadenceDays,
      thread.archived ? 1 : 0, thread.pinned ? 1 : 0,
      thread.timeOfDay ?? 'anytime',
      thread.notionPageId ?? null, thread.notionLastSynced ?? null,
      thread.createdAt, thread.updatedAt,
    ]
  );
  schedulePush();
}

export async function updateThread(thread: Thread): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE threads SET
       name = ?, slug = ?, icon = ?, color = ?, target_cadence_days = ?,
       archived = ?, pinned = ?, time_of_day = ?,
       notion_page_id = ?, notion_last_synced = ?,
       updated_at = ?
     WHERE id = ?`,
    [
      thread.name, thread.slug, thread.icon ?? null, thread.color ?? null,
      thread.targetCadenceDays,
      thread.archived ? 1 : 0, thread.pinned ? 1 : 0,
      thread.timeOfDay ?? 'anytime',
      thread.notionPageId ?? null, thread.notionLastSynced ?? null,
      new Date().toISOString(),
      thread.id,
    ]
  );
  schedulePush();
}

export async function deleteThread(id: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const row = await db.getFirstAsync<{ notion_page_id: string | null }>(
    'SELECT notion_page_id FROM threads WHERE id = ?', [id]
  );
  if (row?.notion_page_id) {
    await db.runAsync(
      'INSERT INTO sync_deletions (entity_type, entity_id, notion_page_id, deleted_at) VALUES (?, ?, ?, ?)',
      ['thread', id, row.notion_page_id, now]
    );
  }
  // Cascade soft-delete all mentions for this thread.
  await db.runAsync(
    'UPDATE thread_mentions SET deleted_at = ?, updated_at = ? WHERE thread_id = ? AND deleted_at IS NULL',
    [now, now, id],
  );
  await db.runAsync(
    'UPDATE threads SET deleted_at = ?, updated_at = ? WHERE id = ?',
    [now, now, id],
  );
  schedulePush();
}

// ── Thread mentions ──

type ThreadMentionRow = {
  id: string;
  thread_id: string;
  entry_id: string | null;
  entry_date: string;
  todo_id: string | null;
  source_line: number;
  tag_text: string;
  created_at: string;
};

function mapRowToMention(r: ThreadMentionRow): ThreadMention {
  return {
    id: r.id,
    threadId: r.thread_id,
    entryId: r.entry_id,
    entryDate: r.entry_date,
    todoId: r.todo_id,
    sourceLine: r.source_line,
    tagText: r.tag_text,
    createdAt: r.created_at,
  };
}

export async function getMentionsByEntry(entryId: string): Promise<ThreadMention[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<ThreadMentionRow>(
    'SELECT * FROM thread_mentions WHERE entry_id = ? AND deleted_at IS NULL', [entryId]
  );
  return rows.map(mapRowToMention);
}

export async function getMentionsByTodo(todoId: string): Promise<ThreadMention[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<ThreadMentionRow>(
    'SELECT * FROM thread_mentions WHERE todo_id = ? AND deleted_at IS NULL', [todoId]
  );
  return rows.map(mapRowToMention);
}

export async function getMentionsByThread(threadId: string, limit = 100): Promise<ThreadMention[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<ThreadMentionRow>(
    'SELECT * FROM thread_mentions WHERE thread_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?',
    [threadId, limit]
  );
  return rows.map(mapRowToMention);
}

// Map: todoId → Set<threadId>. Used by the /todos page thread filter.
// Single SQL query reads all (todo_id, thread_id) pairs from thread_mentions.
export async function getTodoThreadLinks(): Promise<Map<string, Set<string>>> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ todo_id: string; thread_id: string }>(
    `SELECT DISTINCT todo_id, thread_id FROM thread_mentions WHERE todo_id IS NOT NULL AND deleted_at IS NULL`
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = out.get(r.todo_id);
    if (!set) { set = new Set(); out.set(r.todo_id, set); }
    set.add(r.thread_id);
  }
  return out;
}

// Most-recent mention timestamp per thread. Used by Today view's staleness sort.
export async function getLastMentionByThread(): Promise<Map<string, string>> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ thread_id: string; max_at: string }>(
    'SELECT thread_id, MAX(created_at) AS max_at FROM thread_mentions WHERE deleted_at IS NULL GROUP BY thread_id'
  );
  return new Map(rows.map(r => [r.thread_id, r.max_at]));
}

export async function insertMention(m: ThreadMention): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO thread_mentions (
       id, thread_id, entry_id, entry_date, todo_id, source_line, tag_text, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.id, m.threadId, m.entryId, m.entryDate, m.todoId,
      m.sourceLine, m.tagText, m.createdAt, m.createdAt,
    ]
  );
  schedulePush();
}

export async function updateMentionTagText(id: string, tagText: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'UPDATE thread_mentions SET tag_text = ?, updated_at = ? WHERE id = ?',
    [tagText, new Date().toISOString(), id],
  );
  schedulePush();
}

export async function updateMentionSourceLine(id: string, sourceLine: number): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'UPDATE thread_mentions SET source_line = ?, updated_at = ? WHERE id = ?',
    [sourceLine, new Date().toISOString(), id],
  );
  schedulePush();
}

export async function deleteMention(id: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.runAsync(
    'UPDATE thread_mentions SET deleted_at = ?, updated_at = ? WHERE id = ?',
    [now, now, id],
  );
  schedulePush();
}

// ── Day title ──

export async function getDayTitle(date: string): Promise<string> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ title: string }>('SELECT title FROM day_meta WHERE date = ? AND deleted_at IS NULL', [date]);
  return row?.title ?? '';
}

export async function getDayTitleWithTimestamp(date: string): Promise<{ title: string; updatedAt: string | null }> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ title: string; updated_at: string | null }>('SELECT title, updated_at FROM day_meta WHERE date = ? AND deleted_at IS NULL', [date]);
  return { title: row?.title ?? '', updatedAt: row?.updated_at ?? null };
}

export async function setDayTitle(date: string, title: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.runAsync(
    'INSERT INTO day_meta (date, title, updated_at) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at',
    [date, title, now]
  );
  // Touch all entries for this date so they get re-synced with the new title
  await db.runAsync('UPDATE entries SET updated_at = ? WHERE date = ?', [now, date]);
  schedulePush();
}

export async function setDayTitleFromSync(date: string, title: string, notionEditTime?: string): Promise<void> {
  // Used by sync — sets updated_at to the Notion edit time so local doesn't appear newer
  const db = await getDatabase();
  const ts = notionEditTime ?? new Date().toISOString();
  await db.runAsync(
    'INSERT INTO day_meta (date, title, updated_at) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at',
    [date, title, ts]
  );
  schedulePush();
}

// ── Sync queries ──

export async function getAllEntries(): Promise<Entry[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<EntryRow>('SELECT * FROM entries WHERE deleted_at IS NULL ORDER BY created_at ASC');
  return rows.map(mapRowToEntry);
}

export async function deleteEmptyEntries(): Promise<number> {
  const db = await getDatabase();
  const empty = await db.getAllAsync<{ id: string; date: string; text: string | null }>(
    "SELECT id, date, text FROM entries WHERE deleted_at IS NULL AND (text IS NULL OR text = '') AND (habits_json IS NULL OR habits_json = '[]') AND (todos_json IS NULL OR todos_json = '[]') AND (clips_json IS NULL OR clips_json = '[]')"
  );
  console.log('[loopd] deleteEmptyEntries:', empty.length, empty.map(e => ({ id: e.id, date: e.date, text: e.text })));
  for (const e of empty) {
    await deleteEntry(e.id);
  }
  return empty.length;
}

export async function getUnsyncedEntries(lastSync: string | null): Promise<Entry[]> {
  const db = await getDatabase();
  // Always include entries with no notion_page_id (never synced)
  // and entries updated since last sync
  const rows = lastSync
    ? await db.getAllAsync<EntryRow>(
        'SELECT * FROM entries WHERE notion_page_id IS NULL OR updated_at > ? OR updated_at IS NULL',
        [lastSync]
      )
    : await db.getAllAsync<EntryRow>('SELECT * FROM entries');
  console.log('[loopd sync] Unsynced entries:', rows.length, 'lastSync:', lastSync);
  return rows.map(mapRowToEntry);
}

export async function getEntryByNotionPageId(pageId: string): Promise<Entry | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<EntryRow>('SELECT * FROM entries WHERE notion_page_id = ?', [pageId]);
  return row ? mapRowToEntry(row) : null;
}

export async function getEntryById(id: string): Promise<Entry | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<EntryRow>('SELECT * FROM entries WHERE id = ? AND deleted_at IS NULL', [id]);
  return row ? mapRowToEntry(row) : null;
}

export async function setEntryNotionPageId(entryId: string, notionPageId: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('UPDATE entries SET notion_page_id = ? WHERE id = ?', [notionPageId, entryId]);
  // No schedulePush — only the Notion-linkage column changed; doesn't need
  // to flow to cloud (the cloud mirror doesn't carry notion_page_id).
}

export async function upsertEntryFromNotion(entry: Entry): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO entries (id, date, text, habits_json, todos_json, clip_uri, clip_duration_ms, clips_json, created_at, notion_page_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       date = excluded.date, text = excluded.text, habits_json = excluded.habits_json,
       todos_json = excluded.todos_json, clips_json = excluded.clips_json, notion_page_id = excluded.notion_page_id, updated_at = excluded.updated_at`,
    [
      entry.id, entry.date, entry.text,
      JSON.stringify(entry.habits), JSON.stringify(entry.todos ?? []),
      entry.clipUri, entry.clipDurationMs,
      JSON.stringify(entry.clips), entry.createdAt, entry.notionPageId ?? null, now,
    ]
  );
  schedulePush();
}

export async function getSyncDeletions(entityType?: string): Promise<{ entityType: string; entityId: string; notionPageId: string }[]> {
  const db = await getDatabase();
  const rows = entityType
    ? await db.getAllAsync<{ entity_type: string; entity_id: string; notion_page_id: string }>(
        'SELECT entity_type, entity_id, notion_page_id FROM sync_deletions WHERE entity_type = ?',
        [entityType],
      )
    : await db.getAllAsync<{ entity_type: string; entity_id: string; notion_page_id: string }>(
        'SELECT entity_type, entity_id, notion_page_id FROM sync_deletions',
      );
  return rows.map(r => ({ entityType: r.entity_type, entityId: r.entity_id, notionPageId: r.notion_page_id }));
}

export async function clearSyncDeletions(entityType?: string): Promise<void> {
  const db = await getDatabase();
  if (entityType) {
    await db.runAsync('DELETE FROM sync_deletions WHERE entity_type = ?', [entityType]);
  } else {
    await db.runAsync('DELETE FROM sync_deletions');
  }
}

export async function enqueueSyncDeletion(
  entityType: string,
  entityId: string,
  notionPageId: string,
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'INSERT INTO sync_deletions (entity_type, entity_id, notion_page_id, deleted_at) VALUES (?, ?, ?, ?)',
    [entityType, entityId, notionPageId, new Date().toISOString()],
  );
}

// ── Habit CRUD ──

// Note: the `archived` column still exists on the habits table (added in the
// initial Phase A migration). We keep writing 0 to it on insert so the
// NOT NULL constraint is satisfied, but no read path consults it.
export async function insertHabit(habit: Habit): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO habits (
       id, label, sort_order, slug, icon, color,
       cadence_type, cadence_days, cadence_count, archived, time_of_day,
       notion_page_id, notion_last_synced, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      habit.id,
      habit.label,
      habit.sortOrder,
      habit.slug ?? null,
      habit.icon ?? null,
      habit.color ?? null,
      habit.cadenceType ?? 'daily',
      habit.cadenceDays ? JSON.stringify(habit.cadenceDays) : null,
      habit.cadenceCount ?? null,
      habit.timeOfDay ?? 'anytime',
      habit.notionPageId ?? null,
      habit.notionLastSynced ?? null,
      new Date().toISOString(),
    ]
  );
  schedulePush();
}

export async function updateHabit(habit: Habit): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE habits SET
       label = ?, sort_order = ?, slug = ?, icon = ?, color = ?,
       cadence_type = ?, cadence_days = ?, cadence_count = ?, time_of_day = ?,
       notion_page_id = ?, notion_last_synced = ?, updated_at = ?
     WHERE id = ?`,
    [
      habit.label,
      habit.sortOrder,
      habit.slug ?? null,
      habit.icon ?? null,
      habit.color ?? null,
      habit.cadenceType ?? 'daily',
      habit.cadenceDays ? JSON.stringify(habit.cadenceDays) : null,
      habit.cadenceCount ?? null,
      habit.timeOfDay ?? 'anytime',
      habit.notionPageId ?? null,
      habit.notionLastSynced ?? null,
      new Date().toISOString(),
      habit.id,
    ]
  );
  schedulePush();
}

export async function deleteHabit(id: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const row = await db.getFirstAsync<{ notion_page_id: string | null }>(
    'SELECT notion_page_id FROM habits WHERE id = ?', [id]
  );
  if (row?.notion_page_id) {
    await db.runAsync(
      'INSERT INTO sync_deletions (entity_type, entity_id, notion_page_id, deleted_at) VALUES (?, ?, ?, ?)',
      ['habit', id, row.notion_page_id, now]
    );
  }
  await db.runAsync(
    'UPDATE habits SET deleted_at = ?, updated_at = ? WHERE id = ?',
    [now, now, id],
  );
}

// ── Projects ──

export async function getProjectByDate(date: string): Promise<EditorProject | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{
    id: string; date: string; status: string;
    removed_clip_source_keys_json: string | null;
    clips_json: string | null; text_overlays_json: string | null;
    filter_overlays_json: string | null; export_uri: string | null; updated_at: string;
  }>('SELECT * FROM projects WHERE date = ? AND deleted_at IS NULL', [date]);

  if (!row) return null;

  return {
    id: row.id,
    date: row.date,
    status: row.status as EditorProject['status'],
    clips: row.clips_json ? JSON.parse(row.clips_json) : [],
    removedClipSourceKeys: row.removed_clip_source_keys_json ? JSON.parse(row.removed_clip_source_keys_json) : [],
    textOverlays: row.text_overlays_json ? JSON.parse(row.text_overlays_json) : [],
    filterOverlays: row.filter_overlays_json ? JSON.parse(row.filter_overlays_json) : [],
    exportUri: row.export_uri,
    updatedAt: row.updated_at,
  };
}

export async function upsertProject(project: EditorProject): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO projects (id, date, status, clips_json, removed_clip_source_keys_json, text_overlays_json, filter_overlays_json, export_uri, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       status = excluded.status,
       clips_json = excluded.clips_json,
       removed_clip_source_keys_json = excluded.removed_clip_source_keys_json,
       text_overlays_json = excluded.text_overlays_json,
       filter_overlays_json = excluded.filter_overlays_json,
       export_uri = excluded.export_uri,
       updated_at = excluded.updated_at`,
    [
      project.id, project.date, project.status,
      JSON.stringify(project.clips), JSON.stringify(project.removedClipSourceKeys),
      JSON.stringify(project.textOverlays), JSON.stringify(project.filterOverlays), project.exportUri, project.updatedAt,
    ]
  );
  schedulePush();
}

// ── Vlogs ──

export async function getVlogs(): Promise<Vlog[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    id: string; date: string; clip_count: number; habit_count: number;
    caption: string | null;
    duration_seconds: number; export_uri: string | null; created_at: string;
  }>('SELECT * FROM vlogs WHERE deleted_at IS NULL ORDER BY created_at DESC');

  return rows.map(r => ({
    id: r.id,
    date: r.date,
    clipCount: r.clip_count,
    habitCount: r.habit_count,
    caption: r.caption,
    durationSeconds: r.duration_seconds,
    exportUri: r.export_uri,
    createdAt: r.created_at,
  }));
}

// Archive past days (before today) that have entries but no vlog record yet
export async function archivePastDays(todayStr: string): Promise<void> {
  const db = await getDatabase();

  // Find dates with entries that are before today and don't have a vlog record
  const rows = await db.getAllAsync<{ date: string }>(
    `SELECT DISTINCT e.date FROM entries e
     LEFT JOIN vlogs v ON e.date = v.date AND v.deleted_at IS NULL
     WHERE v.id IS NULL AND e.date < ? AND e.deleted_at IS NULL`,
    [todayStr]
  );

  for (const row of rows) {
    const entries = await getEntriesByDate(row.date);
    if (entries.length === 0) continue;

    const clipCount = entries.filter(e => e.clips.length > 0).length;
    const habitsLogged = [...new Set(entries.flatMap(e => e.habits))];

    // Check if there's an exported project for this date
    const project = await getProjectByDate(row.date);
    const exportUri = project?.exportUri ?? null;
    const durationSeconds = project?.clips
      ? project.clips.reduce((sum, c) =>
          sum + Math.round((c.durationMs / 1000) * (c.trimEndPct - c.trimStartPct) / 100), 0)
      : clipCount * 10;

    await insertVlog({
      id: `vlog-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      date: row.date,
      clipCount,
      habitCount: habitsLogged.length,
      caption: `${entries.length} entries captured.`,
      durationSeconds,
      exportUri,
      createdAt: new Date().toISOString(),
    });
  }
}

export async function rebuildVlogs(): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM vlogs');
}

export async function insertVlog(vlog: Vlog): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO vlogs (id, date, clip_count, habit_count, caption, duration_seconds, export_uri, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      vlog.id, vlog.date, vlog.clipCount, vlog.habitCount,
      vlog.caption, vlog.durationSeconds, vlog.exportUri, vlog.createdAt, vlog.createdAt,
    ]
  );
  schedulePush();
}

// ── AI Summaries ──

export async function getAISummary(date: string): Promise<{ summaryJson: string; generatedAt: string; model: string } | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ summary_json: string; generated_at: string; model: string }>(
    'SELECT summary_json, generated_at, model FROM ai_summaries WHERE date = ? AND deleted_at IS NULL', [date]
  );
  return row ? { summaryJson: row.summary_json, generatedAt: row.generated_at, model: row.model } : null;
}

export async function upsertAISummary(date: string, summaryJson: string, model: string): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO ai_summaries (date, summary_json, generated_at, model) VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET summary_json = excluded.summary_json, generated_at = excluded.generated_at, model = excluded.model`,
    [date, summaryJson, now, model]
  );
  schedulePush();
}

// Pull recent AI summaries strictly before `beforeDate`, newest first.
// Used by the relatable-caption generator to feed `recentCaptions` into the
// prompt for tonal continuity and anti-repetition.
export async function getRecentAISummaries(
  beforeDate: string,
  limit = 5,
): Promise<{ date: string; summaryJson: string; generatedAt: string; model: string }[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ date: string; summary_json: string; generated_at: string; model: string }>(
    `SELECT date, summary_json, generated_at, model FROM ai_summaries
     WHERE date < ? AND deleted_at IS NULL
     ORDER BY date DESC
     LIMIT ?`,
    [beforeDate, limit],
  );
  return rows.map(r => ({
    date: r.date,
    summaryJson: r.summary_json,
    generatedAt: r.generated_at,
    model: r.model,
  }));
}
