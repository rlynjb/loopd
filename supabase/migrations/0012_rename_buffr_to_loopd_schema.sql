-- Rename the `buffr` schema (created in 0010) to `loopd` to reflect the
-- app's reverted name. ALTER SCHEMA … RENAME is a metadata-only op: every
-- table, function, index, RLS policy, and default privilege follows the
-- schema automatically. No row rewrites, no privilege re-grants needed.
--
-- AFTER APPLYING THIS MIGRATION, one out-of-band step is required:
--   1. In the Supabase dashboard: Project Settings → API → "Exposed schemas"
--      → replace `buffr` with `loopd` in the list. Without this PostgREST
--      keeps trying to resolve queries against the old name and returns
--      404s. Reload happens within ~30 s of saving; sync resumes
--      automatically.
--
-- The JS client is already wired to `loopd` (src/services/sync/client.ts —
-- db.schema = 'loopd'), so once the dashboard is updated, no further code
-- change is needed.

BEGIN;

ALTER SCHEMA buffr RENAME TO loopd;

COMMIT;
