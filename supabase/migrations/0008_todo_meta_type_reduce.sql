-- Drop 'bug' / 'question' / 'decision' / 'content' from the todo_meta.type
-- CHECK (2026-05-10). These were the engineering-flavored thinking modes;
-- the surface is being narrowed to: todo, idea, knowledge, study, reflect.
--
-- Existing rows with the dropped types are remapped to 'todo' first so
-- the constraint can attach. user_overridden_type is cleared so the
-- classifier is free to pick a valid type on a future re-classification
-- (the prior override pointed at a value that no longer exists).
--
-- Local SQLite handles the same dance in services/database.ts via a
-- recreate-table block.

UPDATE todo_meta
SET type = 'todo', user_overridden_type = FALSE
WHERE type IN ('bug', 'question', 'decision', 'content');

ALTER TABLE todo_meta DROP CONSTRAINT IF EXISTS todo_meta_type_check;
ALTER TABLE todo_meta ADD CONSTRAINT todo_meta_type_check
  CHECK (type IN ('todo', 'idea', 'knowledge', 'study', 'reflect'));
