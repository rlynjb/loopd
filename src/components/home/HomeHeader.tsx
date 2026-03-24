import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import type { Habit, Entry } from '../../types/entry';

type Props = {
  dayStarted: boolean;
  dateLabel: string;
  entries: Entry[];
  habits: Habit[];
  onBack?: () => void;
  onSettings?: () => void;
};

export function HomeHeader({ dayStarted, dateLabel, entries, habits, onBack, onSettings }: Props) {
  const habitsChecked = [
    ...new Set(
      entries.filter(e => e.type === 'habit').flatMap(e => e.habits)
    ),
  ];
  const streakCount = habitsChecked.length;
  const totalHabits = habits.length;

  return (
    <View style={styles.container}>
      {dayStarted && onBack && (
        <Pressable onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backText}>{'<-'}</Text>
        </Pressable>
      )}
      <View style={styles.logoBlock}>
        <Text style={styles.logo}>loopd</Text>
        <Text style={styles.slogan}>Plan. Capture. Reflect. Think.</Text>
      </View>
      {onSettings && (
        <Pressable onPress={onSettings} style={styles.settingsBtn}>
          <Icon name="target" size={18} color={colors.textDim} />
        </Pressable>
      )}

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
                        ? colors.green
                        : 'rgba(255,255,255,0.08)',
                    },
                  ]}
                />
              ))}
            </View>
            <Text
              style={[
                styles.streakText,
                { color: streakCount > 0 ? colors.green : colors.textDim },
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
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  backBtn: {
    position: 'absolute',
    left: 20,
    top: 60,
    padding: 4,
    zIndex: 2,
  },
  settingsBtn: {
    position: 'absolute',
    right: 20,
    top: 60,
    padding: 4,
    zIndex: 2,
  },
  backText: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.textDim,
  },
  logoBlock: {
    alignItems: 'center',
  },
  logo: {
    fontFamily: fonts.heading,
    fontSize: 24,
    color: colors.accent,
    letterSpacing: -0.4,
  },
  slogan: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 0.3,
    fontStyle: 'italic',
    marginTop: 2,
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
