import * as SQLite from 'expo-sqlite';
import { File as FSFile, Paths } from 'expo-file-system';
import type { Entry, Habit, Vlog } from '../types/entry';
import type { EditorProject } from '../types/project';

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

  // Backfill updated_at
  await database.execAsync(`UPDATE entries SET updated_at = created_at WHERE updated_at IS NULL`);
  await database.execAsync(`UPDATE habits SET updated_at = datetime('now') WHERE updated_at IS NULL`);

  // Seed habits if empty
  const count = await database.getFirstAsync<{ c: number }>('SELECT COUNT(*) as c FROM habits');
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

export async function getHabits(): Promise<Habit[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ id: string; label: string; sort_order: number }>(
    'SELECT * FROM habits ORDER BY sort_order'
  );
  return rows.map(r => ({ id: r.id, label: r.label, sortOrder: r.sort_order }));
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
  return {
    id: r.id,
    date: r.date,
    text: r.text,
    habits: r.habits_json ? JSON.parse(r.habits_json) : [],
    todos: r.todos_json ? JSON.parse(r.todos_json) : [],
    clipUri: r.clip_uri,
    clipDurationMs: r.clip_duration_ms,
    clips: r.clips_json ? JSON.parse(r.clips_json) : (r.clip_uri ? [{ uri: r.clip_uri, durationMs: r.clip_duration_ms ?? 0 }] : []),
    createdAt: r.created_at,
    notionPageId: r.notion_page_id,
    updatedAt: r.updated_at,
  };
}

// ── Entries ──

export async function getEntriesByDate(date: string): Promise<Entry[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<EntryRow>(
    'SELECT * FROM entries WHERE date = ? ORDER BY created_at ASC', [date]
  );

  return rows.map(r => mapRowToEntry(r));
}

export async function insertEntry(entry: Entry): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO entries (id, date, text, habits_json, todos_json, clip_uri, clip_duration_ms, clips_json, created_at, notion_page_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id, entry.date, entry.text,
      JSON.stringify(entry.habits), JSON.stringify(entry.todos ?? []),
      entry.clipUri, entry.clipDurationMs,
      JSON.stringify(entry.clips), entry.createdAt, entry.notionPageId ?? null, now,
    ]
  );
}

export async function updateEntry(entry: Entry): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.runAsync(
    `UPDATE entries SET text = ?, habits_json = ?, todos_json = ?, clips_json = ?, updated_at = ? WHERE id = ?`,
    [entry.text, JSON.stringify(entry.habits), JSON.stringify(entry.todos ?? []), JSON.stringify(entry.clips), now, entry.id]
  );
}

export async function deleteEntry(id: string): Promise<void> {
  const db = await getDatabase();
  // Track deletion for sync if it had a notion_page_id
  const row = await db.getFirstAsync<{ notion_page_id: string | null }>('SELECT notion_page_id FROM entries WHERE id = ?', [id]);
  if (row?.notion_page_id) {
    await db.runAsync(
      'INSERT INTO sync_deletions (entity_type, entity_id, notion_page_id, deleted_at) VALUES (?, ?, ?, ?)',
      ['entry', id, row.notion_page_id, new Date().toISOString()]
    );
  }
  await db.runAsync('DELETE FROM entries WHERE id = ?', [id]);
}

// ── Day title ──

export async function getDayTitle(date: string): Promise<string> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ title: string }>('SELECT title FROM day_meta WHERE date = ?', [date]);
  return row?.title ?? '';
}

export async function getDayTitleWithTimestamp(date: string): Promise<{ title: string; updatedAt: string | null }> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ title: string; updated_at: string | null }>('SELECT title, updated_at FROM day_meta WHERE date = ?', [date]);
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
}

export async function setDayTitleFromSync(date: string, title: string, notionEditTime?: string): Promise<void> {
  // Used by sync — sets updated_at to the Notion edit time so local doesn't appear newer
  const db = await getDatabase();
  const ts = notionEditTime ?? new Date().toISOString();
  await db.runAsync(
    'INSERT INTO day_meta (date, title, updated_at) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at',
    [date, title, ts]
  );
}

// ── Sync queries ──

export async function getAllEntries(): Promise<Entry[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<EntryRow>('SELECT * FROM entries ORDER BY created_at ASC');
  return rows.map(mapRowToEntry);
}

