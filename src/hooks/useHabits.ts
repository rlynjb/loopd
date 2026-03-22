import { useEffect, useState } from 'react';
import type { Habit } from '../types/entry';
import { getHabits } from '../services/database';

export function useHabits() {
  const [habits, setHabits] = useState<Habit[]>([]);

  useEffect(() => {
    getHabits().then(setHabits);
  }, []);

  return habits;
}
