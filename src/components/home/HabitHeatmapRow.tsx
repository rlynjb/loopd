import { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import type { Habit } from '../../types/entry';
import { getCellState, computeStreak, type CellState } from '../../services/habits/streaks';

const DAYS = 14;

type Props = {
  habit: Habit;
  checkedDates: Set<string>;   // YYYY-MM-DD strings where this habit was logged
  today: string;               // YYYY-MM-DD
  onToggleToday: () => void;
};

function addDays(baseISO: string, delta: number): string {
  const d = new Date(baseISO + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function HabitHeatmapRow({ habit, checkedDates, today, onToggleToday }: Props) {
  const { cells, streak } = useMemo(() => {
    // Anchor to a Sunday so each column is the same weekday across rows and
    // weeks. Start = the Sunday of the week containing (today - 7 days), i.e.
    // the Sunday of the previous calendar week. That gives exactly 2 full
    // Sun→Sat weeks ending on the Saturday of the current week; today lands
    // in its own weekday column (not always the last cell).
    const todayDow = new Date(today + 'T12:00:00').getDay(); // 0 = Sunday
    const start = addDays(today, -(todayDow + 7));
    const list: { date: string; state: CellState }[] = [];
    for (let i = 0; i < DAYS; i++) {
      const d = addDays(start, i);
      const dateObj = new Date(d + 'T12:00:00');
      const checked = checkedDates.has(d);
      const state = getCellState(habit, dateObj, checked, today);
      list.push({ date: d, state });
    }
    return {
      cells: list,
      streak: computeStreak(habit, today, checkedDates),
    };
  }, [habit, checkedDates, today]);

  return (
    <Pressable onPress={onToggleToday} style={styles.row} hitSlop={4}>
      <Text style={styles.label} numberOfLines={1}>{habit.label}</Text>
      <View style={styles.heatmap}>
        {cells.map((c, i) => (
          <View
            key={`${c.date}-${i}`}
            style={[
              styles.cell,
              c.state === 'completed' && styles.cellCompleted,
              c.state === 'missed' && styles.cellMissed,
              c.state === 'neutral' && styles.cellNeutral,
              c.state === 'today-pending' && styles.cellTodayPending,
            ]}
          />
        ))}
      </View>
      <Text style={styles.count}>{streak}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
  },
  label: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.text,
    width: 80,
  },
  heatmap: {
    flex: 1,
    flexDirection: 'row',
    gap: 2,
    alignItems: 'center',
  },
  cell: {
    flex: 1,
    height: 11,
    borderRadius: 2,
  },
  cellCompleted: {
    backgroundColor: colors.green,
  },
  cellMissed: {
    backgroundColor: 'rgba(224,85,85,0.18)',
  },
  cellNeutral: {
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  cellTodayPending: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: colors.accent,
  },
  count: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    width: 36,
    textAlign: 'right',
  },
});
