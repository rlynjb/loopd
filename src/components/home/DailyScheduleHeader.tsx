// Header for the Daily Schedule weekly grid.
// See docs/buffr-daily-schedule-grid-spec.md §2.3.
//
// 100px label spacer + 7 day-column headers (letter + day-of-month).
// Today's column gets a cream-pill day-of-month badge. Locked to the
// current week — week-nav controls were dropped 2026-05-10 in favor of
// the simpler one-week-only view.
import { View, Text, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { isoWeekDates } from '../../services/habits/cadence';

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']; // Monday-first

type Props = {
  weekStart: string;       // YYYY-MM-DD, Monday of the current week
  today: string;           // YYYY-MM-DD
};

export function DailyScheduleHeader({ weekStart, today }: Props) {
  const dates = isoWeekDates(new Date(weekStart + 'T12:00:00'));

  return (
    <View>
      <View style={styles.headerRow}>
        <View style={styles.labelSpacer} />
        <View style={styles.headerCells}>
          {dates.map((date, i) => {
            const isToday = date === today;
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
