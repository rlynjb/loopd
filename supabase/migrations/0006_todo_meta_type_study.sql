-- Widen the todo_meta.type CHECK to include 'study' (added 2026-05-09).
-- Local SQLite handles the recreate-table dance in services/database.ts.
-- Postgres can drop + add the constraint in place.
--
-- 'study' captures a learning intention — distinct from 'knowledge'
-- (an absorbed insight), 'idea' (an unproven possibility), and
-- 'content' (something to publish). The classifier picks it for
-- thoughts like "study X", "want to learn Y", "read paper on Z".

ALTER TABLE todo_meta DROP CONSTRAINT IF EXISTS todo_meta_type_check;
ALTER TABLE todo_meta ADD CONSTRAINT todo_meta_type_check
  CHECK (type IN ('todo', 'idea', 'bug', 'question', 'decision', 'knowledge', 'content', 'study'));
