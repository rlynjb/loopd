import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, StyleSheet, Animated } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../src/constants/theme';
import { Icon } from '../src/components/ui/Icon';
import { TypeBadge } from '../src/components/todos/TypeBadge';
import { TypeChangePicker } from '../src/components/todos/TypeChangePicker';
import { TagAutocomplete } from '../src/components/journal/TagAutocomplete';
import {
  getAllEntries, getAllTodoMetas, updateTodoMeta,
} from '../src/services/database';
import { addTodo, updateTodo, deleteTodo } from '../src/services/todos/crud';
import { createThread } from '../src/services/threads/crud';
import type { Thread } from '../src/types/thread';
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
    stage: 'todo',
    expandedMd: null,
    expandedAt: null,
    model: null,
    classifierConfidence: null,
    classifierModel: null,
    userOverriddenType: false,
    position: null,
    pinned: false,
    createdAt: todo.createdAt ?? entry.createdAt,
    updatedAt: todo.createdAt ?? entry.createdAt,
  };
}

export default function TodosScreen() {
  const router = useRouter();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [metas, setMetas] = useState<Map<string, TodoMeta>>(new Map());
  const [status, setStatus] = useState<Status>('open');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState('');
  // Cursor tracking for the tag autocomplete strip. Mirrors the journal
  // editor's pattern — detect `#xyz` immediately before the cursor on the
  // current line and surface the chip strip above the keyboard.
  const [newSelection, setNewSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  // Ref carries the live text across the gap between onChangeText and the
  // onSelectionChange that follows — without this, the selection handler
  // sees stale `newText` from the previous render.
  const newTextRef = useRef('');
  const [tagAutocomplete, setTagAutocomplete] = useState<{
    query: string;
    rangeStart: number;
    rangeEnd: number;
  } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editSelection, setEditSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const editTextRef = useRef('');
  const [editTagAutocomplete, setEditTagAutocomplete] = useState<{
    query: string;
    rangeStart: number;
    rangeEnd: number;
  } | null>(null);
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
    // Sort: pinned rows first (replaces the deprecated manual reorder),
    // then everything else by createdAt DESC (newest at the top). Within
    // each pinned/unpinned group, the createdAt-DESC tiebreak applies.
    out.sort((a, b) => {
      const aPin = a.meta.pinned ? 1 : 0;
      const bPin = b.meta.pinned ? 1 : 0;
      if (aPin !== bPin) return bPin - aPin;
      const aTime = new Date(a.createdAt ?? a.meta.createdAt).getTime();
      const bTime = new Date(b.createdAt ?? b.meta.createdAt).getTime();
      return bTime - aTime;
    });
    return out;
  }, [entries, metas]);

  const filtered = useMemo(() => {
    return allRows.filter(r => {
      // Status filter is a single-select with two real states:
      //   - 'all'   → no filter (everything, any done state)
      //   - 'open'  → not done
      //   - 'done'  → done
      // The legacy `stage` column on todo_meta is no longer surfaced — the
      // checkbox toggle (done flag) is the only status concept now.
      if (status === 'open') {
        if (r.done) return false;
      } else if (status === 'done') {
        if (!r.done) return false;
      }
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
    newTextRef.current = '';
    setNewText('');
    setAdding(false);
    setTagAutocomplete(null);
    if (!text) { addingRef.current = false; return; }
    try { await addTodo(text); await load(); } catch (e) { console.warn('[todos] add failed:', e); }
    finally { addingRef.current = false; }
  }, [newText, load]);

  // Tag autocomplete: detect "#xyz" immediately before the cursor on the
  // current line. Same regex as the journal editor.
  const detectTag = useCallback((text: string, cursor: number) => {
    const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
    const beforeCursor = text.slice(lineStart, cursor);
    const tagRe = /(?:^|[^\w#-])#([a-zA-Z][a-zA-Z0-9-]*)?$/;
    const m = tagRe.exec(beforeCursor);
    if (!m) { setTagAutocomplete(null); return; }
    const tagBody = m[1] ?? '';
    const matchStart = m.index + (m[0].startsWith('#') ? 0 : 1);
    setTagAutocomplete({
      query: tagBody,
      rangeStart: lineStart + matchStart,
      rangeEnd: cursor,
    });
  }, []);

  const handleNewTextChange = useCallback((t: string) => {
    newTextRef.current = t;
    setNewText(t);
    // For the new-todo input, the user is virtually always typing at the
    // end. Using t.length as the cursor avoids reading a stale selection
    // closure during the onChangeText → onSelectionChange interleave.
    detectTag(t, t.length);
  }, [detectTag]);

  const handleNewSelectionChange = useCallback((e: { nativeEvent: { selection: { start: number; end: number } } }) => {
    const { start, end } = e.nativeEvent.selection;
    setNewSelection({ start, end });
    // Read latest text from ref; React state may still be stale.
    detectTag(newTextRef.current, start);
  }, [detectTag]);

  const replaceTagRange = useCallback((replacement: string) => {
    if (!tagAutocomplete) return;
    const { rangeStart, rangeEnd } = tagAutocomplete;
    const current = newTextRef.current;
    const next = current.slice(0, rangeStart) + replacement + current.slice(rangeEnd);
    const cursor = rangeStart + replacement.length;
    newTextRef.current = next;
    setNewText(next);
    setNewSelection({ start: cursor, end: cursor });
    setTagAutocomplete(null);
  }, [tagAutocomplete]);

  const handleTagSelectExisting = useCallback((thread: Thread) => {
    replaceTagRange(`#${thread.slug} `);
  }, [replaceTagRange]);

  const handleTagCreateNew = useCallback(async (slug: string) => {
    const result = await createThread({ name: slug, slug });
    const finalSlug = result.ok ? result.thread.slug : slug;
    replaceTagRange(`#${finalSlug} `);
  }, [replaceTagRange]);

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
    editTextRef.current = r.text;
    setEditSelection({ start: r.text.length, end: r.text.length });
    setEditTagAutocomplete(null);
  }, []);

  const commitEdit = useCallback(async (r: Row) => {
    const text = editText.trim();
    setEditingId(null);
    setEditTagAutocomplete(null);
    if (!text || text === r.text) return;
    try { await updateTodo(r.entryId, r.id, { text }); await load(); } catch (e) {
      console.warn('[todos] edit failed:', e);
    }
  }, [editText, load]);

  // Edit-mode equivalents of the new-todo tag handlers. The shared
  // TagAutocomplete dispatches to whichever pair is active based on
  // `editingId`.
  const handleEditTextChange = useCallback((t: string) => {
    editTextRef.current = t;
    setEditText(t);
    detectTagInEditor(t, t.length);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEditSelectionChange = useCallback((e: { nativeEvent: { selection: { start: number; end: number } } }) => {
    const { start, end } = e.nativeEvent.selection;
    setEditSelection({ start, end });
    detectTagInEditor(editTextRef.current, start);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function detectTagInEditor(text: string, cursor: number) {
    const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
    const beforeCursor = text.slice(lineStart, cursor);
    const tagRe = /(?:^|[^\w#-])#([a-zA-Z][a-zA-Z0-9-]*)?$/;
    const m = tagRe.exec(beforeCursor);
    if (!m) { setEditTagAutocomplete(null); return; }
    const tagBody = m[1] ?? '';
    const matchStart = m.index + (m[0].startsWith('#') ? 0 : 1);
    setEditTagAutocomplete({
      query: tagBody,
      rangeStart: lineStart + matchStart,
      rangeEnd: cursor,
    });
  }

  const replaceEditTagRange = useCallback((replacement: string) => {
    if (!editTagAutocomplete) return;
    const { rangeStart, rangeEnd } = editTagAutocomplete;
    const current = editTextRef.current;
    const next = current.slice(0, rangeStart) + replacement + current.slice(rangeEnd);
    const cursor = rangeStart + replacement.length;
    editTextRef.current = next;
    setEditText(next);
    setEditSelection({ start: cursor, end: cursor });
    setEditTagAutocomplete(null);
  }, [editTagAutocomplete]);

  const handleEditTagSelectExisting = useCallback((thread: Thread) => {
    replaceEditTagRange(`#${thread.slug} `);
  }, [replaceEditTagRange]);

  const handleEditTagCreateNew = useCallback(async (slug: string) => {
    const result = await createThread({ name: slug, slug });
    const finalSlug = result.ok ? result.thread.slug : slug;
    replaceEditTagRange(`#${finalSlug} `);
  }, [replaceEditTagRange]);

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

  const handleTogglePin = useCallback(async (row: Row) => {
    try {
      await updateTodoMeta(row.id, { pinned: !row.meta.pinned });
      await load();
    } catch (e) {
      console.warn('[todos] pin toggle failed:', e);
    }
  }, [load]);

  const subtitle = useMemo(() => {
    const total = allRows.length;
    const shown = filtered.length;
    if (total === shown) return `${total} total · newest first`;
    return `${shown} of ${total} shown`;
  }, [allRows.length, filtered.length]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.title}>drops</Text>
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
            selection={newSelection}
            onChangeText={handleNewTextChange}
            onSelectionChange={handleNewSelectionChange}
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
        <Pressable onPress={() => router.push('/settings')} style={styles.banner}>
          <Text style={styles.bannerText}>
            AI classification disabled — {ambiguousCount} ambiguous todo{ambiguousCount === 1 ? '' : 's'} waiting. Tap to configure.
          </Text>
        </Pressable>
      )}

      {/* Status filter — single-select across done + stage. */}
      <View style={styles.filterRow}>
        <Text style={styles.filterLabel}>Status:</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.statusScroll}
          contentContainerStyle={styles.filters}
          keyboardShouldPersistTaps="handled"
        >
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
        </ScrollView>
      </View>

      {/* Thinking-mode filter — wraps to the next line so all chips are
          visible without horizontal scrolling. */}
      <View style={[styles.filterRow, styles.catFilterWrap]}>
        <Text style={styles.filterLabel}>Thinking-mode:</Text>
        <View style={styles.catFiltersWrap}>
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
        </View>
      </View>

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
          // Swipe-left reveals a coral delete button. Tapping it fires
          // handleDelete; the swipe doesn't auto-delete on release. The
          // inline x icon was removed once swipe shipped — single delete
          // affordance is cleaner.
          //
          // The action wraps in a fixed-width container with explicit
          // height: '100%' + Android `elevation` so the panel:
          //   1. Always matches the row's full (multi-line) height
          //   2. Stacks ABOVE the row content on Android (without elevation,
          //      the row's text could bleed through behind the coral panel
          //      due to platform z-ordering quirks)
          const renderRightActions = () => (
            <View style={styles.swipeActionContainer}>
              <Pressable
                onPress={() => handleDelete(r)}
                style={styles.swipeDeleteAction}
                hitSlop={4}
              >
                <Icon name="trash" size={18} color="#fff" />
                <Text style={styles.swipeDeleteText}>Delete</Text>
              </Pressable>
            </View>
          );
          return (
            <Swipeable
              key={r.id}
              renderRightActions={renderRightActions}
              rightThreshold={40}
              friction={1.5}
              overshootRight={false}
            >
            <View style={styles.row}>
              <Pressable onPress={() => handleToggle(r)} hitSlop={10} style={styles.checkbox}>
                <View style={[styles.check, r.done && styles.checkOn]}>
                  {r.done && <Icon name="checkSquare" size={10} color={colors.bg} />}
                </View>
              </Pressable>
              <View style={styles.body}>
                {isEditing ? (
                  <TextInput
                    value={editText}
                    selection={editSelection}
                    onChangeText={handleEditTextChange}
                    onSelectionChange={handleEditSelectionChange}
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
              <Pressable
                onPress={() => handleTogglePin(r)}
                hitSlop={14}
                android_ripple={{ color: 'rgba(255,255,255,0.08)', borderless: true, radius: 22 }}
                style={styles.pinBtn}
              >
                <Icon
                  name="pin"
                  size={16}
                  color={r.meta.pinned ? colors.accent : colors.textDim}
                  fill={r.meta.pinned ? colors.accent : 'none'}
                  strokeWidth={1.5}
                />
              </Pressable>
            </View>
            </Swipeable>
          );
        })}
      </ScrollView>

      {/* Tag autocomplete strip — sibling to the keyboard, same pattern as
          the journal editor. Routes to either the new-todo input or the
          inline edit input based on which is currently focused (only one
          can be focused at a time). */}
      <TagAutocomplete
        query={editingId ? (editTagAutocomplete?.query ?? null) : (tagAutocomplete?.query ?? null)}
        onSelectExisting={editingId ? handleEditTagSelectExisting : handleTagSelectExisting}
        onCreateNew={editingId ? handleEditTagCreateNew : handleTagCreateNew}
      />

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
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 20,
  },
  filterLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 0.5,
    marginRight: 8,
  },
  statusScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  filters: {
    flexDirection: 'row',
    gap: 8,
    paddingRight: 20,
    paddingVertical: 12,
    alignItems: 'center',
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
  // The thinking-mode filter row stacks the label above the chips so
  // they have the full row width to wrap into. Status filter still uses
  // the inline-row layout (only 3 chips, fits horizontally).
  catFilterWrap: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 8,
    paddingTop: 8,
    paddingBottom: 8,
    paddingRight: 20,
  },
  catFiltersWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
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
    paddingHorizontal: 0,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
    // Clip any text that extends beyond the row's bounding box — without
    // this, multi-line wrapped text can visually extend past the row's
    // right edge during the Swipeable translation and overlap the coral
    // delete panel.
    overflow: 'hidden',
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
  // Pin star — replaces the old reorder column on the row's right edge.
  // Positioned by the parent row's flex layout (no stretch / stack needed).
  pinBtn: {
    // Tap zone — pumped up because:
    //   1. Swipeable's horizontal gesture handler can intercept ambiguous
    //      taps near the row's right edge; a beefier target is more
    //      forgiving.
    //   2. Android's recommended minimum is 48dp; with hitSlop {14} the
    //      effective area gets close.
    // Top-aligned with the checkbox (the row uses alignItems: 'flex-start').
    paddingTop: 4,
    paddingBottom: 12,
    paddingLeft: 16,
    paddingRight: 8,
    minWidth: 40,
    alignItems: 'center',
  },
  expandedTag: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.green,
    letterSpacing: 0.4,
  },
  // Swipe-left action panel. Fixed width keeps the gesture distance
  // predictable. Explicit height: '100%' is critical — without it the
  // panel auto-sizes to the icon+text content and short rows look fine
  // but tall multi-line rows show row content peeking above/below the
  // shorter coral panel.
  swipeActionContainer: {
    width: 110,
    height: '100%',
    elevation: 4,
    zIndex: 5,
  },
  swipeDeleteAction: {
    flex: 1,
    backgroundColor: colors.coral,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  swipeDeleteText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: '#fff',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
});
