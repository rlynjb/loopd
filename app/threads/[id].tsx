import { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';
import { TypeBadge } from '../../src/components/todos/TypeBadge';
import { getThreadDetail, type ThreadDetail, type ThreadDetailTodo } from '../../src/services/threads/getThreadDetail';
import { computeStaleness, formatStalenessLabel, differenceInDays } from '../../src/services/threads/staleness';
import { updateTodo } from '../../src/services/todos/crud';

export default function ThreadDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const result = await getThreadDetail(id);
    setDetail(result);
    setLoading(false);
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const handleToggleTodo = useCallback(async (todo: ThreadDetailTodo) => {
    try {
      await updateTodo(todo.entryId, todo.todoId, { done: !todo.done });
      await load();
    } catch (e) {
      console.warn('[thread-detail] toggle failed:', e);
    }
  }, [load]);

  if (loading || !detail) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={10}>
            <Icon name="chevronLeft" size={22} color={colors.textMuted} />
          </Pressable>
          <Text style={styles.title}>Loading…</Text>
          <View style={{ width: 22 }} />
        </View>
      </View>
    );
  }

  const { thread, openTodos, doneTodos, doneTotalCount, entryMentions, entriesThisWeek, lastMentionAt } = detail;
  const days = lastMentionAt ? differenceInDays(new Date(), new Date(lastMentionAt)) : null;
  const staleness = computeStaleness(thread, lastMentionAt);
  const stalenessLabel = formatStalenessLabel(staleness, days);
  const accent =
    thread.color ||
    (staleness === 'fresh' ? colors.green
      : staleness === 'aging' ? colors.amber
      : staleness === 'stale' ? colors.coral
      : colors.textDim);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
        <View style={styles.titleBlock}>
          <View style={styles.titleRow}>
            <View style={[styles.dot, { backgroundColor: accent }]} />
            <Text style={styles.title}>{thread.name}</Text>
            {thread.pinned && <Text style={styles.pin}>★</Text>}
          </View>
          <Text style={styles.slug}>#{thread.slug}</Text>
        </View>
        <Pressable onPress={() => router.push('/more/threads')} hitSlop={10}>
          <Icon name="settings" size={18} color={colors.textDim} />
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.stats}>
          {stalenessLabel} · {entriesThisWeek} {entriesThisWeek === 1 ? 'entry' : 'entries'} this week · {openTodos.length} open · {doneTotalCount} done
        </Text>

        {/* OPEN */}
        <Text style={styles.sectionLabel}>OPEN ({openTodos.length})</Text>
        {openTodos.length === 0 ? (
          <Text style={styles.empty}>No open todos tagged here.</Text>
        ) : (
          openTodos.map(t => (
            <TodoRow
              key={t.todoId}
              todo={t}
              onPress={() => router.push('/todos')}
              onToggle={() => handleToggleTodo(t)}
            />
          ))
        )}

        {/* DONE */}
        {doneTodos.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>
              DONE {doneTotalCount > doneTodos.length ? `(recent ${doneTodos.length} of ${doneTotalCount})` : `(${doneTodos.length})`}
            </Text>
            {doneTodos.map(t => (
              <TodoRow
                key={t.todoId}
                todo={t}
                onPress={() => router.push('/todos')}
                onToggle={() => handleToggleTodo(t)}
              />
            ))}
          </>
        )}

        {/* ENTRIES (prose mentions) */}
        {entryMentions.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>ENTRIES ({entryMentions.length})</Text>
            {entryMentions.map(em => (
              <Pressable
                key={em.mentionId}
                onPress={() => router.push(`/journal/${em.entryDate}`)}
                style={styles.entryRow}
              >
                <Text style={styles.entryDate}>{em.entryDate}</Text>
                <Text style={styles.entryExcerpt} numberOfLines={2}>{em.excerpt || '(empty)'}</Text>
              </Pressable>
            ))}
          </>
        )}

        {openTodos.length === 0 && doneTodos.length === 0 && entryMentions.length === 0 && (
          <Text style={styles.empty}>
            No mentions yet. Type "#{thread.slug}" in a journal entry or todo to start populating this thread.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

// Two interactive zones: the checkbox toggles done, the body navigates to
// the /todos page. Wrapping the checkbox in its own Pressable stops the
// outer row tap from firing on box taps.
function TodoRow({
  todo, onPress, onToggle,
}: {
  todo: ThreadDetailTodo;
  onPress: () => void;
  onToggle: () => void;
}) {
  return (
    <View style={styles.todoRow}>
      <Pressable onPress={onToggle} hitSlop={10} style={styles.todoBoxBtn}>
        <Text style={styles.todoBox}>{todo.done ? '☑' : '☐'}</Text>
      </Pressable>
      <Pressable onPress={onPress} style={styles.todoBodyBtn}>
        <View style={styles.todoBody}>
          <Text style={[styles.todoText, todo.done && styles.todoTextDone]} numberOfLines={2}>
            {todo.text}
          </Text>
          <Text style={styles.todoDate}>{todo.entryDate}</Text>
        </View>
        <TypeBadge type={todo.type} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  titleBlock: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  title: { fontFamily: fonts.heading, fontSize: 20, color: colors.text },
  slug: { fontFamily: fonts.mono, fontSize: 11, color: colors.textDim },
  pin: { fontFamily: fonts.mono, fontSize: 13, color: colors.accent },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: GLOBAL_NAV_HEIGHT + 40,
  },
  stats: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
    marginBottom: 24,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1.4,
    marginTop: 8,
    marginBottom: 10,
  },
  empty: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textDim,
    paddingVertical: 12,
    lineHeight: 20,
  },
  todoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  todoBoxBtn: {
    paddingVertical: 4,
    paddingRight: 4,
  },
  todoBox: {
    fontFamily: fonts.mono,
    fontSize: 16,
    color: colors.textMuted,
    width: 18,
  },
  todoBodyBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  todoBody: { flex: 1, gap: 2 },
  todoText: { fontFamily: fonts.body, fontSize: 13, color: colors.text },
  todoTextDone: { color: colors.textDim, textDecorationLine: 'line-through' },
  todoDate: { fontFamily: fonts.mono, fontSize: 9, color: colors.textDim },
  entryRow: {
    paddingVertical: 12,
    gap: 4,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  entryDate: { fontFamily: fonts.mono, fontSize: 9, color: colors.textDim },
  entryExcerpt: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, lineHeight: 18 },
});
