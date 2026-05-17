import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { subscribeToMigration, type MigrationStatus } from '../../services/clipMigration';
import type { Habit, Entry } from '../../types/entry';

type Props = {
  dayStarted: boolean;
  dateLabel: string;
  entries: Entry[];
  habits: Habit[];
  onBack?: () => void;
};

export function HomeHeader({ dayStarted, dateLabel, onBack }: Props) {
  const router = useRouter();

  // Subscribe to in-flight clip migrations so the status pill ticks live.
  const [migration, setMigration] = useState<MigrationStatus | null>(null);
  useEffect(() => subscribeToMigration(s => setMigration(s.running ? s : null)), []);

  return (
    <View style={styles.container}>
      {onBack && (
        <Pressable onPress={onBack} style={styles.backBtn} hitSlop={12}>
          <Icon name="dashboard" size={20} color={colors.textMuted} />
        </Pressable>
      )}
      <View style={styles.logoBlock}>
        <Text style={styles.logo}>buffr</Text>
        <Text style={styles.slogan}>Plan. Capture. Reflect. Think.</Text>
      </View>
      <View style={styles.headerRight}>
        <Pressable onPress={() => router.push('/settings')} hitSlop={8} style={styles.headerIconBtn}>
          <Icon name="settings" size={18} color={colors.textDim} />
        </Pressable>
      </View>

      {migration && (
        <View style={styles.syncStatus}>
          <Text style={[styles.syncStatusText, { color: colors.teal }]}>
            Optimizing clips… {migration.done + migration.failed}/{migration.total}
          </Text>
        </View>
      )}

      {dayStarted && (
        <Text style={styles.dateText}>{dateLabel}</Text>
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
    left: 12,
    top: 54,
    padding: 12,
    zIndex: 2,
  },
  headerRight: {
    position: 'absolute',
    right: 12,
    top: 54,
    flexDirection: 'row',
    gap: 4,
    zIndex: 2,
  },
  headerIconBtn: {
    padding: 10,
  },
  syncStatus: {
    alignItems: 'center',
    marginTop: 6,
    gap: 2,
  },
  syncStatusText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.green,
  },
  syncTimeText: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: colors.textDimmer,
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
  dateText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
    textAlign: 'center',
    marginTop: 6,
  },
});
