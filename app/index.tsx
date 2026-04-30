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
  getAllTodoMetas, insertEntry, updateEntry,
} from '../src/services/database';
import { getThreadCards } from '../src/services/threads/getThreadCards';
import { toggleThreadTouchToday } from '../src/services/threads/touch';
import { Icon } from '../src/components/ui/Icon';
import { getTodayString, formatDate } from '../src/utils/time';
import { generateId } from '../src/utils/id';
import type { Entry, Habit, Vlog } from '../src/types/entry';
import type { TodoMeta } from '../src/types/todoMeta';
import type { ThreadCard } from '../src/types/thread';

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

  // 14-day header cells for the habits heatmap — weekday letter + day-of-
  // month, one entry per column, Sunday-anchored to match HabitHeatmapRow.
  const heatmapHeaderCells = useMemo(() => {
    const letters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const todayDow = new Date(today + 'T12:00:00').getDay();
    const startDate = new Date(today + 'T12:00:00');
    startDate.setDate(startDate.getDate() - (todayDow + 7));
    const out: { letter: string; dayOfMonth: number; isToday: boolean }[] = [];
    for (let i = 0; i < HEATMAP_DAYS; i++) {
      const d = new Date(startDate);
      d.setDate(startDate.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      out.push({
        letter: letters[d.getDay()],
        dayOfMonth: d.getDate(),
        isToday: iso === today,
      });
    }
    return out;
  }, [today]);

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

        {/* TRACKER — combined habits + threads grouped by time-of-day.
            Within each bucket: habits first, then threads. Adaptive
            mini-headers when 2+ buckets are populated by either type. */}
        {(habits.length > 0 || threadCards.length > 0) && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionLabel}>DAILY SCHEDULE</Text>
              <Pressable onPress={() => router.push('/more')} hitSlop={6}>
                <Text style={styles.sectionLink}>manage →</Text>
              </Pressable>
            </View>
            <View style={styles.habitHeaderRow}>
              <View style={styles.habitHeaderLabelSpacer} />
              <View style={styles.habitHeaderCells}>
                {heatmapHeaderCells.map((c, i) => (
                  <View key={i} style={styles.habitHeaderCell}>
                    <Text style={[styles.habitHeaderLetter, c.isToday && styles.habitHeaderToday]}>{c.letter}</Text>
                    <Text style={[styles.habitHeaderNumber, c.isToday && styles.habitHeaderToday]}>{c.dayOfMonth}</Text>
                  </View>
                ))}
              </View>
              <View style={styles.habitHeaderCountSpacer} />
            </View>
            {(() => {
              const habitBuckets: Record<string, typeof habits> = {
                morning: [], midday: [], evening: [], anytime: [],
              };
              for (const h of habits) habitBuckets[h.timeOfDay ?? 'anytime'].push(h);
              const threadBuckets: Record<string, typeof threadCards> = {
                morning: [], midday: [], evening: [], anytime: [],
              };
              for (const c of threadCards) threadBuckets[c.thread.timeOfDay ?? 'anytime'].push(c);
              const order: Array<'morning' | 'midday' | 'evening' | 'anytime'> = [
                'morning', 'midday', 'evening', 'anytime',
              ];
              const occupied = order.filter(b => habitBuckets[b].length > 0 || threadBuckets[b].length > 0);
              const showHeaders = occupied.length >= 2;
              return occupied.map(bucket => (
                <View key={bucket}>
                  {showHeaders && <Text style={styles.bucketHeader}>{bucket}</Text>}
                  {habitBuckets[bucket].map(h => (
                    <HabitHeatmapRow
                      key={h.id}
                      habit={h}
                      checkedDates={checkedDatesByHabit.get(h.id) ?? new Set()}
                      today={today}
                      onToggleToday={() => toggleHabitToday(h.id)}
                    />
                  ))}
                  {threadBuckets[bucket].map(card => (
                    <ThreadHeatmapRow
                      key={card.thread.id}
                      card={card}
                      today={today}
                      onToggleToday={async () => {
                        await toggleThreadTouchToday(card.thread.id, card.thread.slug, today);
                        loadAll();
                      }}
                      onView={() => router.push(`/threads/${card.thread.id}`)}
                    />
                  ))}
                </View>
              ));
            })()}
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

// ── Thread row ──
// Layout matches HabitHeatmapRow: 80px name | flex:1 14-cell strip |
// 28px nav icon. Tapping the row toggles a "touched today" mention
// (see services/threads/touch.ts). The arrow icon is its own Pressable
// that routes to /threads/[id] for the detail view.

function ThreadHeatmapRow({
  card, today, onToggleToday, onView,
}: {
  card: ThreadCard;
  today: string;
  onToggleToday: () => void;
  onView: () => void;
}) {
  const { thread, staleness } = card;
  const activeDates = card.activeDates ?? new Set<string>();
  const accent =
    thread.color ||
    (staleness === 'fresh' ? colors.green
      : staleness === 'aging' ? colors.amber
      : staleness === 'stale' ? colors.coral
      : colors.textDim);

  // Same Sunday-anchored 14-day window as HabitHeatmapRow.
  const heatmapCells = (() => {
    const todayDow = new Date(today + 'T12:00:00').getDay();
    const start = (() => {
      const d = new Date(today + 'T12:00:00');
      d.setDate(d.getDate() - (todayDow + 7));
      return d;
    })();
    const out: { date: string; active: boolean; isToday: boolean }[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      out.push({ date: iso, active: activeDates.has(iso), isToday: iso === today });
    }
    return out;
  })();

  return (
    <Pressable onPress={onToggleToday} style={styles.threadRow} hitSlop={4}>
      <Text style={styles.threadRowName} numberOfLines={1}>{thread.name}</Text>
      <View style={styles.threadRowHeatmap}>
        {heatmapCells.map((c, i) => (
          <View
            key={`${c.date}-${i}`}
            style={[
              styles.threadRowCell,
              c.active ? { backgroundColor: accent } : styles.threadRowCellOff,
              c.isToday && !c.active && styles.threadRowCellToday,
            ]}
          />
        ))}
      </View>
      <Pressable onPress={onView} hitSlop={10} style={styles.threadRowNavBtn}>
        <Icon name="arrowRight" size={14} color={colors.textDim} />
      </Pressable>
    </Pressable>
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
  habitHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 2,
  },
  habitHeaderLabelSpacer: {
    width: 80,
  },
  habitHeaderCells: {
    flex: 1,
    flexDirection: 'row',
    gap: 2,
  },
  habitHeaderCell: {
    flex: 1,
    alignItems: 'center',
  },
  habitHeaderLetter: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: colors.textDim,
    letterSpacing: 0.3,
  },
  habitHeaderNumber: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: colors.textDimmer,
    marginTop: 1,
  },
  habitHeaderToday: {
    color: colors.accent,
  },
  habitHeaderCountSpacer: {
    width: 36,
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
  // Thread row — mirrors HabitHeatmapRow layout exactly so columns line
  // up: 80px name, flex:1 14-cell strip, 36px right-side count.
  threadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
  },
  threadRowName: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.text,
    width: 80,
  },
  threadRowHeatmap: {
    flex: 1,
    flexDirection: 'row',
    gap: 2,
    alignItems: 'center',
  },
  threadRowCell: {
    flex: 1,
    height: 11,
    borderRadius: 2,
  },
  threadRowCellOff: {
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  threadRowCellToday: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: colors.accent,
  },
  threadRowNavBtn: {
    width: 36,
    alignItems: 'flex-end',
    paddingVertical: 4,
  },
  bucketHeader: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDimmer,
    letterSpacing: 1.4,
    marginTop: 14,
    marginBottom: 4,
  },
});
