import { useEffect, useState } from 'react';
import { getDatabase } from '../services/database';

export function useDatabase() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDatabase()
      .then(() => setReady(true))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[loopd] Database init failed:', message);
        setError(message);
      });
  }, []);

  return { ready, error };
}
