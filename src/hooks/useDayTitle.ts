import { useCallback, useEffect, useRef, useState } from 'react';
import { getDayTitle, setDayTitle } from '../services/database';

export function useDayTitle(date: string) {
  const [title, setTitle] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getDayTitle(date).then(setTitle);
  }, [date]);

  const updateTitle = useCallback((newTitle: string) => {
    setTitle(newTitle);
    // Debounce the save — only persist after 500ms of no typing
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setDayTitle(date, newTitle);
    }, 500);
  }, [date]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { title, updateTitle };
}
