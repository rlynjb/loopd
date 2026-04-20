import { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import type { Habit } from '../../types/entry';

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
  const { loggedDays, cells, checkedToday } = useMemo(() => {
    // Anchor to a Sunday so each column is the same weekday across rows and
    // weeks. Start = the Sunday of the week containing (today - 7 days), i.e.
    // the Sunday of the previous calendar week. That gives exactly 2 full
    // Sun→Sat weeks ending on the Saturday of the current week; today lands
    // in its own weekday column (not always the last cell).
    const todayDow = new Date(today + 'T12:00:00').getDay(); // 0 = Sunday
    const start = addDays(today, -(todayDow + 7));
    const list: { date: string; checked: boolean }[] = [];
    let hits = 0;
    for (let i = 0; i < DAYS; i++) {
      const d = addDays(start, i);
      const checked = checkedDates.has(d);
      if (checked) hits++;
      list.push({ date: d, checked });
    }
    return {
      loggedDays: hits,
      cells: list,
      checkedToday: checkedDates.has(today),
    };
  }, [checkedDates, today]);

  return (
    <Pressable onPress={onToggleToday} style={styles.row} hitSlop={4}>
      <Text style={styles.label} numberOfLines={1}>{habit.label}</Text>
      <View style={styles.heatmap}>
        {cells.map((c, i) => (
          <View
            key={`${c.date}-${i}`}
            style={[
              styles.cell,
              c.checked ? styles.cellOn : styles.cellOff,
              c.date === today && styles.cellToday,
              c.date === today && checkedToday && styles.cellTodayOn,
            ]}
          />
        ))}
      </View>
      <Text style={styles.count}>{loggedDays}/{DAYS}</Text>
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
  cellOn: {
    backgroundColor: colors.green,
  },
  cellOff: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  cellToday: {
    borderWidth: 1,
    borderColor: colors.accent,
  },
  cellTodayOn: {
    borderColor: colors.green,
  },
  count: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    width: 36,
    textAlign: 'right',
  },
});
