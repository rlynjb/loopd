import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts } from '../src/constants/theme';
import { Icon } from '../src/components/ui/Icon';
import { HomeHeader } from '../src/components/home/HomeHeader';
import { PastVlogCard } from '../src/components/home/PastVlogCard';
import { DailyScheduleGrid } from '../src/components/home/DailyScheduleGrid';
import { DailyScheduleHeader } from '../src/components/home/DailyScheduleHeader';
import { OffDayToggle, useOffDayMode } from '../src/components/home/OffDayToggle';
import { DailyScheduleLegend } from '../src/components/home/DailyScheduleLegend';
import { startOfISOWeekStr } from '../src/services/habits/cadence';
import { SmartTodoList } from '../src/components/home/SmartTodoList';
import {
  archivePastDays, getDayTitle, getHabits, getAllEntries,
  getAllTodoMetas, insertEntry, updateEntry,
} from '../src/services/database';
import { getTodayString, formatDate } from '../src/utils/time';
import { generateId } from '../src/utils/id';
import type { Entry, Habit } from '../src/types/entry';
import type { TodoMeta } from '../src/types/todoMeta';

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
  const [todayTitle, setTodayTitle] = useState('');
  const [habits, setHabits] = useState<Habit[]>([]);
  const [todoMetas, setTodoMetas] = useState<Map<string, TodoMeta>>(new Map());

  const today = getTodayString();

  const loadAll = useCallback(async () => {
    await archivePastDays(today);
    const [entries, h, allMetas] = await Promise.all([
      getAllEntries(),
      getHabits(),
      getAllTodoMetas(),
    ]);
    setAllEntries(entries);
    setHabits(h);
    setTodoMetas(new Map(allMetas.map((m: TodoMeta) => [m.todoId, m])));
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

  // Map habitId -> set of YYYY-MM-DD where it was logged across all entries.
  // The grid only consults the current week's 7 cells, so memory stays small.
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

  // Week is locked to the current ISO week (Monday-anchored). The previous
  // prev/next-week navigation was dropped 2026-05-10 — dashboard always shows
  // the current 7 days only.
  const weekStart = useMemo(() => startOfISOWeekStr(today), [today]);

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

        {/* DAILY SCHEDULE — habits-only weekly grid, current week locked. */}
        {habits.length > 0 && (
          <View style={styles.section}>
            <Pressable
              onPress={() => router.push('/more')}
              style={styles.sectionHeader}
              hitSlop={6}
            >
              <Text style={styles.sectionLabel}>DAILY SCHEDULE</Text>
              <Icon name="arrowRight" size={14} color={colors.accent} />
            </Pressable>

            <DailyScheduleHeader weekStart={weekStart} today={today} />
            <DailyScheduleGrid
              habits={habits}
              checkedDatesByHabit={checkedDatesByHabit}
              weekStart={weekStart}
              today={today}
              offDayMode={offDayMode}
              isReadOnly={false}
              onToggleHabitToday={toggleHabitToday}
              onTapHabit={() => router.push('/more/habits')}
            />
            <OffDayToggle mode={offDayMode} onChange={setOffDayMode} />
            <DailyScheduleLegend />
          </View>
        )}

        {/* Smart todos */}
        <View style={styles.section}>
          <SmartTodoList entries={allEntries} today={today} onChanged={loadAll} metas={todoMetas} />
        </View>
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
    fontSize: 14,
    fontWeight: '700',
    color: colors.accent,
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
  // Title row that doubles as a tap target — label + arrow icon side
  // by side, both linking to the corresponding manage / detail page.
  // alignItems flex-start lets the icon visually anchor to the top of
  // the label box; the marginBottom on sectionLabel provides the gap
  // below the row.
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
});
