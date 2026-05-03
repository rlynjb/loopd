-- Drop the over-strict FK constraints introduced in 0001.
--
-- Why: local SQLite enforces NO FK constraints on these relationships. The
-- app maintains integrity at the scanner / CRUD layer (deleteEntry cascades
-- nutrition + todo_meta; deleteThread cascades thread_mentions; etc).
-- Cloud-side FK enforcement was a nice-to-have but it diverges from local
-- semantics — and the divergence costs us push failures whenever local
-- contains a permitted soft-orphan (e.g. a thread_mention whose todo_id
-- pointed to a TodoItem that's since been removed from todos_json without
-- its mention being reconciled).
--
-- Match cloud to local: derive integrity from the canonical source (prose +
-- scanners), not from cloud schema constraints. Soft delete (M3) makes
-- cascade behavior moot anyway — rows never hard-delete before vacuum.

ALTER TABLE nutrition       DROP CONSTRAINT IF EXISTS nutrition_user_id_entry_id_fkey;
ALTER TABLE todo_meta       DROP CONSTRAINT IF EXISTS todo_meta_user_id_entry_id_fkey;
ALTER TABLE thread_mentions DROP CONSTRAINT IF EXISTS thread_mentions_user_id_thread_id_fkey;
ALTER TABLE thread_mentions DROP CONSTRAINT IF EXISTS thread_mentions_user_id_entry_id_fkey;
ALTER TABLE thread_mentions DROP CONSTRAINT IF EXISTS thread_mentions_user_id_todo_id_fkey;
