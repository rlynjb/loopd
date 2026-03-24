import { useCallback, useEffect, useState } from 'react';
import type { Entry } from '../types/entry';
import { getEntriesByDate, insertEntry, updateEntry, deleteEntry } from '../services/database';

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

  const editEntry = useCallback(async (entry: Entry) => {
    await updateEntry(entry);
    setEntries(prev => prev.map(e => e.id === entry.id ? entry : e));
  }, []);

  const removeEntry = useCallback(async (id: string) => {
    await deleteEntry(id);
    setEntries(prev => prev.filter(e => e.id !== id));
  }, []);

  return { entries, loading, addEntry, editEntry, removeEntry, reload: load };
}
