import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts } from '../src/constants/theme';
import { HomeHeader } from '../src/components/home/HomeHeader';
import { PastVlogCard } from '../src/components/home/PastVlogCard';
import { HabitHeatmapRow } from '../src/components/home/HabitHeatmapRow';
import { SmartTodoList } from '../src/components/home/SmartTodoList';
import {
  getVlogs, getEntriesByDate, archivePastDays, getDayTitle, getHabits, getAllEntries,
  insertEntry, updateEntry,
} from '../src/services/database';
import { getTodayString, formatDate } from '../src/utils/time';
import { generateId } from '../src/utils/id';
import type { Entry, Habit, Vlog } from '../src/types/entry';

const HEATMAP_DAYS = 14;

function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 5) return 'Still up?';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}

export default function HomeScreen() {
  const router = useRouter();

  const [allEntries, setAllEntries] = useState<Entry[]>([]);
  const [vlogs, setVlogs] = useState<Vlog[]>([]);
  const [vlogTitles, setVlogTitles] = useState<Record<string, string>>({});
  const [vlogPreviews, setVlogPreviews] = useState<Record<string, string>>({});
  const [todayTitle, setTodayTitle] = useState('');
  const [habits, setHabits] = useState<Habit[]>([]);

  const today = getTodayString();

  const loadAll = useCallback(async () => {
    await archivePastDays(today);
    const [entries, h, v] = await Promise.all([
      getAllEntries(),
      getHabits(),
      getVlogs(),
    ]);
    setAllEntries(entries);
    setHabits(h);
    setVlogs(v);

    const titles: Record<string, string> = {};
    const previews: Record<string, string> = {};
    for (const vlog of v) {
      titles[vlog.date] = await getDayTitle(vlog.date);
      const dayEntries = await getEntriesByDate(vlog.date);
      const firstText = dayEntries.find(e => e.text)?.text;
      if (firstText) {
        const sentences = firstText.split(/[.!?]+/).filter(Boolean).slice(0, 2).join('. ').trim();
        previews[vlog.date] = sentences.length > 100 ? sentences.slice(0, 100) + '...' : sentences + (firstText.includes('.') ? '.' : '');
      }
    }
    setVlogTitles(titles);
    setVlogPreviews(previews);
    setTodayTitle(await getDayTitle(today));
  }, [today]);

  useFocusEffect(
    useCallback(() => {
      loadAll();
    }, [loadAll])
  );

  const todayEntries = useMemo(
    () => allEntries.filter(e => e.date === today),
    [allEntries, today],
  );
  const hasToday = todayEntries.length > 0;

  const todayPreview = useMemo(() => {
    const firstText = todayEntries.find(e => e.text)?.text;
    if (!firstText) return undefined;
    const sentences = firstText.split(/[.!?]+/).filter(Boolean).slice(0, 2).join('. ').trim();
    return sentences.length > 100
      ? sentences.slice(0, 100) + '...'
      : sentences + (firstText.includes('.') ? '.' : '');
  }, [todayEntries]);

  // Map habitId -> set of YYYY-MM-DD where it was logged (last 28 days).
  const checkedDatesByHabit = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const h of habits) map.set(h.id, new Set());
    const cutoff = (() => {
      const d = new Date(today + 'T12:00:00');
      d.setDate(d.getDate() - HEATMAP_DAYS);
      return d.toISOString().slice(0, 10);
    })();
    for (const entry of allEntries) {
      if (entry.date < cutoff) continue;
      for (const hid of entry.habits) {
        map.get(hid)?.add(entry.date);
      }
    }
    return map;
  }, [allEntries, habits, today]);

  const toggleHabitToday = useCallback(async (habitId: string) => {
    const holder = todayEntries.find(e => e.habits.includes(habitId));
    if (holder) {
      await updateEntry({ ...holder, habits: holder.habits.filter(h => h !== habitId) });
    } else {
      // Prefer appending to an existing habit-only entry; create one if none.
      const habitEntry = todayEntries.find(e => !e.text && e.clips.length === 0 && (e.todos?.length ?? 0) === 0);
      if (habitEntry) {
        await updateEntry({ ...habitEntry, habits: [...habitEntry.habits, habitId] });
      } else {
        await insertEntry({
          id: generateId('entry'),
          date: today,
          text: null,
          habits: [habitId],
          todos: [],
          clipUri: null,
          clipDurationMs: null,
          clips: [],
          createdAt: new Date().toISOString(),
        });
      }
    }
    loadAll();
  }, [todayEntries, today, loadAll]);

  const handleStart = useCallback(() => {
    router.push(`/journal/${today}`);
  }, [router, today]);

  return (
    <View style={styles.container}>
      <HomeHeader dayStarted={false} dateLabel="" entries={[]} habits={[]} />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {/* Greeting */}
        <View style={styles.titleBlock}>
          <Text style={styles.greeting}>{greeting()}</Text>
          <Text style={styles.todayDate}>{formatDate(new Date())}</Text>
        </View>

        {/* Start CTA when today has nothing */}
        {!hasToday && (
          <View style={styles.cta}>
            <Pressable onPress={handleStart} style={styles.startBtn}>
              <Text style={styles.startBtnText}>Start Today's Vlog</Text>
            </Pressable>
          </View>
        )}

        {/* Today's vlog — same card style as past vlogs */}
        {hasToday && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>TODAY'S VLOG</Text>
            <PastVlogCard
              vlog={{
                id: `today-${today}`,
                date: today,
                clipCount: 0,
                habitCount: 0,
                caption: null,
                durationSeconds: 0,
                exportUri: null,
                createdAt: '',
              }}
              title={todayTitle}
              preview={todayPreview}
              onPress={() => router.push(`/journal/${today}`)}
            />
          </View>
        )}

        {/* Habits */}
        {habits.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>HABITS</Text>
            {habits.map(h => (
              <HabitHeatmapRow
                key={h.id}
                habit={h}
                checkedDates={checkedDatesByHabit.get(h.id) ?? new Set()}
                today={today}
                onToggleToday={() => toggleHabitToday(h.id)}
              />
            ))}
          </View>
        )}

        {/* Smart todos */}
        <View style={styles.section}>
          <SmartTodoList entries={allEntries} today={today} onChanged={loadAll} />
        </View>

        {/* Past vlogs */}
        {vlogs.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>PREVIOUS VLOGS</Text>
            {vlogs.map(vlog => (
              <PastVlogCard
                key={vlog.id}
                vlog={vlog}
                title={vlogTitles[vlog.date]}
                preview={vlogPreviews[vlog.date]}
                onPress={() => router.push(`/journal/${vlog.date}`)}
              />
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
    paddingHorizontal: 20,
    paddingBottom: 100,
  },
  titleBlock: {
    paddingTop: 16,
    paddingBottom: 16,
    marginBottom: 8,
  },
  greeting: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.text,
    letterSpacing: -0.3,
  },
  todayDate: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
    marginTop: 4,
  },
  cta: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  startBtn: {
    backgroundColor: colors.accent,
    paddingVertical: 14,
    paddingHorizontal: 36,
  },
  startBtnText: {
    fontFamily: fonts.body,
    fontSize: 15,
    fontWeight: '600',
    color: colors.bg,
  },
  section: {
    paddingTop: 24,
    paddingBottom: 20,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
    marginBottom: 14,
  },
});
