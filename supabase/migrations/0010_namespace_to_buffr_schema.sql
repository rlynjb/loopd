-- Move every cloud table into a dedicated `buffr` schema so this Supabase
-- project can host other apps' tables alongside without name collisions.
--
-- ALTER TABLE … SET SCHEMA is a metadata-only operation: no rows are
-- rewritten and the move is near-instant even on large tables. Dependent
-- objects (indexes, constraints, table-level privileges, RLS policies)
-- follow the table automatically. The 0002 policies stay attached even
-- though RLS is disabled (0009) — they re-engage if Phase B re-enables
-- RLS without rewriting them.
--
-- AFTER APPLYING THIS MIGRATION, two out-of-band steps are required:
--   1. Configure the JS client to default-resolve against the new schema
--      — already wired in src/services/sync/client.ts (db.schema = 'buffr').
--   2. In the Supabase dashboard: Project Settings → API → "Exposed schemas"
--      → add `buffr` to the list (next to `public`). Without this PostgREST
--      rejects every query against the new schema. Reload happens within
--      ~30 s of saving; sync resumes automatically.

BEGIN;

CREATE SCHEMA IF NOT EXISTS buffr;

-- Schema-level USAGE is the gate that lets PostgREST + the auth/realtime
-- workers see the schema at all. Without USAGE, even tables with full
-- SELECT/INSERT privileges are invisible.
GRANT USAGE ON SCHEMA buffr TO anon, authenticated, service_role;

-- Entity tables. IF EXISTS keeps the migration idempotent if it gets
-- re-run after partial success.
ALTER TABLE IF EXISTS public.entries          SET SCHEMA buffr;
ALTER TABLE IF EXISTS public.projects         SET SCHEMA buffr;
ALTER TABLE IF EXISTS public.vlogs            SET SCHEMA buffr;
ALTER TABLE IF EXISTS public.day_meta         SET SCHEMA buffr;
ALTER TABLE IF EXISTS public.ai_summaries     SET SCHEMA buffr;
ALTER TABLE IF EXISTS public.habits           SET SCHEMA buffr;
ALTER TABLE IF EXISTS public.todo_meta        SET SCHEMA buffr;
ALTER TABLE IF EXISTS public.threads          SET SCHEMA buffr;
ALTER TABLE IF EXISTS public.thread_mentions  SET SCHEMA buffr;
ALTER TABLE IF EXISTS public.nutrition        SET SCHEMA buffr;

-- The get_server_time RPC (0003) — moved so the client's default schema
-- resolves it. The GRANT EXECUTE TO anon, authenticated from 0003 follows
-- the function automatically. ALTER FUNCTION doesn't support `IF EXISTS`
-- in SET SCHEMA, so we guard with a DO block to keep this migration safely
-- re-runnable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_server_time'
  ) THEN
    ALTER FUNCTION public.get_server_time() SET SCHEMA buffr;
  END IF;
END $$;

-- Default privileges for any FUTURE tables created inside `buffr` (e.g. a
-- later migration that adds a new entity). Without this every new table
-- needs an explicit GRANT block.
ALTER DEFAULT PRIVILEGES IN SCHEMA buffr
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA buffr
  GRANT ALL ON TABLES TO service_role;

COMMIT;
