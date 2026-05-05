import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts } from '../src/constants/theme';
import { HomeHeader } from '../src/components/home/HomeHeader';
import { PastVlogCard } from '../src/components/home/PastVlogCard';
import { DailyScheduleGrid } from '../src/components/home/DailyScheduleGrid';
import { DailyScheduleHeader } from '../src/components/home/DailyScheduleHeader';
import { OffDayToggle, useOffDayMode } from '../src/components/home/OffDayToggle';
import { DailyScheduleLegend } from '../src/components/home/DailyScheduleLegend';
import { startOfISOWeekStr } from '../src/services/habits/cadence';
import { SmartTodoList } from '../src/components/home/SmartTodoList';
import {
  getVlogs, getEntriesByDate, archivePastDays, getDayTitle, getHabits, getAllEntries,
  getAllTodoMetas, insertEntry, updateEntry,
} from '../src/services/database';
import { getThreadCards } from '../src/services/threads/getThreadCards';
import { toggleThreadTouchToday } from '../src/services/threads/touch';
import { getTodayString, formatDate } from '../src/utils/time';
import { generateId } from '../src/utils/id';
import type { Entry, Habit, Vlog } from '../src/types/entry';
import type { TodoMeta } from '../src/types/todoMeta';
import type { ThreadCard } from '../src/types/thread';

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
  const [todoMetas, setTodoMetas] = useState<Map<string, TodoMeta>>(new Map());
  const [threadCards, setThreadCards] = useState<ThreadCard[]>([]);

  const today = getTodayString();

  const loadAll = useCallback(async () => {
    await archivePastDays(today);
    const [entries, h, v, allMetas, cards] = await Promise.all([
      getAllEntries(),
      getHabits(),
      getVlogs(),
      getAllTodoMetas(),
      getThreadCards(),
    ]);
    setAllEntries(entries);
    setHabits(h);
    setVlogs(v);
    setTodoMetas(new Map(allMetas.map(m => [m.todoId, m])));
    setThreadCards(cards);

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

  // Sum every "<number> kcal" mention across today's entry text. Commas are
  // treated as thousands separators (1,200 kcal → 1200).
  const totalKcal = useMemo(() => {
    const re = /(\d+(?:[.,]\d+)?)\s*kcal\b/gi;
    let total = 0;
    for (const e of todayEntries) {
      if (!e.text) continue;
      for (const m of e.text.matchAll(re)) {
        const n = parseFloat(m[1].replace(/,/g, ''));
        if (Number.isFinite(n)) total += n;
      }
    }
    return total;
  }, [todayEntries]);

  // Map habitId -> set of YYYY-MM-DD where it was logged across ALL entries.
  // No cutoff: past-week navigation can scroll arbitrarily far back, and the
  // DailyScheduleGrid only renders the visible week's 7 cells anyway, so the
  // memory cost is bounded by total entries (small).
  const checkedDatesByHabit = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const h of habits) map.set(h.id, new Set());
    for (const entry of allEntries) {
      for (const hid of entry.habits) {
        map.get(hid)?.add(entry.date);
      }
    }
    return map;
  }, [allEntries, habits]);

  // Week-nav state — driven by ?week=YYYY-MM-DD URL param.
  // Validation: must be a Monday and not > current week's Monday.
  const params = useLocalSearchParams<{ week?: string }>();
  const currentWeekStart = useMemo(() => startOfISOWeekStr(today), [today]);
  const weekStart = useMemo(() => {
    const raw = params.week;
    if (!raw) return currentWeekStart;
    // Validate: must look like YYYY-MM-DD, must be a Monday, must not be future.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return currentWeekStart;
    if (startOfISOWeekStr(raw) !== raw) return currentWeekStart; // not a Monday
    if (raw > currentWeekStart) return currentWeekStart;
    return raw;
  }, [params.week, currentWeekStart]);
  const isCurrentWeek = weekStart === currentWeekStart;

  const onPrevWeek = useCallback(() => {
    const d = new Date(weekStart + 'T12:00:00');
    d.setDate(d.getDate() - 7);
    router.setParams({ week: d.toISOString().slice(0, 10) });
  }, [weekStart, router]);
  const onNextWeek = useCallback(() => {
    if (isCurrentWeek) return;
    const d = new Date(weekStart + 'T12:00:00');
    d.setDate(d.getDate() + 7);
    const next = d.toISOString().slice(0, 10);
    if (next >= currentWeekStart) {
      router.setParams({ week: undefined });
    } else {
      router.setParams({ week: next });
    }
  }, [weekStart, currentWeekStart, isCurrentWeek, router]);
  const onJumpToToday = useCallback(() => {
    router.setParams({ week: undefined });
  }, [router]);

  const [offDayMode, setOffDayMode] = useOffDayMode();

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
          <View style={[styles.section, styles.sectionFirst]}>
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
            {totalKcal > 0 && (
              <View style={styles.statRow}>
                <View style={styles.statItem}>
                  <Text style={styles.statLabel}>total kcal</Text>
                  <Text style={styles.statValue}>{Math.round(totalKcal).toLocaleString()}</Text>
                </View>
              </View>
            )}
          </View>
        )}

        {/* DAILY SCHEDULE — habits weekly grid (new) + threads strip (kept).
            Per docs/loopd-daily-schedule-grid-spec.md: habits get the 7-column
            weekday grid; threads keep their 14-cell trailing strip below.
            Mixed visual language is the v1 trade-off (spec §13 option a). */}
        {(habits.length > 0 || threadCards.length > 0) && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionLabel}>DAILY SCHEDULE</Text>
              <Pressable onPress={() => router.push('/more')} hitSlop={6}>
                <Text style={styles.sectionLink}>manage →</Text>
              </Pressable>
            </View>

            <DailyScheduleHeader
              weekStart={weekStart}
              today={today}
              isCurrentWeek={isCurrentWeek}
              onPrevWeek={onPrevWeek}
              onNextWeek={onNextWeek}
              onJumpToToday={onJumpToToday}
            />
            <DailyScheduleGrid
              habits={habits}
              threads={threadCards}
              checkedDatesByHabit={checkedDatesByHabit}
              weekStart={weekStart}
              today={today}
              offDayMode={offDayMode}
              isReadOnly={!isCurrentWeek}
              onToggleHabitToday={toggleHabitToday}
              onToggleThreadToday={async (threadId, slug) => {
                await toggleThreadTouchToday(threadId, slug, today);
                loadAll();
              }}
              onTapHabit={() => router.push('/more/habits')}
              onTapThread={thread => router.push(`/threads/${thread.id}`)}
            />
            <OffDayToggle mode={offDayMode} onChange={setOffDayMode} />
            <DailyScheduleLegend />
          </View>
        )}

        {/* Smart todos */}
        <View style={styles.section}>
          <SmartTodoList entries={allEntries} today={today} onChanged={loadAll} metas={todoMetas} />
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
  sectionFirst: {
    // First section after the greeting/date block — drop the top divider so
    // the title flows directly into TODAY'S VLOG without a visible line.
    borderTopWidth: 0,
    paddingTop: 8,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
    marginBottom: 14,
  },
  statRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 24,
    marginTop: 12,
  },
  statItem: {
    alignItems: 'flex-start',
  },
  statLabel: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textDim,
    letterSpacing: 0.5,
  },
  statValue: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.text,
    letterSpacing: -0.2,
    marginTop: 4,
  },
  // Anchors + Threads (folded in from former Today page)
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sectionLink: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.accent,
  },
});
