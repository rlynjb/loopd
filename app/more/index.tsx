import { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../../src/constants/theme';
import { Icon, type IconName } from '../../src/components/ui/Icon';
import { HomeHeader } from '../../src/components/home/HomeHeader';
import { getDatabase, getHabits, getThreads } from '../../src/services/database';
import { isDueOn } from '../../src/services/habits/cadence';
import { computeStaleness } from '../../src/services/threads/staleness';
import { getLastMentionByThread } from '../../src/services/database';
import { getTodayString } from '../../src/utils/time';

type HubStats = {
  nutritionWeek: number;
  habitsActive: number;
  habitsDueToday: number;
  threadsActive: number;
  threadsStale: number;
};

const EMPTY_STATS: HubStats = {
  nutritionWeek: 0,
  habitsActive: 0,
  habitsDueToday: 0,
  threadsActive: 0,
  threadsStale: 0,
};

export default function MoreHub() {
  const router = useRouter();
  const [stats, setStats] = useState<HubStats>(EMPTY_STATS);

  const load = useCallback(async () => {
    const db = await getDatabase();
    const today = getTodayString();
    const todayDate = new Date(today + 'T12:00:00');

    // Nutrition this week — count of rows in the last 7 calendar days.
    const cutoff = (() => {
      const d = new Date(todayDate);
      d.setDate(d.getDate() - 6);
      return d.toISOString().slice(0, 10);
    })();
    const nutRow = await db.getFirstAsync<{ c: number }>(
      `SELECT COUNT(*) AS c FROM nutrition WHERE entry_date >= ?`, [cutoff]
    );

    const habits = await getHabits();
    let dueCount = 0;
    for (const h of habits) {
      if ((h.cadenceType ?? 'daily') === 'n_per_week') {
        // Count as due — don't dive into history just for the badge.
        dueCount++;
      } else if (isDueOn(h, todayDate)) {
        dueCount++;
      }
    }

    const threads = await getThreads(false);
    const lastMention = await getLastMentionByThread();
    let staleCount = 0;
    for (const t of threads) {
      const last = lastMention.get(t.id) ?? null;
      const s = computeStaleness(t, last, todayDate);
      if (s === 'stale' || s === 'cold') staleCount++;
    }

    setStats({
      nutritionWeek: nutRow?.c ?? 0,
      habitsActive: habits.length,
      habitsDueToday: dueCount,
      threadsActive: threads.length,
      threadsStale: staleCount,
    });
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <View style={styles.container}>
      <HomeHeader dayStarted={false} dateLabel="" entries={[]} habits={[]} />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <HubLink
          icon="utensils"
          label="nutrition"
          stat={`${stats.nutritionWeek} ${stats.nutritionWeek === 1 ? 'entry' : 'entries'} this week`}
          onPress={() => router.push('/more/nutrition')}
        />
        <HubLink
          icon="dumbbell"
          label="habits"
          stat={
            stats.habitsActive === 0
              ? 'no habits yet'
              : `${stats.habitsActive} active${stats.habitsDueToday > 0 ? ` · ${stats.habitsDueToday} due today` : ''}`
          }
          onPress={() => router.push('/more/habits')}
        />
        <HubLink
          icon="gitBranch"
          label="threads"
          stat={
            stats.threadsActive === 0
              ? 'no threads yet'
              : `${stats.threadsActive} active${stats.threadsStale > 0 ? ` · ${stats.threadsStale} going stale` : ''}`
          }
          onPress={() => router.push('/more/threads')}
        />
      </ScrollView>
    </View>
  );
}

function HubLink({ icon, label, stat, onPress }: {
  icon: IconName;
  label: string;
  stat?: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <Icon name={icon} size={18} color={colors.textMuted} />
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel}>{label}</Text>
        {stat && <Text style={styles.rowStat}>{stat}</Text>}
      </View>
      <Icon name="arrowRight" size={14} color={colors.textDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  scrollContent: {
    paddingTop: 12,
    paddingBottom: GLOBAL_NAV_HEIGHT + 40,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  rowBody: { flex: 1, gap: 2 },
  rowLabel: { fontFamily: fonts.body, fontSize: 15, color: colors.text },
  rowStat: { fontFamily: fonts.mono, fontSize: 10, color: colors.textDim },
});
