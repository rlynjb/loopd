-- Add `pinned` flag to todo_meta on the cloud mirror.
-- Local SQLite added the column in services/database.ts on 2026-05-05.
-- Replaces the deprecated manual-reorder feature: pinned rows float to
-- the top of the /todos list above the createdAt-DESC default sort.
--
-- Default FALSE so existing rows pull down with no behavioral change.
-- Local writes round-trip through services/sync/tables/todoMeta.ts.

ALTER TABLE todo_meta ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
