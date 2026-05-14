-- Rollback RLS to the Phase A posture (2026-05-13).
-- The app currently authenticates with the Supabase anon key and no user
-- session (see src/services/sync/client.ts:34-44 — persistSession: false).
-- With RLS enabled, auth.uid() returns NULL for every sync request, so
-- the `auth.uid() = user_id` policies from 0002 deny every push and pull.
-- Cloud sync silently freezes; local SQLite stays canonical and the app
-- feels normal, but cloud diverges.
--
-- This migration disables RLS on every synced table so sync resumes. The
-- 0002 policies stay defined (they don't enforce while RLS is disabled);
-- the eventual Phase B migration re-enables RLS *after* Supabase Auth is
-- wired in so auth.uid() actually returns the logged-in UUID.
--
-- This is the Phase-A-correct posture per docs/loopd-cloud-sync-spec.md §3.6.
-- The anon key + hardcoded user_id stay the entire access boundary until
-- Phase B ships.

ALTER TABLE entries         DISABLE ROW LEVEL SECURITY;
ALTER TABLE projects        DISABLE ROW LEVEL SECURITY;
ALTER TABLE vlogs           DISABLE ROW LEVEL SECURITY;
ALTER TABLE day_meta        DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_summaries    DISABLE ROW LEVEL SECURITY;
ALTER TABLE nutrition       DISABLE ROW LEVEL SECURITY;
ALTER TABLE habits          DISABLE ROW LEVEL SECURITY;
ALTER TABLE todo_meta       DISABLE ROW LEVEL SECURITY;
ALTER TABLE threads         DISABLE ROW LEVEL SECURITY;
ALTER TABLE thread_mentions DISABLE ROW LEVEL SECURITY;
