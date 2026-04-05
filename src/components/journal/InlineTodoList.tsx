import { useState, useRef } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { generateId } from '../../utils/id';
import type { TodoItem } from '../../types/entry';

type Props = {
  todos: TodoItem[];
  onUpdate: (todos: TodoItem[]) => void;
  editable?: boolean;
};

export function InlineTodoList({ todos, onUpdate, editable = true }: Props) {
  const [newText, setNewText] = useState('');
  const inputRef = useRef<TextInput>(null);

  const toggle = (id: string) => {
    onUpdate(todos.map(t =>
      t.id === id
        ? { ...t, done: !t.done, completedAt: !t.done ? new Date().toISOString() : null }
        : t
    ));
  };

  const addItem = () => {
    if (!newText.trim()) return;
    onUpdate([...todos, { id: generateId('todo'), text: newText.trim(), done: false, completedAt: null }]);
    setNewText('');
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const removeItem = (id: string) => {
    onUpdate(todos.filter(t => t.id !== id));
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  };

  return (
    <View style={styles.container}>
      {todos.map(t => (
        <Pressable key={t.id} onPress={() => toggle(t.id)} style={styles.item}>
          <View style={[styles.checkbox, t.done && styles.checkboxDone]}>
            {t.done && <Icon name="checkSquare" size={14} color={colors.green} />}
          </View>
          <Text style={[styles.itemText, t.done && styles.itemTextDone]} numberOfLines={2}>
            {t.text}
          </Text>
          {t.done && t.completedAt && (
            <Text style={styles.timestamp}>{formatTime(t.completedAt)}</Text>
          )}
          {editable && (
            <Pressable onPress={() => removeItem(t.id)} hitSlop={8} style={styles.removeBtn}>
              <Icon name="x" size={12} color={colors.textDimmer} />
            </Pressable>
          )}
        </Pressable>
      ))}
      {editable && (
        <View style={styles.addRow}>
          <View style={styles.checkboxPlaceholder} />
          <TextInput
            ref={inputRef}
            value={newText}
            onChangeText={setNewText}
            onSubmitEditing={addItem}
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
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
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
  itemText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.text,
  },
  itemTextDone: {
    color: colors.textDim,
    textDecorationLine: 'line-through',
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
