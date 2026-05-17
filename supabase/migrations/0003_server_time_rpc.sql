-- Server-time RPC used by the pull half of the cloud sync layer.
-- See docs/buffr-cloud-sync-spec.md §4.7.
--
-- The pull flow calls this RPC before the data query, then stamps
-- sync_meta.last_pull_at with the returned value. Eliminates clock-skew
-- bugs where a device's local clock disagrees with the server's.

CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS TIMESTAMPTZ
LANGUAGE SQL
STABLE
AS $$
  SELECT NOW();
$$;

-- Anon role needs EXECUTE for the RPC to be callable from the client.
-- Phase A: single dummy user; Phase B: still safe — returns only the
-- current time, not user data.
GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon, authenticated;
