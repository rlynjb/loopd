// Header for the Daily Schedule weekly grid.
// See docs/loopd-daily-schedule-grid-spec.md §2.2, §2.3.
//
// Top row: ‹ / week label / › nav controls.
// Bottom row: 100px label spacer + 7 day-column headers (letter + day-of-month).
// Today's column gets a cream-pill day-of-month badge.
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { isoWeekDates } from '../../services/habits/cadence';

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']; // Monday-first
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Props = {
  weekStart: string;       // YYYY-MM-DD, Monday
  today: string;           // YYYY-MM-DD
  isCurrentWeek: boolean;  // false → past-week view (no today-pill, › disabled)
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onJumpToToday: () => void;
};

function formatWeekLabel(weekStart: string): string {
  const start = new Date(weekStart + 'T12:00:00');
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const startLabel = `${MONTH_NAMES[start.getMonth()]} ${start.getDate()}`;
  const endLabel = sameMonth
    ? `${end.getDate()}`
    : `${MONTH_NAMES[end.getMonth()]} ${end.getDate()}`;
  return `${startLabel} — ${endLabel}, ${end.getFullYear()}`;
}

export function DailyScheduleHeader({
  weekStart,
  today,
  isCurrentWeek,
  onPrevWeek,
  onNextWeek,
  onJumpToToday,
}: Props) {
  const dates = isoWeekDates(new Date(weekStart + 'T12:00:00'));
  const label = formatWeekLabel(weekStart);

  return (
    <View>
      {/* Top row — week-nav controls */}
      <View style={styles.navRow}>
        <Pressable onPress={onPrevWeek} hitSlop={8} style={styles.navBtn}>
          <Icon name="chevronLeft" size={16} color={colors.textMuted} />
        </Pressable>
        <Pressable onPress={onJumpToToday} hitSlop={4} style={styles.labelBtn}>
          <Text style={styles.weekLabel}>{label}</Text>
        </Pressable>
        <Pressable
          onPress={isCurrentWeek ? undefined : onNextWeek}
          hitSlop={8}
          style={[styles.navBtn, isCurrentWeek && styles.navBtnDisabled]}
        >
          <View style={styles.chevronRight}>
            <Icon
              name="chevronLeft"
              size={16}
              color={isCurrentWeek ? colors.textDimmer : colors.textMuted}
            />
          </View>
        </Pressable>
      </View>

      {/* Day-column headers */}
      <View style={styles.headerRow}>
        <View style={styles.labelSpacer} />
        <View style={styles.headerCells}>
          {dates.map((date, i) => {
            const isToday = isCurrentWeek && date === today;
            const dayOfMonth = new Date(date + 'T12:00:00').getDate();
            return (
              <View key={date} style={[styles.headerCell, isToday && styles.headerCellToday]}>
                <Text style={styles.headerLetter}>{DAY_LETTERS[i]}</Text>
                {isToday ? (
                  <View style={styles.todayPill}>
                    <Text style={styles.todayPillText}>{dayOfMonth}</Text>
                  </View>
                ) : (
                  <Text style={styles.headerNumber}>{dayOfMonth}</Text>
                )}
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const LABEL_WIDTH = 100;
const CELL_GAP = 6;
const TODAY_PILL_SIZE = 22;

const styles = StyleSheet.create({
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
  },
  navBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  navBtnDisabled: {
    opacity: 0.3,
  },
  chevronRight: {
    transform: [{ rotate: '180deg' }],
  },
  labelBtn: {
    flex: 1,
    alignItems: 'center',
  },
  weekLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
    letterSpacing: 0.4,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingTop: 6,
    paddingBottom: 4,
  },
  labelSpacer: {
    width: LABEL_WIDTH,
  },
  headerCells: {
    flex: 1,
    flexDirection: 'row',
    gap: CELL_GAP,
  },
  headerCell: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: 4,
  },
  headerCellToday: {
    backgroundColor: 'rgba(232, 213, 176, 0.03)',
  },
  headerLetter: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 0.5,
  },
  headerNumber: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
  },
  todayPill: {
    width: TODAY_PILL_SIZE,
    height: TODAY_PILL_SIZE,
    borderRadius: TODAY_PILL_SIZE / 2,
    backgroundColor: 'rgba(232, 213, 176, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayPillText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: '700',
    color: colors.bg,
  },
});
