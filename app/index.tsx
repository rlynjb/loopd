import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts } from '../src/constants/theme';
import { GlowOrb } from '../src/components/ui/GlowOrb';
import { HomeHeader } from '../src/components/home/HomeHeader';
import { PastVlogCard } from '../src/components/home/PastVlogCard';
import { getVlogs, getEntriesByDate, archivePastDays } from '../src/services/database';
import { getTodayString, formatDate } from '../src/utils/time';
import { CATEGORIES } from '../src/constants/categories';
import { MOODS } from '../src/constants/moods';
import { Icon } from '../src/components/ui/Icon';
import type { Entry, Vlog } from '../src/types/entry';

export default function HomeScreen() {
  const router = useRouter();
  const [vlogs, setVlogs] = useState<Vlog[]>([]);
  const [todayEntries, setTodayEntries] = useState<Entry[]>([]);

  const hasToday = todayEntries.length > 0;

  useFocusEffect(
    useCallback(() => {
      const today = getTodayString();
      // Archive any past days that haven't been recorded as vlogs yet
      archivePastDays(today).then(() => {
        getVlogs().then(setVlogs);
      });
      getEntriesByDate(today).then(setTodayEntries);
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
  const todayMoments = todayEntries.filter(e => e.type === 'moment').length;
  const todayCategories = [...new Set(todayEntries.map(e => e.category).filter(Boolean))];
  const todayMoods = todayEntries.map(e => e.mood).filter(Boolean);
  const latestMood = todayMoods.length > 0 ? todayMoods[todayMoods.length - 1] : null;
  const moodInfo = latestMood ? MOODS.find(m => m.id === latestMood) : null;

  return (
    <View style={styles.container}>
      <GlowOrb color={colors.accent2} size={300} top={50} left={-80} opacity={0.05} />
      <GlowOrb color={colors.green} size={250} top={300} left={250} opacity={0.04} />
      <GlowOrb color={colors.amber} size={200} top={550} left={-40} opacity={0.03} />

      <HomeHeader
        dayStarted={false}
        dateLabel=""
        entries={[]}
        habits={[]}
      />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
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
                {todayMoments > 0 && <Text style={styles.todayStat}>{todayMoments} moments</Text>}
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
              <PastVlogCard key={vlog.id} vlog={vlog} onPress={() => router.push(`/journal/${vlog.date}`)} />
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
