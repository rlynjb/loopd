// Daily Schedule weekly grid — 7-column weekday layout for habits.
// See docs/loopd-daily-schedule-grid-spec.md.
//
// Receives the visible week's anchor (Monday) plus habits + their check-in
// maps; renders rows bucketed by time_of_day. cellStateFor() drives the
// per-cell visual (cadence-aware).
//
// Tap is enabled only on today's pending/done cells. Tap-on-name routes
// to the habit edit screen.
import { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import type { Habit, TimeOfDay } from '../../types/entry';
import { isoWeekDates, summarizeCadence } from '../../services/habits/cadence';
import { cellStateFor, type CellState } from './cellState';

type Props = {
  habits: Habit[];
  checkedDatesByHabit: Map<string, Set<string>>;
  weekStart: string;            // YYYY-MM-DD, Monday of the visible week
  today: string;                // YYYY-MM-DD
  offDayMode: 'hidden' | 'faded';
  isReadOnly?: boolean;         // true for past-week views
  onToggleHabitToday: (habitId: string) => void;
  onTapHabit?: (habit: Habit) => void;
};

const BUCKET_ORDER: TimeOfDay[] = ['morning', 'midday', 'evening', 'anytime'];

export function DailyScheduleGrid({
  habits,
  checkedDatesByHabit,
  weekStart,
  today,
  offDayMode,
  isReadOnly = false,
  onToggleHabitToday,
  onTapHabit,
}: Props) {
  // Generate the week's date strings — Mon..Sun based on weekStart.
  const weekDates = useMemo(() => isoWeekDates(new Date(weekStart + 'T12:00:00')), [weekStart]);

  // Bucket habits by time_of_day.
  const { buckets, showHeaders } = useMemo(() => {
    const map: Record<TimeOfDay, Habit[]> = {
      morning: [], midday: [], evening: [], anytime: [],
    };
    for (const h of habits) map[h.timeOfDay ?? 'anytime'].push(h);
    const occupied = BUCKET_ORDER.filter(b => map[b].length > 0);
    return { buckets: occupied.map(b => ({ name: b, rows: map[b] })), showHeaders: occupied.length >= 2 };
  }, [habits]);

  if (buckets.length === 0) return null;

  return (
    <View style={styles.container}>
      {buckets.map(bucket => (
        <View key={bucket.name}>
          {showHeaders && <Text style={styles.bucketHeader}>{bucket.name}</Text>}
          {bucket.rows.map(habit => (
            <HabitRow
              key={`habit-${habit.id}`}
              habit={habit}
              checkedDates={checkedDatesByHabit.get(habit.id) ?? EMPTY_SET}
              weekDates={weekDates}
              today={today}
              offDayMode={offDayMode}
              isReadOnly={isReadOnly}
              onToggleToday={onToggleHabitToday}
              onTapHabit={onTapHabit}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function HabitRow({
  habit,
  checkedDates,
  weekDates,
  today,
  offDayMode,
  isReadOnly,
  onToggleToday,
  onTapHabit,
}: {
  habit: Habit;
  checkedDates: ReadonlySet<string>;
  weekDates: string[];
  today: string;
  offDayMode: 'hidden' | 'faded';
  isReadOnly: boolean;
  onToggleToday: (habitId: string) => void;
  onTapHabit?: (habit: Habit) => void;
}) {
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onTapHabit ? () => onTapHabit(habit) : undefined}
        hitSlop={4}
        style={styles.label}
      >
        <Text style={styles.labelName} numberOfLines={1}>{habit.label}</Text>
        <Text style={styles.labelCadence}>{summarizeCadence(habit)}</Text>
      </Pressable>
      <View style={styles.cells}>
        {weekDates.map(date => (
          <Cell
            key={date}
            date={date}
            state={cellStateFor(habit, date, today, checkedDates)}
            isTodayColumn={!isReadOnly && date === today}
            offDayMode={offDayMode}
            interactive={!isReadOnly && date === today}
            onTap={() => onToggleToday(habit.id)}
          />
        ))}
      </View>
    </View>
  );
}

function Cell({
  state,
  isTodayColumn,
  offDayMode,
  interactive,
  onTap,
}: {
  date: string;
  state: CellState;
  isTodayColumn: boolean;
  offDayMode: 'hidden' | 'faded';
  interactive: boolean;
  onTap: () => void;
}) {
  const cellStyle = [
    styles.cell,
    state === 'done' && styles.cellDone,
    state === 'pending' && styles.cellPending,
    state === 'upcoming' && styles.cellUpcoming,
    state === 'missed' && styles.cellMissed,
    state === 'off-day' && offDayMode === 'faded' && styles.cellOffDayFaded,
    // 'off-day' + 'hidden' → no extra style (transparent)
  ];

  const inner = (
    <View style={cellStyle}>
      {state === 'done' && <Text style={styles.checkmark}>✓</Text>}
    </View>
  );

  // Today's column gets a faint background tint that spans every row in the
  // grid (per spec §2.3). The tint lives on the wrapper, behind the cell.
  const wrapStyle = [styles.cellWrap, isTodayColumn && styles.cellWrapToday];

  if (!interactive) {
    return <View style={wrapStyle}>{inner}</View>;
  }
  // Today cell: extra hitSlop so the 29px visual gets a 44px tap zone.
  return (
    <Pressable onPress={onTap} hitSlop={8} style={wrapStyle}>
      {inner}
    </Pressable>
  );
}

const CELL_GAP = 6;
const LABEL_WIDTH = 100;

const styles = StyleSheet.create({
  container: { gap: 0 },
  bucketHeader: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 1,
    textTransform: 'lowercase',
    fontStyle: 'italic',
    marginTop: 12,
    marginBottom: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  label: {
    width: LABEL_WIDTH,
    gap: 2,
  },
  labelName: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.text,
  },
  labelCadence: {
    fontFamily: fonts.mono,
    fontSize: 8.5,
    color: colors.textDim,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  cells: {
    flex: 1,
    flexDirection: 'row',
    gap: CELL_GAP,
  },
  cellWrap: {
    flex: 1,
    aspectRatio: 1,
  },
  cellWrapToday: {
    backgroundColor: 'rgba(232, 213, 176, 0.03)',
  },
  cell: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellDone: {
    backgroundColor: 'rgba(95, 189, 128, 0.4)',
  },
  cellPending: {
    borderWidth: 1,
    borderColor: 'rgba(232, 213, 176, 0.7)',
  },
  cellUpcoming: {
    borderWidth: 1,
    borderColor: 'rgba(232, 213, 176, 0.3)',
    borderStyle: 'dashed',
  },
  cellMissed: {
    borderWidth: 1,
    borderColor: 'rgba(226, 75, 74, 0.4)',
    borderStyle: 'dashed',
  },
  cellOffDayFaded: {
    borderWidth: 1,
    borderColor: 'rgba(232, 213, 176, 0.04)',
  },
  checkmark: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: 'rgba(232, 213, 176, 0.9)',
    fontWeight: '700',
    lineHeight: 14,
  },
});
