-- buffr cloud sync — RLS policies (DISABLED in Phase A)
-- See docs/buffr-cloud-sync-spec.md §3.6.
--
-- Phase A (single developer, hardcoded user_id) does not need RLS — the
-- anon key + dummy UUID is the entire access boundary. These policies are
-- written and applied but the row-level enforcement is OFF on every table.
--
-- Phase B flips ENABLE on every table when real auth lands. The policy is
-- the same on every table: a row is visible to its owning user.

-- Policies first; enable is the very last block so nothing is enforced
-- mid-migration.
CREATE POLICY "users access own rows" ON entries
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users access own rows" ON projects
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users access own rows" ON vlogs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users access own rows" ON day_meta
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users access own rows" ON ai_summaries
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users access own rows" ON nutrition
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users access own rows" ON habits
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users access own rows" ON todo_meta
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users access own rows" ON threads
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "users access own rows" ON thread_mentions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Phase A: leave RLS DISABLED on every table. Phase B replaces these lines
-- with ENABLE.
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
