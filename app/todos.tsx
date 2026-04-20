import { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../src/constants/theme';
import { Icon } from '../src/components/ui/Icon';
import { getAllEntries } from '../src/services/database';
import { addTodo, updateTodo, deleteTodo } from '../src/services/todos/crud';
import { rankTodos, formatRelativeTime, type RankedTodo, type TodoSource } from '../src/services/todos/rank';
import { getTodayString } from '../src/utils/time';
import type { Entry } from '../src/types/entry';

type Filter = 'all' | 'open' | 'pinned' | 'done';

const SOURCE_BADGE: Record<TodoSource, string> = {
  journal: '📓',
  ai: '✦',
  pinned: '⭐',
  carried: '🔁',
};

export default function TodosScreen() {
  const router = useRouter();
  const today = getTodayString();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const inputRef = useRef<TextInput>(null);
  // Guards against onSubmitEditing + onBlur both firing on keyboard "done".
  const addingRef = useRef(false);

  const load = useCallback(async () => {
    const all = await getAllEntries();
    setEntries(all);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const ranked = useMemo(() => {
    // Use a longer retention so the "Done" tab surfaces historical completions.
    return rankTodos(entries, { today, includeDoneOlderThanMs: Number.MAX_SAFE_INTEGER });
  }, [entries, today]);

  const filtered = useMemo(() => {
    switch (filter) {
      case 'open': return ranked.filter(t => !t.done);
      case 'pinned': return ranked.filter(t => t.pinned);
      case 'done': return ranked.filter(t => t.done);
      default: return ranked;
    }
  }, [ranked, filter]);

  const handleAdd = useCallback(async () => {
    if (addingRef.current) return;
    addingRef.current = true;
    const text = newText.trim();
    setNewText('');
    setAdding(false);
    if (!text) { addingRef.current = false; return; }
    try { await addTodo(text); await load(); } catch (e) {
      console.warn('[todos] add failed:', e);
    } finally {
      addingRef.current = false;
    }
  }, [newText, load]);

  const handleToggle = useCallback(async (t: RankedTodo) => {
    try { await updateTodo(t.entryId, t.id, { done: !t.done }); await load(); } catch (e) {
      console.warn('[todos] toggle failed:', e);
    }
  }, [load]);

  const handleDelete = useCallback(async (t: RankedTodo) => {
    try { await deleteTodo(t.entryId, t.id); await load(); } catch (e) {
      console.warn('[todos] delete failed:', e);
    }
  }, [load]);

  const handleTogglePin = useCallback(async (t: RankedTodo) => {
    try { await updateTodo(t.entryId, t.id, { pinned: !t.pinned }); await load(); } catch (e) {
      console.warn('[todos] pin failed:', e);
    }
  }, [load]);

  const startEdit = useCallback((t: RankedTodo) => {
    setEditingId(t.id);
    setEditText(t.text);
  }, []);

  const commitEdit = useCallback(async (t: RankedTodo) => {
    const text = editText.trim();
    setEditingId(null);
    if (!text || text === t.text) return;
    try { await updateTodo(t.entryId, t.id, { text }); await load(); } catch (e) {
      console.warn('[todos] edit failed:', e);
    }
  }, [editText, load]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
        <Text style={styles.title}>Todos</Text>
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

      <View style={styles.filters}>
        {(['all', 'open', 'pinned', 'done'] as Filter[]).map(f => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            style={[styles.filterPill, filter === f && styles.filterPillActive]}
          >
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>
              {f.toUpperCase()}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {filtered.length === 0 && (
          <Text style={styles.emptyText}>
            {filter === 'pinned' ? 'No pinned todos yet.'
              : filter === 'done' ? 'Nothing completed yet.'
              : 'No todos yet. Tap ⊕ Add to create one.'}
          </Text>
        )}

        {filtered.map(t => {
          const isEditing = editingId === t.id;
          const time = formatRelativeTime(t.createdAt ?? t.entryCreatedAt);
          return (
            <View key={t.id} style={styles.row}>
              <Pressable onPress={() => handleToggle(t)} hitSlop={10} style={styles.checkbox}>
                <View style={[styles.check, t.done && styles.checkOn]}>
                  {t.done && <Icon name="checkSquare" size={10} color={colors.bg} />}
                </View>
              </Pressable>
              <View style={styles.body}>
                {isEditing ? (
                  <TextInput
                    value={editText}
                    onChangeText={setEditText}
                    onSubmitEditing={() => commitEdit(t)}
                    onBlur={() => commitEdit(t)}
                    autoFocus
                    returnKeyType="done"
                    style={[styles.text, styles.editInput]}
                  />
                ) : (
                  <Pressable onPress={() => startEdit(t)} onLongPress={() => handleTogglePin(t)}>
                    <Text style={[styles.text, t.done && styles.textDone]} numberOfLines={3}>
                      {t.text}
                    </Text>
                  </Pressable>
                )}
                <View style={styles.metaRow}>
                  <Text style={styles.badge}>{SOURCE_BADGE[t.source]}</Text>
                  <Text style={styles.meta}>{time}</Text>
                  <Pressable onPress={() => router.push(`/journal/${t.entryDate}`)} hitSlop={4}>
                    <Text style={styles.linkDate}>{t.entryDate}</Text>
                  </Pressable>
                </View>
              </View>
              <Pressable onPress={() => handleDelete(t)} hitSlop={10} style={styles.deleteBtn}>
                <Icon name="x" size={14} color={colors.textDim} />
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
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
  title: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: colors.text,
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
  filters: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  filterPill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  filterPillActive: {
    borderColor: colors.accent,
    backgroundColor: `${colors.accent}10`,
  },
  filterText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 1,
  },
  filterTextActive: {
    color: colors.accent,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
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
    gap: 2,
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
  },
  badge: {
    fontSize: 10,
  },
  meta: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
  },
  linkDate: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.accent,
  },
  deleteBtn: {
    padding: 4,
  },
});
