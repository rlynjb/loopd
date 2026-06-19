-- loopd cloud sync — initial Postgres schema
-- See docs/loopd-cloud-sync-spec.md and docs/loopd-cloud-sync-plan.md (M0).
--
-- Mirrors the local SQLite schema in src/services/database.ts modulo:
--   - user_id UUID NOT NULL on every table (Phase A: dummy user)
--   - deleted_at TIMESTAMPTZ on every table (soft delete)
--   - INTEGER booleans → BOOLEAN
--   - TEXT ISO timestamps → TIMESTAMPTZ
--   - TEXT JSON columns → JSONB
--   - SQLite CHECKs → Postgres CHECKs
--   - FK intents → real composite REFERENCES (user_id, parent_id)
--
-- PK is composite (user_id, id) on every entity table so cross-user isolation
-- holds at the schema level even with RLS disabled (Phase A). Matches the
-- ON CONFLICT (user_id, id) upsert pattern in spec §4.2.
--
-- The 11th local table — sync_deletions — is not mirrored. Soft deletes via
-- deleted_at replace its function (spec §4.5).

-- ──────────────────────────────────────────────────────────────────────────
-- entries
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE entries (
  user_id UUID NOT NULL,
  id TEXT NOT NULL,
  date TEXT NOT NULL,
  text TEXT,
  habits_json JSONB,
  todos_json JSONB,
  clip_uri TEXT,
  clip_duration_ms INTEGER,
  clips_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  -- notion_page_id intentionally dropped from the cloud mirror — Notion is
  -- being deprecated by this spec. Kept locally during the dual-run window
  -- (M4–M6) and dropped from the local schema in M7.
  PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_entries_user_updated ON entries (user_id, updated_at DESC);
CREATE INDEX idx_entries_user_alive ON entries (user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_entries_user_date ON entries (user_id, date);

-- ──────────────────────────────────────────────────────────────────────────
-- projects
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE projects (
  user_id UUID NOT NULL,
  id TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'exported')),
  clips_json JSONB,
  removed_clip_source_keys_json JSONB,
  text_overlays_json JSONB,
  filter_overlays_json JSONB,
  export_uri TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, date)
);
CREATE INDEX idx_projects_user_updated ON projects (user_id, updated_at DESC);
CREATE INDEX idx_projects_user_alive ON projects (user_id) WHERE deleted_at IS NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- vlogs
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE vlogs (
  user_id UUID NOT NULL,
  id TEXT NOT NULL,
  date TEXT NOT NULL,
  clip_count INTEGER NOT NULL DEFAULT 0,
  habit_count INTEGER NOT NULL DEFAULT 0,
  caption TEXT,
  duration_seconds INTEGER,
  -- export_uri is a device-local file path; sync round-trips it but it's only
  -- meaningful on the originating device. See spec §12 open question.
  export_uri TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_vlogs_user_updated ON vlogs (user_id, updated_at DESC);
CREATE INDEX idx_vlogs_user_alive ON vlogs (user_id) WHERE deleted_at IS NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- day_meta — keyed on (user_id, date)
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE day_meta (
  user_id UUID NOT NULL,
  date TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, date)
);
CREATE INDEX idx_day_meta_user_updated ON day_meta (user_id, updated_at DESC);
CREATE INDEX idx_day_meta_user_alive ON day_meta (user_id) WHERE deleted_at IS NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- ai_summaries — keyed on (user_id, date). summary_json carries both the
-- structured AISummary and the optional relatable-caption fields (spec §3.7).
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE ai_summaries (
  user_id UUID NOT NULL,
  date TEXT NOT NULL,
  summary_json JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  model TEXT NOT NULL,
  -- updated_at mirrors generated_at for sync uniformity. Local M3 adds the
  -- column on the SQLite side and backfills from generated_at.
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, date)
);
CREATE INDEX idx_ai_summaries_user_updated ON ai_summaries (user_id, updated_at DESC);
CREATE INDEX idx_ai_summaries_user_alive ON ai_summaries (user_id) WHERE deleted_at IS NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- nutrition — references entries via (user_id, entry_id)
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE nutrition (
  user_id UUID NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kcal INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  source_line INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, entry_id) REFERENCES entries(user_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_nutrition_user_updated ON nutrition (user_id, updated_at DESC);
CREATE INDEX idx_nutrition_user_alive ON nutrition (user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_nutrition_user_entry ON nutrition (user_id, entry_id);
CREATE INDEX idx_nutrition_user_name ON nutrition (user_id, LOWER(name));

-- ──────────────────────────────────────────────────────────────────────────
-- habits
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE habits (
  user_id UUID NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  slug TEXT,
  icon TEXT,
  color TEXT,
  cadence_type TEXT NOT NULL DEFAULT 'daily'
    CHECK (cadence_type IN ('daily', 'weekdays', 'weekly', 'specific_days', 'n_per_week')),
  cadence_days JSONB,
  cadence_count INTEGER,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  time_of_day TEXT NOT NULL DEFAULT 'anytime'
    CHECK (time_of_day IN ('morning', 'midday', 'evening', 'anytime')),
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_habits_user_updated ON habits (user_id, updated_at DESC);
CREATE INDEX idx_habits_user_alive ON habits (user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_habits_user_slug ON habits (user_id, slug);

-- ──────────────────────────────────────────────────────────────────────────
-- todo_meta — references entries via (user_id, entry_id). The actual TodoItem
-- lives inside entries.todos_json; todo_id is the cross-system identifier.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE todo_meta (
  user_id UUID NOT NULL,
  todo_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'todo'
    CHECK (type IN ('todo', 'idea', 'bug', 'question', 'decision', 'knowledge', 'content')),
  stage TEXT NOT NULL DEFAULT 'todo'
    CHECK (stage IN ('todo', 'in_progress', 'backlog')),
  expanded_md TEXT,
  expanded_at TIMESTAMPTZ,
  model TEXT,
  classifier_confidence TEXT
    CHECK (classifier_confidence IS NULL OR classifier_confidence IN ('high', 'medium', 'low', 'heuristic')),
  classifier_model TEXT,
  user_overridden_type BOOLEAN NOT NULL DEFAULT FALSE,
  position INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, todo_id),
  FOREIGN KEY (user_id, entry_id) REFERENCES entries(user_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_todo_meta_user_updated ON todo_meta (user_id, updated_at DESC);
CREATE INDEX idx_todo_meta_user_alive ON todo_meta (user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_todo_meta_user_entry ON todo_meta (user_id, entry_id);
CREATE INDEX idx_todo_meta_user_type ON todo_meta (user_id, type);

-- ──────────────────────────────────────────────────────────────────────────
-- threads — slug uniqueness is case-insensitive per user (mirrors the local
-- COLLATE NOCASE behavior).
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE threads (
  user_id UUID NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  target_cadence_days INTEGER,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  time_of_day TEXT NOT NULL DEFAULT 'anytime'
    CHECK (time_of_day IN ('morning', 'midday', 'evening', 'anytime')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX idx_threads_user_slug ON threads (user_id, LOWER(slug));
CREATE INDEX idx_threads_user_updated ON threads (user_id, updated_at DESC);
CREATE INDEX idx_threads_user_alive ON threads (user_id) WHERE deleted_at IS NULL;

-- ──────────────────────────────────────────────────────────────────────────
-- thread_mentions — junction. App-level invariant: at least one of entry_id
-- or todo_id is set, EXCEPT for the manual-touch deviation rows where both
-- are NULL (spec §6.6 / Principle 11 deviation). NO DB-level CHECK so the
-- deviation is permitted; see spec §12 open question.
--
-- FKs are nullable composite — Postgres allows NULL parts in composite FKs
-- and skips the check when any part is NULL.
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE thread_mentions (
  user_id UUID NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  entry_id TEXT,
  entry_date TEXT NOT NULL,
  todo_id TEXT,
  source_line INTEGER NOT NULL DEFAULT 0,
  tag_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, thread_id) REFERENCES threads(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, entry_id) REFERENCES entries(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, todo_id) REFERENCES todo_meta(user_id, todo_id) ON DELETE CASCADE
);
CREATE INDEX idx_thread_mentions_user_updated ON thread_mentions (user_id, updated_at DESC);
CREATE INDEX idx_thread_mentions_user_alive ON thread_mentions (user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_thread_mentions_user_thread ON thread_mentions (user_id, thread_id, created_at DESC);
CREATE INDEX idx_thread_mentions_user_entry ON thread_mentions (user_id, entry_id);
CREATE INDEX idx_thread_mentions_user_todo ON thread_mentions (user_id, todo_id);
