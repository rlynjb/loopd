import { useCallback, useEffect, useRef, useState } from 'react';
import { getDayTitle, setDayTitle } from '../services/database';

export function useDayTitle(date: string) {
  const [title, setTitle] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    getDayTitle(date).then(setTitle);
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  const updateTitle = useCallback((newTitle: string) => {
    setTitle(newTitle);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setDayTitle(date, newTitle);
    }, 500);
  }, [date]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { title, updateTitle, reload: load };
}
