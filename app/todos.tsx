import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, StyleSheet, Animated } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../src/constants/theme';
import { Icon } from '../src/components/ui/Icon';
import { TypeBadge } from '../src/components/todos/TypeBadge';
import { TypeChangePicker } from '../src/components/todos/TypeChangePicker';
import { getAllEntries, getAllTodoMetas, updateTodoMeta } from '../src/services/database';
import { addTodo, updateTodo, deleteTodo } from '../src/services/todos/crud';
import { TYPE_META, TYPES_IN_ORDER } from '../src/services/todos/typeMeta';
import { formatRelativeTime } from '../src/services/todos/rank';
import {
  isClassifierAvailable, getClassifyInFlight, CLASSIFY_PROGRESS_EVENT,
} from '../src/services/todos/classify';
import { countAmbiguousNotDone } from '../src/services/todos/migrateMeta';
import { on } from '../src/utils/events';
import type { Entry, TodoItem } from '../src/types/entry';
import type { TodoMeta, TodoType } from '../src/types/todoMeta';

type Status = 'all' | 'open' | 'done';
type CategoryFilter = 'all' | TodoType;

// Flat row shape used by the list — joins TodoItem with its parent entry's
// id/date and the matching todo_meta row (default placeholder if missing).
type Row = TodoItem & {
  entryId: string;
  entryDate: string;
  meta: TodoMeta;
};

function defaultMeta(todo: TodoItem, entry: Entry): TodoMeta {
  return {
    todoId: todo.id,
    entryId: entry.id,
    entryDate: entry.date,
    type: 'todo',
    expandedMd: null,
    expandedAt: null,
    model: null,
    classifierConfidence: null,
    classifierModel: null,
    userOverriddenType: false,
    createdAt: todo.createdAt ?? entry.createdAt,
    updatedAt: todo.createdAt ?? entry.createdAt,
  };
}

