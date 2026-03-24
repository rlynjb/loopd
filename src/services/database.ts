import * as SQLite from 'expo-sqlite';
import type { Entry, Habit, Vlog } from '../types/entry';
import type { EditorProject } from '../types/project';

let db: SQLite.SQLiteDatabase | null = null;

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync('loopd.db');
  await migrate(db);
  return db;
}

async function migrate(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS habits (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      emoji TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT,
      mood TEXT,
      category TEXT,
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
      mood TEXT,
      caption TEXT,
      categories_json TEXT,
      duration_seconds INTEGER,
      export_uri TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
    CREATE INDEX IF NOT EXISTS idx_projects_date ON projects(date);
  `);

  // Migration: add clips_json column if missing
  try {
    await database.execAsync(`ALTER TABLE entries ADD COLUMN clips_json TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Seed habits if empty
  const count = await database.getFirstAsync<{ c: number }>('SELECT COUNT(*) as c FROM habits');
  if (count && count.c === 0) {
    await database.execAsync(`
      INSERT INTO habits (id, label, emoji, sort_order) VALUES
        ('workout', 'Workout', '', 0),
        ('study', 'Study', '', 1),
        ('vlog', 'Vlog', '', 2),
        ('meditate', 'Meditate', '', 3),
        ('read', 'Read', '', 4);
    `);
  }
}

// ── Habits ──

export async function getHabits(): Promise<Habit[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ id: string; label: string; emoji: string; sort_order: number }>(
    'SELECT * FROM habits ORDER BY sort_order'
  );
  return rows.map(r => ({ id: r.id, label: r.label, emoji: r.emoji, sortOrder: r.sort_order }));
}

// ── Entries ──

export async function getEntriesByDate(date: string): Promise<Entry[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    id: string; date: string; type: string; text: string | null;
    mood: string | null; category: string | null; habits_json: string | null;
    clip_uri: string | null; clip_duration_ms: number | null;
    clips_json: string | null; created_at: string;
  }>('SELECT * FROM entries WHERE date = ? ORDER BY created_at ASC', [date]);

  return rows.map(r => ({
    id: r.id,
    date: r.date,
    type: r.type as Entry['type'],
    text: r.text,
    mood: r.mood,
    category: r.category,
    habits: r.habits_json ? JSON.parse(r.habits_json) : [],
    clipUri: r.clip_uri,
    clipDurationMs: r.clip_duration_ms,
    clips: r.clips_json ? JSON.parse(r.clips_json) : (r.clip_uri ? [{ uri: r.clip_uri, durationMs: r.clip_duration_ms ?? 0 }] : []),
    createdAt: r.created_at,
  }));
}

export async function insertEntry(entry: Entry): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO entries (id, date, type, text, mood, category, habits_json, clip_uri, clip_duration_ms, clips_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id, entry.date, entry.type, entry.text, entry.mood, entry.category,
      JSON.stringify(entry.habits), entry.clipUri, entry.clipDurationMs,
      JSON.stringify(entry.clips), entry.createdAt,
    ]
  );
}

export async function updateEntry(entry: Entry): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE entries SET text = ?, mood = ?, category = ?, habits_json = ?, clips_json = ? WHERE id = ?`,
    [entry.text, entry.mood, entry.category, JSON.stringify(entry.habits), JSON.stringify(entry.clips), entry.id]
  );
}

export async function deleteEntry(id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM entries WHERE id = ?', [id]);
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
    mood: string | null; caption: string | null; categories_json: string | null;
    duration_seconds: number; export_uri: string | null; created_at: string;
  }>('SELECT * FROM vlogs ORDER BY created_at DESC');

  return rows.map(r => ({
    id: r.id,
    date: r.date,
    clipCount: r.clip_count,
    habitCount: r.habit_count,
    mood: r.mood,
    caption: r.caption,
    categories: r.categories_json ? JSON.parse(r.categories_json) : [],
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

    const clipCount = entries.filter(e => e.type === 'video').length;
    const habitsLogged = [...new Set(entries.filter(e => e.type === 'habit').flatMap(e => e.habits))];
    const moods = entries.map(e => e.mood).filter(Boolean);
    const cats = [...new Set(entries.map(e => e.category).filter(Boolean))];
    const topMood = moods.length ? moods[moods.length - 1] : 'calm';

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
      mood: topMood,
      caption: `${entries.length} entries captured.`,
      categories: cats as string[],
      durationSeconds,
      exportUri,
      createdAt: new Date().toISOString(),
    });
  }
}

export async function insertVlog(vlog: Vlog): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO vlogs (id, date, clip_count, habit_count, mood, caption, categories_json, duration_seconds, export_uri, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      vlog.id, vlog.date, vlog.clipCount, vlog.habitCount,
      vlog.mood, vlog.caption, JSON.stringify(vlog.categories),
      vlog.durationSeconds, vlog.exportUri, vlog.createdAt,
    ]
  );
}
