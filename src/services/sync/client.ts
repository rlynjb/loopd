import 'react-native-url-polyfill/auto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Phase A: hardcoded single-user UUID per docs/loopd-cloud-sync-spec.md §5.1.
// Phase B replaces this with auth.uid() once login lands.
export const PHASE_A_USER_ID = '00000000-0000-0000-0000-000000000001';

// Schema generic is `'loopd'` because the client below sets db.schema = 'loopd'
// (see migration 0010). Without this annotation TS infers the default 'public'
// from `SupabaseClient` and refuses the assignment from createClient.
let client: SupabaseClient<any, any, 'loopd'> | null = null;
let warned = false;

function getEnv(): { url: string; anonKey: string } | null {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || url.includes('YOUR_PROJECT_REF') || anonKey.includes('YOUR_ANON_KEY')) {
    if (!warned) {
      console.warn('[loopd sync] Supabase env vars missing — cloud sync disabled. Copy .env.example → .env and fill in EXPO_PUBLIC_SUPABASE_URL + EXPO_PUBLIC_SUPABASE_ANON_KEY.');
      warned = true;
    }
    return null;
  }
  return { url, anonKey };
}

export function isCloudConfigured(): boolean {
  return getEnv() !== null;
}

// Returns null when env isn't configured. Callers must handle that case
// (orchestrator no-ops, dev menu shows a "not configured" message).
export function getSupabase(): SupabaseClient<any, any, 'loopd'> | null {
  if (client) return client;
  const env = getEnv();
  if (!env) return null;
  client = createClient(env.url, env.anonKey, {
    auth: {
      // Phase A has no auth UX — don't try to persist a session that doesn't exist.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    // Default-resolve every .from() and .rpc() against the loopd schema so
    // this client can share a Supabase project with other apps' schemas
    // without table-name collisions. See supabase/migrations/0010.
    db: { schema: 'loopd' },
    // Realtime is unused at v1 (pull-on-foreground is sufficient per spec §11).
    realtime: { params: { eventsPerSecond: 1 } },
  });
  return client;
}