export default function TodosScreen() {
  const router = useRouter();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [metas, setMetas] = useState<Map<string, TodoMeta>>(new Map());
  const [status, setStatus] = useState<Status>('all');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [pickerFor, setPickerFor] = useState<Row | null>(null);
  const [classifyInFlight, setClassifyInFlight] = useState(0);
  const [ambiguousCount, setAmbiguousCount] = useState(0);
  const [aiAvailable, setAiAvailable] = useState(true);
  const inputRef = useRef<TextInput>(null);
  const addingRef = useRef(false);

  const load = useCallback(async () => {
    const [allEntries, allMetas, ambiguous, ai] = await Promise.all([
      getAllEntries(),
      getAllTodoMetas(),
      countAmbiguousNotDone(),
      isClassifierAvailable(),
    ]);
    setEntries(allEntries);
    setMetas(new Map(allMetas.map(m => [m.todoId, m])));
    setAmbiguousCount(ambiguous);
    setAiAvailable(ai);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Subscribe to the classifier's in-flight counter so the toast shows
  // live progress while the catch-up pass churns through ambiguous rows.
  // Reload meta + counts when the count drops to zero so badges update.
  useEffect(() => {
    setClassifyInFlight(getClassifyInFlight());
    const unsub = on(CLASSIFY_PROGRESS_EVENT, () => {
      const next = getClassifyInFlight();
      setClassifyInFlight(next);
      if (next === 0) {
        load();
      }
    });
    return unsub;
  }, [load]);

  // Toast animation. Show whenever classifyInFlight > 0; hide with a small
  // debounce after it drops to 0 so back-to-back calls don't flicker the
  // toast on/off. Absolutely positioned over the page so showing it never
  // shifts the list layout (was the source of the "glitches up/down" bug).
  const [toastVisible, setToastVisible] = useState(false);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (classifyInFlight > 0) {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      if (!toastVisible) {
        setToastVisible(true);
        Animated.timing(toastOpacity, {
          toValue: 1, duration: 200, useNativeDriver: true,
        }).start();
      }
    } else if (toastVisible && !hideTimerRef.current) {
      hideTimerRef.current = setTimeout(() => {
        Animated.timing(toastOpacity, {
          toValue: 0, duration: 200, useNativeDriver: true,
        }).start(() => setToastVisible(false));
        hideTimerRef.current = null;
      }, 800);
    }
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [classifyInFlight, toastVisible, toastOpacity]);

  // Flatten entries → todos joined with meta, sorted strictly chronological
  // by createdAt ASC (oldest first; spec §8.2). New captures append to the
  // bottom of the list — scroll down to see what's new.
  const allRows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const entry of entries) {
      for (const todo of entry.todos ?? []) {
        out.push({
          ...todo,
          entryId: entry.id,
          entryDate: entry.date,
          meta: metas.get(todo.id) ?? defaultMeta(todo, entry),
        });
      }
    }
    out.sort((a, b) => {
      const aTime = new Date(a.createdAt ?? a.meta.createdAt).getTime();
      const bTime = new Date(b.createdAt ?? b.meta.createdAt).getTime();
      return aTime - bTime;
    });
    return out;
  }, [entries, metas]);

  const filtered = useMemo(() => {
    return allRows.filter(r => {
      if (status === 'open' && r.done) return false;
      if (status === 'done' && !r.done) return false;
      if (category !== 'all' && r.meta.type !== category) return false;
      return true;
    });
  }, [allRows, status, category]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<TodoType, number>();
    for (const t of TYPES_IN_ORDER) counts.set(t, 0);
    for (const r of allRows) {
      counts.set(r.meta.type, (counts.get(r.meta.type) ?? 0) + 1);
    }
    return counts;
  }, [allRows]);

  const handleAdd = useCallback(async () => {
    if (addingRef.current) return;
    addingRef.current = true;
    const text = newText.trim();
    setNewText('');
    setAdding(false);
    if (!text) { addingRef.current = false; return; }
    try { await addTodo(text); await load(); } catch (e) { console.warn('[todos] add failed:', e); }
    finally { addingRef.current = false; }
  }, [newText, load]);

  const handleToggle = useCallback(async (r: Row) => {
    try { await updateTodo(r.entryId, r.id, { done: !r.done }); await load(); } catch (e) {
      console.warn('[todos] toggle failed:', e);
    }
  }, [load]);

  const handleDelete = useCallback(async (r: Row) => {
    try { await deleteTodo(r.entryId, r.id); await load(); } catch (e) {
      console.warn('[todos] delete failed:', e);
    }
  }, [load]);

  const startEdit = useCallback((r: Row) => {
    setEditingId(r.id);
    setEditText(r.text);
  }, []);

  const commitEdit = useCallback(async (r: Row) => {
    const text = editText.trim();
    setEditingId(null);
    if (!text || text === r.text) return;
    try { await updateTodo(r.entryId, r.id, { text }); await load(); } catch (e) {
      console.warn('[todos] edit failed:', e);
    }
  }, [editText, load]);

  const handleTypePick = useCallback(async (newType: TodoType) => {
    if (!pickerFor) return;
    const target = pickerFor;
    setPickerFor(null);
    if (newType === target.meta.type) return;
    try {
      await updateTodoMeta(target.id, { type: newType, userOverriddenType: true });
      await load();
    } catch (e) {
      console.warn('[todos] type change failed:', e);
    }
  }, [pickerFor, load]);

  const subtitle = useMemo(() => {
    const total = allRows.length;
    const shown = filtered.length;
    if (total === shown) return `${total} total · oldest first`;
    return `${shown} of ${total} shown`;
  }, [allRows.length, filtered.length]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.title}>todos</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
        <Pressable
          onPress={() => { setAdding(v => !v); setTimeout(() => inputRef.current?.focus(), 50); }}
          hitSlop={10}
        >
          <Text style={styles.addBtn}>{adding ? '×' : '⊕ Add'}</Text>
        </Pressable>
      </View>

      {adding && (
        <View style={styles.addRow}>
          <TextInput
            ref={inputRef}
            value={newText}
            onChangeText={setNewText}
            onSubmitEditing={handleAdd}
            onBlur={handleAdd}
            placeholder="Something to do…"
            placeholderTextColor={colors.textDimmer}
            returnKeyType="done"
            style={styles.addInput}
          />
        </View>
      )}

      {/* Persistent inline prompt when AI isn't configured but there are
          ambiguous rows. Doesn't flicker — only changes when the user
          configures a key, so it's safe to leave inline. */}
      {!aiAvailable && ambiguousCount > 0 && (
        <Pressable onPress={() => router.push('/settings/ai')} style={styles.banner}>
          <Text style={styles.bannerText}>
            AI classification disabled — {ambiguousCount} ambiguous todo{ambiguousCount === 1 ? '' : 's'} waiting. Tap to configure.
          </Text>
        </Pressable>
      )}

      {/* Status filter */}
      <View style={styles.filters}>
        {(['all', 'open', 'done'] as Status[]).map(s => (
          <Pressable
            key={s}
            onPress={() => setStatus(s)}
            style={[styles.pill, status === s && styles.pillActive]}
          >
            <Text style={[styles.pillText, status === s && styles.pillTextActive]}>
              {s.toUpperCase()}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Category filter — horizontal scroll for the 8 chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.catScroll}
        contentContainerStyle={styles.catFilters}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable
          onPress={() => setCategory('all')}
          style={[styles.catPill, category === 'all' && styles.catPillActive]}
        >
          <Text style={[styles.catPillText, category === 'all' && styles.catPillTextActive]}>
            ALL {allRows.length}
          </Text>
        </Pressable>
        {TYPES_IN_ORDER.map(t => {
          const meta = TYPE_META[t];
          const count = categoryCounts.get(t) ?? 0;
          const active = category === t;
          return (
            <Pressable
              key={t}
              onPress={() => setCategory(t)}
              style={[
                styles.catPill,
                active && {
                  borderColor: meta.color,
                  backgroundColor: `${meta.color}15`,
                },
              ]}
            >
              <Icon name={meta.icon} size={11} color={active ? meta.color : colors.textDim} />
              <Text style={[
                styles.catPillText,
                active && { color: meta.color },
              ]}>
                {meta.label.toLowerCase()} {count}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {filtered.length === 0 && (
          <Text style={styles.emptyText}>
            {status === 'done' ? 'Nothing completed yet.'
              : category !== 'all' ? `No ${TYPE_META[category as TodoType].label.toLowerCase()} entries.`
              : 'No todos yet. Tap ⊕ Add to create one.'}
          </Text>
        )}

        {filtered.map(r => {
          const isEditing = editingId === r.id;
          const time = formatRelativeTime(r.createdAt ?? r.meta.createdAt);
          return (
            <View key={r.id} style={styles.row}>
              <Pressable onPress={() => handleToggle(r)} hitSlop={10} style={styles.checkbox}>
                <View style={[styles.check, r.done && styles.checkOn]}>
                  {r.done && <Icon name="checkSquare" size={10} color={colors.bg} />}
                </View>
              </Pressable>
              <View style={styles.body}>
                {isEditing ? (
                  <TextInput
                    value={editText}
                    onChangeText={setEditText}
                    onBlur={() => commitEdit(r)}
                    autoFocus
                    multiline
                    blurOnSubmit={false}
                    style={[styles.text, styles.editInput]}
                  />
                ) : (
                  <Pressable onPress={() => startEdit(r)} onLongPress={() => setPickerFor(r)}>
                    <Text style={[styles.text, r.done && styles.textDone]}>
                      {r.text}
                    </Text>
                  </Pressable>
                )}
                <View style={styles.metaRow}>
                  <TypeBadge
                    type={r.meta.type}
                    confidence={r.meta.classifierConfidence}
                    onPress={() => setPickerFor(r)}
                  />
                  {r.meta.type !== 'todo' && r.meta.expandedMd && (
                    <Pressable
                      onPress={() => router.push({ pathname: '/todos/[id]', params: { id: r.id, text: r.text } })}
                      hitSlop={4}
                    >
                      <Text style={styles.expandedTag}>● expanded</Text>
                    </Pressable>
                  )}
                  {r.meta.type !== 'todo' && !r.meta.expandedMd && (
                    <Pressable
                      onPress={() => router.push({ pathname: '/todos/[id]', params: { id: r.id, text: r.text } })}
                      hitSlop={4}
                    >
                      <Text style={styles.expandBtn}>[expand]</Text>
                    </Pressable>
                  )}
                  <Text style={styles.meta}>{time}</Text>
                  <Pressable onPress={() => router.push(`/journal/${r.entryDate}`)} hitSlop={4}>
                    <Text style={styles.meta}>{r.entryDate}</Text>
                  </Pressable>
                </View>
              </View>
              <Pressable onPress={() => handleDelete(r)} hitSlop={10} style={styles.deleteBtn}>
                <Icon name="x" size={14} color={colors.textDim} />
              </Pressable>
            </View>
          );
        })}
      </ScrollView>

      <TypeChangePicker
        visible={!!pickerFor}
        todoText={pickerFor?.text ?? ''}
        currentType={pickerFor?.meta.type ?? 'todo'}
        onCancel={() => setPickerFor(null)}
        onPick={handleTypePick}
      />

      {toastVisible && (
        <Animated.View style={[styles.toast, { opacity: toastOpacity }]} pointerEvents="none">
          <Text style={styles.toastText}>
            classifying {classifyInFlight} todo{classifyInFlight === 1 ? '' : 's'}…
          </Text>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerCenter: {
    alignItems: 'center',
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: colors.text,
  },
  subtitle: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    marginTop: 2,
  },
  addBtn: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.accent,
  },
  addRow: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  addInput: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.text,
    padding: 0,
  },
  banner: {
    marginHorizontal: 20,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: `${colors.accent}10`,
    borderWidth: 1,
    borderColor: `${colors.accent}40`,
    borderRadius: 6,
  },
  bannerText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.accent,
    letterSpacing: 0.4,
  },
  toast: {
    position: 'absolute',
    top: 96,
    left: 20,
    right: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: `${colors.accent}55`,
    borderRadius: 6,
    zIndex: 50,
  },
  toastText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.accent,
    letterSpacing: 0.4,
    textAlign: 'center',
  },
  filters: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  pill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  pillActive: {
    borderColor: colors.accent,
    backgroundColor: `${colors.accent}10`,
  },
  pillText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 1,
  },
  pillTextActive: {
    color: colors.accent,
  },
  catScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  catFilters: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 6,
    flexDirection: 'row',
    alignItems: 'center',
  },
  catPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 999,
  },
  catPillActive: {
    borderColor: colors.accent,
    backgroundColor: `${colors.accent}10`,
  },
  catPillText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 0.5,
  },
  catPillTextActive: {
    color: colors.accent,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: GLOBAL_NAV_HEIGHT + 40,
  },
  emptyText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textDim,
    paddingVertical: 24,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  checkbox: {
    paddingTop: 2,
  },
  check: {
    width: 16,
    height: 16,
    borderWidth: 1.5,
    borderColor: colors.textDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  body: {
    flex: 1,
    gap: 4,
  },
  text: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
  },
  textDone: {
    color: colors.textDim,
    textDecorationLine: 'line-through',
  },
  editInput: {
    padding: 0,
    margin: 0,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
    flexWrap: 'wrap',
  },
  meta: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
  },
  expandBtn: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.accent,
    letterSpacing: 0.4,
  },
  expandedTag: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.green,
    letterSpacing: 0.4,
  },
  deleteBtn: {
    padding: 4,
  },
});
