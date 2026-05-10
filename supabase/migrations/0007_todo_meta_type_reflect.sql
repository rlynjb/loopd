-- Widen the todo_meta.type CHECK to include 'reflect' (added 2026-05-10).
-- Local SQLite handles the recreate-table dance in services/database.ts —
-- the same migration block from 0006 was repurposed to also cover this
-- value (recreates when 'reflect' is missing from the schema).
--
-- 'reflect' captures past-facing introspection — something the user wants
-- to *sit with* and re-examine. Distinct from 'question' (a specific
-- answerable ask) and 'knowledge' (an absorbed insight). The classifier
-- picks it for thoughts like "reflect on X", "process that conversation",
-- "think about why Y happened".

ALTER TABLE todo_meta DROP CONSTRAINT IF EXISTS todo_meta_type_check;
ALTER TABLE todo_meta ADD CONSTRAINT todo_meta_type_check
  CHECK (type IN ('todo', 'idea', 'bug', 'question', 'decision', 'knowledge', 'content', 'study', 'reflect'));
