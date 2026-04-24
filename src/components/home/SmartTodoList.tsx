import { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, TextInput, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { rankTodos, formatRelativeTime, type RankedTodo } from '../../services/todos/rank';
import { addTodo, updateTodo, deleteTodo } from '../../services/todos/crud';
import type { Entry } from '../../types/entry';

const MAX_ROWS = 5;

type Props = {
  entries: Entry[];            // all entries (parent owns the query)
  today: string;               // YYYY-MM-DD
  onChanged: () => void;       // fired after any CRUD, so parent can reload entries
};

export function SmartTodoList({ entries, today, onChanged }: Props) {
  const router = useRouter();
  const [newText, setNewText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const newInputRef = useRef<TextInput>(null);
  // Guards against onSubmitEditing + onBlur both firing on keyboard "done",
  // which otherwise makes addTodo run twice and duplicate the item.
  const addingRef = useRef(false);

  const ranked = useMemo(() => rankTodos(entries, { today }), [entries, today]);
  const visible = ranked.slice(-MAX_ROWS);

  const handleAdd = useCallback(async () => {
    if (addingRef.current) return;
    addingRef.current = true;
    const text = newText.trim();
    setNewText('');
    if (!text) { addingRef.current = false; return; }
    try { await addTodo(text); onChanged(); } catch (e) {
      console.warn('[todos] add failed:', e);
    } finally {
      addingRef.current = false;
    }
  }, [newText, onChanged]);

  const handleToggle = useCallback(async (t: RankedTodo) => {
    try {
      await updateTodo(t.entryId, t.id, { done: !t.done });
      onChanged();
    } catch (e) { console.warn('[todos] toggle failed:', e); }
  }, [onChanged]);

  const handleDelete = useCallback(async (t: RankedTodo) => {
    try { await deleteTodo(t.entryId, t.id); onChanged(); } catch (e) {
      console.warn('[todos] delete failed:', e);
    }
  }, [onChanged]);

  const startEdit = useCallback((t: RankedTodo) => {
    setEditingId(t.id);
    setEditText(t.text);
  }, []);

  const commitEdit = useCallback(async (t: RankedTodo) => {
    const text = editText.trim();
    setEditingId(null);
    if (!text || text === t.text) return;
    try { await updateTodo(t.entryId, t.id, { text }); onChanged(); } catch (e) {
      console.warn('[todos] edit failed:', e);
    }
  }, [editText, onChanged]);

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>TODOS {ranked.length > 0 ? `(${ranked.length})` : ''}</Text>
      </View>

      {visible.map(t => {
        const isEditing = editingId === t.id;
        const time = formatRelativeTime(t.createdAt ?? t.entryCreatedAt);
        return (
          <View key={t.id} style={styles.row}>
            <Pressable onPress={() => handleToggle(t)} hitSlop={10} style={styles.checkbox}>
              <View style={[styles.check, t.done && styles.checkOn]}>
                {t.done && <Icon name="checkSquare" size={14} color={colors.green} />}
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
                <Pressable onPress={() => startEdit(t)}>
                  <Text style={[styles.text, t.done && styles.textDone]} numberOfLines={2}>
                    {t.text}
                  </Text>
                </Pressable>
              )}
              <View style={styles.metaRow}>
                <Text style={styles.meta}>{time}</Text>
              </View>
            </View>
            <Pressable onPress={() => handleDelete(t)} hitSlop={10} style={styles.deleteBtn}>
              <Icon name="x" size={14} color={colors.textDim} />
            </Pressable>
          </View>
        );
      })}

      {/* Empty add row — always visible, tap anywhere to type. Acts as both
          the add affordance and the empty state. */}
      <Pressable onPress={() => newInputRef.current?.focus()} style={styles.row}>
        <View style={styles.checkbox}>
          <View style={[styles.check, styles.checkPlaceholder]} />
        </View>
        <View style={styles.body}>
          <TextInput
            ref={newInputRef}
            value={newText}
            onChangeText={setNewText}
            onSubmitEditing={handleAdd}
            onBlur={handleAdd}
            placeholder="Add a todo…"
            placeholderTextColor={colors.textDimmer}
            returnKeyType="done"
            style={styles.text}
          />
        </View>
      </Pressable>

      {ranked.length > MAX_ROWS && (
        <Pressable onPress={() => router.push('/todos')} style={styles.seeAllBtn}>
          <Text style={styles.seeAllText}>See all ({ranked.length})</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 8,
  },
  checkbox: {
    paddingTop: 2,
  },
  check: {
    width: 20,
    height: 20,
    borderWidth: 1.5,
    borderColor: colors.textDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: {
    borderColor: colors.green,
    backgroundColor: `${colors.green}12`,
  },
  checkPlaceholder: {
    borderColor: colors.textDimmer,
    borderStyle: 'dashed',
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
    padding: 0,
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
    gap: 6,
  },
  meta: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
  },
  deleteBtn: {
    padding: 4,
  },
  seeAllBtn: {
    paddingVertical: 6,
  },
  seeAllText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 0.5,
  },
});
