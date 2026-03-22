import { useEffect, useState } from 'react';
import { getDatabase } from '../services/database';

export function useDatabase() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    getDatabase().then(() => setReady(true));
  }, []);

  return { ready };
}
