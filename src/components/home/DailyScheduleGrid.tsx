// Daily Schedule weekly grid — 7-column weekday layout for habits AND threads.
// See docs/loopd-daily-schedule-grid-spec.md (with the §13 deviation: per
// user direction, threads share the grid bucketed by time_of_day instead of
// rendering as a separate strip below).
//
// Receives the visible week's anchor (Monday) plus habits + threads + their
// check-in / touch maps; renders mixed rows bucketed by time_of_day. Habit
// rows use cellStateFor() (cadence-aware); thread rows use the simpler
// cellStateForThread() (touched/not-touched only).
//
// Tap is enabled only on today's pending/done cells. Tap-on-name routes
// to the appropriate edit/detail surface.
import { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import type { Habit, TimeOfDay } from '../../types/entry';
import type { Thread, ThreadCard } from '../../types/thread';
import { isoWeekDates, summarizeCadence } from '../../services/habits/cadence';
import { cellStateFor, cellStateForThread, type CellState } from './cellState';

type Props = {
  habits: Habit[];
  threads: ThreadCard[];
  checkedDatesByHabit: Map<string, Set<string>>;
  weekStart: string;            // YYYY-MM-DD, Monday of the visible week
  today: string;                // YYYY-MM-DD
  offDayMode: 'hidden' | 'faded';
  isReadOnly?: boolean;         // true for past-week views
  onToggleHabitToday: (habitId: string) => void;
  onToggleThreadToday: (threadId: string, slug: string) => void;
  onTapHabit?: (habit: Habit) => void;
  onTapThread?: (thread: Thread) => void;
};

const BUCKET_ORDER: TimeOfDay[] = ['morning', 'midday', 'evening', 'anytime'];

type Row =
  | { kind: 'habit'; habit: Habit }
  | { kind: 'thread'; card: ThreadCard };

export function DailyScheduleGrid({
  habits,
  threads,
  checkedDatesByHabit,
  weekStart,
  today,
  offDayMode,
  isReadOnly = false,
  onToggleHabitToday,
  onToggleThreadToday,
  onTapHabit,
  onTapThread,
}: Props) {
  // Generate the week's date strings — Mon..Sun based on weekStart.
  const weekDates = useMemo(() => isoWeekDates(new Date(weekStart + 'T12:00:00')), [weekStart]);

  // Bucket habits + threads by time_of_day (habits first within each bucket
  // — matches the previous combined-strip ordering convention).
  const { buckets, showHeaders } = useMemo(() => {
    const map: Record<TimeOfDay, Row[]> = {
      morning: [], midday: [], evening: [], anytime: [],
    };
    for (const h of habits) map[h.timeOfDay ?? 'anytime'].push({ kind: 'habit', habit: h });
    for (const c of threads) map[c.thread.timeOfDay ?? 'anytime'].push({ kind: 'thread', card: c });
    const occupied = BUCKET_ORDER.filter(b => map[b].length > 0);
    return { buckets: occupied.map(b => ({ name: b, rows: map[b] })), showHeaders: occupied.length >= 2 };
  }, [habits, threads]);

  if (buckets.length === 0) return null;

  return (
    <View style={styles.container}>
      {buckets.map(bucket => (
        <View key={bucket.name}>
          {showHeaders && <Text style={styles.bucketHeader}>{bucket.name}</Text>}
          {bucket.rows.map(row => {
            if (row.kind === 'habit') {
              return (
                <HabitRow
                  key={`habit-${row.habit.id}`}
                  habit={row.habit}
                  checkedDates={checkedDatesByHabit.get(row.habit.id) ?? EMPTY_SET}
                  weekDates={weekDates}
                  today={today}
                  offDayMode={offDayMode}
                  isReadOnly={isReadOnly}
                  onToggleToday={onToggleHabitToday}
                  onTapHabit={onTapHabit}
                />
              );
            }
            return (
              <ThreadRow
                key={`thread-${row.card.thread.id}`}
                card={row.card}
                weekDates={weekDates}
                today={today}
                offDayMode={offDayMode}
                isReadOnly={isReadOnly}
                onToggleToday={onToggleThreadToday}
                onTapThread={onTapThread}
              />
            );
          })}
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

function ThreadRow({
  card,
  weekDates,
  today,
  offDayMode,
  isReadOnly,
  onToggleToday,
  onTapThread,
}: {
  card: ThreadCard;
  weekDates: string[];
  today: string;
  offDayMode: 'hidden' | 'faded';
  isReadOnly: boolean;
  onToggleToday: (threadId: string, slug: string) => void;
  onTapThread?: (thread: Thread) => void;
}) {
  const { thread } = card;
  const touched = card.activeDates ?? EMPTY_SET;
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onTapThread ? () => onTapThread(thread) : undefined}
        hitSlop={4}
        style={styles.label}
      >
        <Text style={styles.labelName} numberOfLines={1}>{`#${thread.slug}`}</Text>
        <Text style={styles.labelCadence}>
          {thread.targetCadenceDays ? `every ${thread.targetCadenceDays}d` : 'thread'}
        </Text>
      </Pressable>
      <View style={styles.cells}>
        {weekDates.map(date => (
          <Cell
            key={date}
            date={date}
            state={cellStateForThread(touched, date, today)}
            isTodayColumn={!isReadOnly && date === today}
            offDayMode={offDayMode}
            interactive={!isReadOnly && date === today}
            onTap={() => onToggleToday(thread.id, thread.slug)}
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