export async function deleteEmptyEntries(): Promise<number> {
  const db = await getDatabase();
  const empty = await db.getAllAsync<{ id: string; date: string; text: string | null }>(
    "SELECT id, date, text FROM entries WHERE (text IS NULL OR text = '') AND (habits_json IS NULL OR habits_json = '[]') AND (todos_json IS NULL OR todos_json = '[]') AND (clips_json IS NULL OR clips_json = '[]')"
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
  const row = await db.getFirstAsync<EntryRow>('SELECT * FROM entries WHERE id = ?', [id]);
  return row ? mapRowToEntry(row) : null;
}

export async function setEntryNotionPageId(entryId: string, notionPageId: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('UPDATE entries SET notion_page_id = ? WHERE id = ?', [notionPageId, entryId]);
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
}

export async function getSyncDeletions(): Promise<{ entityType: string; entityId: string; notionPageId: string }[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ entity_type: string; entity_id: string; notion_page_id: string }>(
    'SELECT entity_type, entity_id, notion_page_id FROM sync_deletions'
  );
  return rows.map(r => ({ entityType: r.entity_type, entityId: r.entity_id, notionPageId: r.notion_page_id }));
}

export async function clearSyncDeletions(): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM sync_deletions');
}

// ── Habit CRUD ──

export async function insertHabit(habit: Habit): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'INSERT INTO habits (id, label, sort_order, notion_page_id, updated_at) VALUES (?, ?, ?, ?, ?)',
    [habit.id, habit.label, habit.sortOrder, habit.notionPageId ?? null, new Date().toISOString()]
  );
}

export async function updateHabit(habit: Habit): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'UPDATE habits SET label = ?, sort_order = ?, updated_at = ? WHERE id = ?',
    [habit.label, habit.sortOrder, new Date().toISOString(), habit.id]
  );
}

export async function deleteHabit(id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM habits WHERE id = ?', [id]);
}

// ── Projects ──

export async function getProjectByDate(date: string): Promise<EditorProject | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{
    id: string; date: string; status: string;
    clips_json: string | null; text_overlays_json: string | null;
    filter_overlays_json: string | null; export_uri: string | null; updated_at: string;
  }>('SELECT * FROM projects WHERE date = ?', [date]);

  if (!row) return null;

  return {
    id: row.id,
    date: row.date,
    status: row.status as EditorProject['status'],
    clips: row.clips_json ? JSON.parse(row.clips_json) : [],
    textOverlays: row.text_overlays_json ? JSON.parse(row.text_overlays_json) : [],
    filterOverlays: row.filter_overlays_json ? JSON.parse(row.filter_overlays_json) : [],
    exportUri: row.export_uri,
    updatedAt: row.updated_at,
  };
}

export async function upsertProject(project: EditorProject): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO projects (id, date, status, clips_json, text_overlays_json, filter_overlays_json, export_uri, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       status = excluded.status,
       clips_json = excluded.clips_json,
       text_overlays_json = excluded.text_overlays_json,
       filter_overlays_json = excluded.filter_overlays_json,
       export_uri = excluded.export_uri,
       updated_at = excluded.updated_at`,
    [
      project.id, project.date, project.status,
      JSON.stringify(project.clips), JSON.stringify(project.textOverlays),
      JSON.stringify(project.filterOverlays), project.exportUri, project.updatedAt,
    ]
  );
}

// ── Vlogs ──

export async function getVlogs(): Promise<Vlog[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    id: string; date: string; clip_count: number; habit_count: number;
    caption: string | null;
    duration_seconds: number; export_uri: string | null; created_at: string;
  }>('SELECT * FROM vlogs ORDER BY created_at DESC');

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
     LEFT JOIN vlogs v ON e.date = v.date
     WHERE v.id IS NULL AND e.date < ?`,
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
    `INSERT INTO vlogs (id, date, clip_count, habit_count, caption, duration_seconds, export_uri, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      vlog.id, vlog.date, vlog.clipCount, vlog.habitCount,
      vlog.caption, vlog.durationSeconds, vlog.exportUri, vlog.createdAt,
    ]
  );
}

// ── AI Summaries ──

export async function getAISummary(date: string): Promise<{ summaryJson: string; generatedAt: string; model: string } | null> {
  const db = await getDatabase();
  const row = await db.getFirstAsync<{ summary_json: string; generated_at: string; model: string }>(
    'SELECT summary_json, generated_at, model FROM ai_summaries WHERE date = ?', [date]
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
}
