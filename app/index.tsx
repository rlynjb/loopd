import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts } from '../src/constants/theme';
import { HomeHeader } from '../src/components/home/HomeHeader';
import { PastVlogCard } from '../src/components/home/PastVlogCard';
import { getVlogs, getEntriesByDate, archivePastDays, getDayTitle, getHabits } from '../src/services/database';
import { getTodayString, formatDate } from '../src/utils/time';
import { CATEGORIES } from '../src/constants/categories';
import { MOODS } from '../src/constants/moods';
import { Icon } from '../src/components/ui/Icon';
import type { Entry, Habit, Vlog } from '../src/types/entry';

export default function HomeScreen() {
  const router = useRouter();
  const [vlogs, setVlogs] = useState<Vlog[]>([]);
  const [vlogTitles, setVlogTitles] = useState<Record<string, string>>({});
  const [todayEntries, setTodayEntries] = useState<Entry[]>([]);
  const [todayTitle, setTodayTitle] = useState('');
  const [habits, setHabits] = useState<Habit[]>([]);
  const [weeklyHabits, setWeeklyHabits] = useState<Record<string, string[]>>({});

  const hasToday = todayEntries.length > 0;

  useFocusEffect(
    useCallback(() => {
      const today = getTodayString();
      archivePastDays(today).then(() => {
        getVlogs().then(async (v) => {
          setVlogs(v);
          const titles: Record<string, string> = {};
          for (const vlog of v) {
            titles[vlog.date] = await getDayTitle(vlog.date);
          }
          setVlogTitles(titles);
        });
      });
      getEntriesByDate(today).then(setTodayEntries);
      getDayTitle(today).then(setTodayTitle);
      getHabits().then(setHabits);

      // Load weekly habit data (Sunday–Saturday of current week)
      (async () => {
        const weekly: Record<string, string[]> = {};
        const now = new Date();
        const sunday = new Date(now);
        sunday.setDate(now.getDate() - now.getDay());
        for (let i = 0; i < 7; i++) {
          const d = new Date(sunday);
          d.setDate(sunday.getDate() + i);
          const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const dayEntries = await getEntriesByDate(dateStr);
          weekly[dateStr] = [...new Set(dayEntries.filter(e => e.type === 'habit').flatMap(e => e.habits))];
        }
        setWeeklyHabits(weekly);
      })();
    }, [])
  );

  const handleStart = () => {
    const today = getTodayString();
    router.push(`/journal/${today}`);
  };

  // Today's summary stats
  const todayClips = todayEntries.filter(e => e.type === 'video').length;
  const todayJournals = todayEntries.filter(e => e.type === 'journal').length;
  const todayHabits = [...new Set(todayEntries.filter(e => e.type === 'habit').flatMap(e => e.habits))].length;
  const todayCategories = [...new Set(todayEntries.map(e => e.category).filter(Boolean))];
  const todayMoods = todayEntries.map(e => e.mood).filter(Boolean);
  const latestMood = todayMoods.length > 0 ? todayMoods[todayMoods.length - 1] : null;
  const moodInfo = latestMood ? MOODS.find(m => m.id === latestMood) : null;

  return (
    <View style={styles.container}>

      <HomeHeader
        dayStarted={false}
        dateLabel=""
        entries={[]}
        habits={[]}
      />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>

        {/* Weekly habit streak */}
        {habits.length > 0 && Object.keys(weeklyHabits).length > 0 && (
          <View style={styles.weeklyStreak}>
            <Text style={styles.sectionLabel}>WEEKLY HABITS</Text>
            <View style={styles.weekGrid}>
              {/* Day labels */}
              <View style={styles.weekDayCol}>
                <View style={styles.weekCorner} />
                {habits.map(h => (
                  <Text key={h.id} style={styles.weekHabitLabel} numberOfLines={1}>{h.label}</Text>
                ))}
              </View>
              {/* Day columns — Sunday to Saturday of current week */}
              {Array.from({ length: 7 }).map((_, i) => {
                const today = new Date();
                const sunday = new Date(today);
                sunday.setDate(today.getDate() - today.getDay());
                const d = new Date(sunday);
                d.setDate(sunday.getDate() + i);
                const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                const checkedHabits = weeklyHabits[dateStr] ?? [];
                const dayLabel = ['S', 'M', 'T', 'W', 'T', 'F', 'S'][i];
                const todayStr = getTodayString();
                const isToday = dateStr === todayStr;
                return (
                  <View key={dateStr} style={styles.weekCol}>
                    <Text style={[styles.weekDayLabel, isToday && { color: colors.accent }]}>{dayLabel}</Text>
                    {habits.map(h => (
                      <View
                        key={h.id}
                        style={[
                          styles.weekDot,
                          {
                            backgroundColor: checkedHabits.includes(h.id) ? colors.green : 'rgba(255,255,255,0.05)',
                          },
                        ]}
                      />
                    ))}
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {!hasToday && (
          <View style={styles.cta}>
            <Pressable onPress={handleStart} style={styles.startBtn}>
              <Text style={styles.startBtnText}>Start Today's Vlog</Text>
            </Pressable>
          </View>
        )}

        {hasToday && (
          <View style={styles.todaySection}>
            <Text style={styles.sectionLabel}>TODAY</Text>
            <Pressable onPress={handleStart} style={styles.todayCard}>
              {todayTitle ? <Text style={styles.dayTitle}>{todayTitle}</Text> : null}
              <View style={styles.todayTopRow}>
                <View style={styles.todayDateGroup}>
                  {moodInfo && <View style={[styles.moodDot, { backgroundColor: moodInfo.color }]} />}
                  <Text style={styles.todayDate}>{formatDate(new Date())}</Text>
                  {moodInfo && <Text style={[styles.todayMood, { color: moodInfo.color }]}>{moodInfo.id}</Text>}
                </View>
                <Text style={styles.todayCount}>{todayEntries.length} entries</Text>
              </View>

              <View style={styles.todayStats}>
                {todayClips > 0 && <Text style={styles.todayStat}>{todayClips} clips</Text>}
                {todayJournals > 0 && <Text style={styles.todayStat}>{todayJournals} journals</Text>}
                {todayHabits > 0 && <Text style={styles.todayStat}>{todayHabits} habits</Text>}
              </View>

              {todayCategories.length > 0 && (
                <View style={styles.todayCats}>
                  {todayCategories.slice(0, 6).map(catId => {
                    const cat = CATEGORIES.find(c => c.id === catId);
                    return cat ? <Icon key={catId} name={cat.icon} size={13} color={colors.textDim} /> : null;
                  })}
                </View>
              )}
            </Pressable>

            <Pressable onPress={handleStart} style={styles.continueBtn}>
              <Text style={styles.continueBtnText}>Continue Today's Vlog</Text>
            </Pressable>
          </View>
        )}

        {vlogs.length > 0 && (
          <View style={styles.historySection}>
            <Text style={styles.sectionLabel}>PREVIOUS VLOGS</Text>
            {vlogs.map(vlog => (
              <PastVlogCard key={vlog.id} vlog={vlog} title={vlogTitles[vlog.date]} onPress={() => router.push(`/journal/${vlog.date}`)} />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingBottom: 100,
  },
  cta: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  slogan: {
    fontFamily: fonts.heading,
    fontSize: 18,
    fontWeight: '600',
    color: colors.textMuted,
    lineHeight: 27,
    marginBottom: 24,
    textAlign: 'center',
  },
  weeklyStreak: {
    marginTop: 12,
    marginBottom: 20,
  },
  weekGrid: {
    flexDirection: 'row',
    gap: 4,
  },
  weekDayCol: {
    gap: 4,
    marginRight: 4,
  },
  weekCorner: {
    height: 18,
  },
  weekHabitLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    height: 18,
    lineHeight: 18,
  },
  weekCol: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  weekDayLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    height: 18,
    lineHeight: 18,
  },
  weekDot: {
    width: 18,
    height: 18,
    borderRadius: 4,
  },
  startBtn: {
    backgroundColor: colors.accent,
    borderRadius: colors.radiusLg,
    paddingVertical: 15,
    paddingHorizontal: 40,
  },
  startBtnText: {
    fontFamily: fonts.body,
    fontSize: 15,
    fontWeight: '600',
    color: colors.bg,
  },
  todaySection: {
    marginTop: 20,
    marginBottom: 20,
  },
  dayTitle: {
    fontFamily: fonts.heading,
    fontSize: 17,
    color: colors.text,
    marginBottom: 8,
    letterSpacing: -0.3,
  },
  todayCard: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: `${colors.accent2}35`,
    borderRadius: colors.radiusLg,
    padding: 15,
    marginBottom: 12,
  },
  todayTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  todayDateGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  moodDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  todayDate: {
    fontFamily: fonts.heading,
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
  },
  todayMood: {
    fontFamily: fonts.mono,
    fontSize: 9,
    opacity: 0.8,
  },
  todayCount: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.accent2,
  },
  todayStats: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 8,
  },
  todayStat: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
  },
  todayCats: {
    flexDirection: 'row',
    gap: 4,
  },
  catEmoji: {
    fontSize: 11,
  },
  continueBtn: {
    backgroundColor: colors.accent,
    borderRadius: colors.radiusLg,
    paddingVertical: 14,
    alignItems: 'center',
  },
  continueBtnText: {
    fontFamily: fonts.body,
    fontSize: 15,
    fontWeight: '600',
    color: colors.bg,
  },
  historySection: {
    marginTop: 8,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
    marginBottom: 14,
  },
});
