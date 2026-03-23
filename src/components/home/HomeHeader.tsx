import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import type { Habit, Entry } from '../../types/entry';

type Props = {
  dayStarted: boolean;
  dateLabel: string;
  entries: Entry[];
  habits: Habit[];
  onBack?: () => void;
};

export function HomeHeader({ dayStarted, dateLabel, entries, habits, onBack }: Props) {
  const habitsChecked = [
    ...new Set(
      entries.filter(e => e.type === 'habit').flatMap(e => e.habits)
    ),
  ];
  const streakCount = habitsChecked.length;
  const totalHabits = habits.length;

  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <View style={styles.leftGroup}>
          {dayStarted && onBack && (
            <Pressable onPress={onBack} style={styles.backBtn}>
              <Text style={styles.backText}>{'<-'}</Text>
            </Pressable>
          )}
          <Text style={styles.logo}>loopd</Text>
          <Text style={styles.slogan}>Plan. Capture. Reflect. Think.</Text>
        </View>
      </View>

      {dayStarted && (
        <View style={styles.subRow}>
          <Text style={styles.dateText}>{dateLabel}</Text>
          <View style={styles.streakContainer}>
            <View style={styles.dots}>
              {habits.map(h => (
                <View
                  key={h.id}
                  style={[
                    styles.dot,
                    {
                      backgroundColor: habitsChecked.includes(h.id)
                        ? colors.purple
                        : 'rgba(255,255,255,0.08)',
                    },
                  ]}
                />
              ))}
            </View>
            <Text
              style={[
                styles.streakText,
                { color: streakCount > 0 ? colors.purple : colors.textDim },
              ]}
            >
              {streakCount}/{totalHabits}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 12,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  leftGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  backBtn: {
    padding: 4,
  },
  backText: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.textDim,
  },
  logo: {
    fontFamily: fonts.heading,
    fontSize: 24,
    fontWeight: '800',
    color: colors.teal,
  },
  slogan: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: colors.textDim,
    letterSpacing: 0.5,
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  dateText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
  },
  streakContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  dots: {
    flexDirection: 'row',
    gap: 3,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  streakText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.4,
  },
});
