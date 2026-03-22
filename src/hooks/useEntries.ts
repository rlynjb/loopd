import { useCallback, useEffect, useState } from 'react';
import type { Entry } from '../types/entry';
import { getEntriesByDate, insertEntry, deleteEntry } from '../services/database';

export function useEntries(date: string) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await getEntriesByDate(date);
    setEntries(result);
    setLoading(false);
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  const addEntry = useCallback(async (entry: Entry) => {
    await insertEntry(entry);
    setEntries(prev => [...prev, entry]);
  }, []);

  const removeEntry = useCallback(async (id: string) => {
    await deleteEntry(id);
    setEntries(prev => prev.filter(e => e.id !== id));
  }, []);

  return { entries, loading, addEntry, removeEntry, reload: load };
}
