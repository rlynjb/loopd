-- Drop the threads + thread_mentions cloud tables. The feature was removed
-- from the app in 2026-06; the SQLite side drops them on next open via
-- DROP TABLE IF EXISTS in src/services/database.ts. This migration mirrors
-- that on the cloud so PostgREST stops exposing them.
--
-- thread_mentions is dropped first because it carries the FK to threads.
-- Both tables live in the `buffr` schema after 0010_namespace_to_buffr_schema.
-- IF EXISTS keeps the migration idempotent across environments where one
-- side or the other may already be gone.

BEGIN;

DROP TABLE IF EXISTS buffr.thread_mentions;
DROP TABLE IF EXISTS buffr.threads;

COMMIT;
