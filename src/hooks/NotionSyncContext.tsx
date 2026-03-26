import { createContext, useContext, useCallback, useState, useEffect, type ReactNode } from 'react';
import { syncAll } from '../services/notion/sync';
import { isNotionConfigured, getLastSyncTimestamp } from '../services/notion/config';
import type { SyncResult, SyncStatus } from '../types/notion';

type NotionSyncContextType = {
  status: SyncStatus;
  lastSynced: string | null;
  result: SyncResult | null;
  configured: boolean;
  syncNow: () => Promise<SyncResult | null>;
  refresh: () => Promise<void>;
};

const NotionSyncContext = createContext<NotionSyncContextType>({
  status: 'idle',
  lastSynced: null,
  result: null,
  configured: false,
  syncNow: async () => null,
  refresh: async () => {},
});

export function NotionSyncProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    isNotionConfigured().then(setConfigured);
    getLastSyncTimestamp().then(setLastSynced);
  }, []);

  const syncNow = useCallback(async (): Promise<SyncResult | null> => {
    if (status === 'syncing') return null;
    setStatus('syncing');
    setResult(null);
    try {
      const res = await syncAll();
      setStatus(res.errors.length > 0 ? 'error' : 'success');
      setResult(res);
      setLastSynced(new Date().toISOString());
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus('error');
      setResult({ pulled: 0, pushed: 0, errors: [msg], debug: [] });
      return null;
    }
  }, [status]);

  const refresh = useCallback(async () => {
    setConfigured(await isNotionConfigured());
    setLastSynced(await getLastSyncTimestamp());
  }, []);

  return (
    <NotionSyncContext.Provider value={{ status, lastSynced, result, configured, syncNow, refresh }}>
      {children}
    </NotionSyncContext.Provider>
  );
}

export function useNotionSync() {
  return useContext(NotionSyncContext);
}
