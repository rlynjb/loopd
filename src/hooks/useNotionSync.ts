import { useCallback, useState, useEffect } from 'react';
import { syncAll } from '../services/notion/sync';
import { isNotionConfigured, getLastSyncTimestamp } from '../services/notion/config';
import type { SyncResult, SyncStatus } from '../types/notion';

export function useNotionSync() {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    isNotionConfigured().then(setConfigured);
    getLastSyncTimestamp().then(setLastSynced);
  }, []);

  const syncNow = useCallback(async (): Promise<SyncResult | null> => {
    setStatus('syncing');
    setResult(null);
    try {
      const res = await syncAll();
      setStatus(res.errors.length > 0 ? 'error' : 'success');
      setResult(res);
      const ts = new Date().toISOString();
      setLastSynced(ts);
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus('error');
      setResult({ pulled: 0, pushed: 0, errors: [msg] });
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    setConfigured(await isNotionConfigured());
    setLastSynced(await getLastSyncTimestamp());
  }, []);

  return { status, lastSynced, result, configured, syncNow, refresh };
}
