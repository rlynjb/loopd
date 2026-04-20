import { useCallback, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { generateId } from '../../utils/id';
import { formatRelativeTime } from '../../services/todos/rank';
import type { TodoItem } from '../../types/entry';

type Props = {
  todos: TodoItem[];
  onUpdate: (todos: TodoItem[]) => void;
  editable?: boolean;
};

export function InlineTodoList({ todos, onUpdate, editable = true }: Props) {
  const [newText, setNewText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const inputRef = useRef<TextInput>(null);
  // Guards against onSubmitEditing + onBlur both firing on keyboard "done".
  const addingRef = useRef(false);

  const toggle = (id: string) => {
    onUpdate(todos.map(t =>
      t.id === id
        ? { ...t, done: !t.done, completedAt: !t.done ? new Date().toISOString() : null }
        : t
    ));
  };

  const addItem = useCallback(() => {
    if (addingRef.current) return;
    addingRef.current = true;
    const text = newText.trim();
    setNewText('');
    if (!text) { addingRef.current = false; return; }
    onUpdate([
      ...todos,
      {
        id: generateId('todo'),
        text,
        done: false,
        completedAt: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    addingRef.current = false;
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [newText, todos, onUpdate]);

  const removeItem = (id: string) => {
    onUpdate(todos.filter(t => t.id !== id));
  };

  const startEdit = (t: TodoItem) => {
    setEditingId(t.id);
    setEditText(t.text);
  };

  const commitEdit = (t: TodoItem) => {
    const text = editText.trim();
    setEditingId(null);
    if (!text || text === t.text) return;
    onUpdate(todos.map(x => (x.id === t.id ? { ...x, text } : x)));
  };

  return (
    <View style={styles.container}>
      {todos.map(t => {
        const isEditing = editingId === t.id;
        const timeSource = t.createdAt ?? (t.done ? t.completedAt : null);
        return (
          <View key={t.id} style={styles.item}>
            <Pressable onPress={() => toggle(t.id)} hitSlop={6} style={styles.checkboxWrap}>
              <View style={[styles.checkbox, t.done && styles.checkboxDone]}>
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
                  style={[styles.itemText, styles.editInput]}
                />
              ) : (
                <Pressable onPress={() => editable && startEdit(t)}>
                  <Text style={[styles.itemText, t.done && styles.itemTextDone]} numberOfLines={2}>
                    {t.text}
                  </Text>
                </Pressable>
              )}
              {timeSource && (
                <Text style={styles.timestamp}>{formatRelativeTime(timeSource)}</Text>
              )}
            </View>
            {editable && (
              <Pressable onPress={() => removeItem(t.id)} hitSlop={8} style={styles.removeBtn}>
                <Icon name="x" size={12} color={colors.textDimmer} />
              </Pressable>
            )}
          </View>
        );
      })}
      {editable && (
        <View style={styles.addRow}>
          <View style={styles.checkboxPlaceholder} />
          <TextInput
            ref={inputRef}
            value={newText}
            onChangeText={setNewText}
            onSubmitEditing={addItem}
            onBlur={addItem}
            placeholder="Add item..."
            placeholderTextColor={colors.textDimmer}
            returnKeyType="done"
            blurOnSubmit={false}
            autoFocus={todos.length === 0}
            style={styles.addInput}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 10,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 6,
  },
  checkboxWrap: {
    paddingTop: 2,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 1.5,
    borderColor: colors.textDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxDone: {
    borderColor: colors.green,
    backgroundColor: `${colors.green}12`,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  itemText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.text,
    lineHeight: 20,
  },
  itemTextDone: {
    color: colors.textDim,
    textDecorationLine: 'line-through',
  },
  editInput: {
    padding: 0,
    margin: 0,
  },
  timestamp: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
  },
  removeBtn: {
    padding: 4,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  checkboxPlaceholder: {
    width: 20,
    height: 20,
    borderWidth: 1.5,
    borderColor: colors.textDimmer,
    borderStyle: 'dashed',
  },
  addInput: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.text,
    padding: 0,
  },
});
