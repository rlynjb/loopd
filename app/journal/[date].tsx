import { useState, useCallback, useEffect, useRef } from 'react';
import { View, Pressable, Text, TextInput, ScrollView, Keyboard, KeyboardAvoidingView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../../src/constants/theme';
import { HomeHeader } from '../../src/components/home/HomeHeader';
import { Icon } from '../../src/components/ui/Icon';
import { InlineEntry } from '../../src/components/journal/InlineEntry';
import { InlineTextInput } from '../../src/components/journal/InlineTextInput';
import { InlineTodoList } from '../../src/components/journal/InlineTodoList';
import { KeyboardToolbar } from '../../src/components/journal/KeyboardToolbar';
import { useEntries } from '../../src/hooks/useEntries';
import { useHabits } from '../../src/hooks/useHabits';
import { useDayTitle } from '../../src/hooks/useDayTitle';
import { formatDate } from '../../src/utils/time';
import { generateId } from '../../src/utils/id';
import { updateEntry as updateEntryDB } from '../../src/services/database';
import { pickAndCopyClip } from '../../src/services/fileManager';
import { useNotionSync } from '../../src/hooks/useNotionSync';
import { on } from '../../src/utils/events';
import type { Entry } from '../../src/types/entry';

export default function JournalScreen() {
  const { date, showHabits } = useLocalSearchParams<{ date: string; showHabits?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { entries, addEntry, editEntry, removeEntry, reload } = useEntries(date);
  const habits = useHabits();
  const { title: dayTitle, updateTitle: setDayTitle, reload: reloadTitle } = useDayTitle(date);
  const { onSyncComplete } = useNotionSync();

  const [isAddingText, setIsAddingText] = useState(false);
  const [editingEntry, setEditingEntry] = useState<Entry | null>(null);
  const [showHabitPicker, setShowHabitPicker] = useState(showHabits === '1');

  useEffect(() => {
    return on('toggleHabitPicker', () => setShowHabitPicker(prev => !prev));
  }, []);

  // Reload on focus
  useFocusEffect(
    useCallback(() => {
      reload();
      reloadTitle();
    }, [reload, reloadTitle])
  );

  // Reload on sync complete
  useEffect(() => {
    return onSyncComplete(() => {
      reload();
      reloadTitle();
    });
  }, [onSyncComplete, reload, reloadTitle]);

  const sorted = [...entries]
    .filter(e => e.text || e.clips.length > 0 || e.habits.length > 0 || (e.todos?.length ?? 0) > 0)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const handleTapEmptySpace = async () => {
    if (!isAddingText) {
      // Save pending edits first
      const current = editingEntryRef.current;
      if (current && liveTextRef.current.trim()) {
        await editEntry({ ...current, text: liveTextRef.current.trim() });
      }
      liveTextRef.current = '';
      setEditingEntry(null);
      setShowHabitPicker(false);
      setIsAddingText(true);
    }
  };

  const handleSaveNewText = useCallback((text: string) => {
    addEntry({
      id: generateId('entry'),
      date,
      text,
      mood: null,
      category: null,
      habits: [],
      todos: [],
      clipUri: null,
      clipDurationMs: null,
      clips: [],
      createdAt: new Date().toISOString(),
    });
    setIsAddingText(false);
  }, [date, addEntry]);

  const handleCancelNewText = useCallback(() => {
    setIsAddingText(false);
  }, []);

  const justTappedEntry = useRef(false);
  const liveTextRef = useRef('');

  const handleTapToEdit = (entry: Entry) => {
    justTappedEntry.current = true;
    liveTextRef.current = entry.text ?? '';
    setIsAddingText(false);
    setEditingEntry(entry);
  };

  const editingEntryRef = useRef(editingEntry);
  editingEntryRef.current = editingEntry;

  // Silent save — DB only, no state update, no re-render
  const handleEditTextSilent = useCallback(async (text: string) => {
    const current = editingEntryRef.current;
    if (current) {
      await updateEntryDB({ ...current, text });
    }
  }, []);

  const handleAddClipToEntry = useCallback(async (entry: Entry) => {
    const result = await pickAndCopyClip(date);
    if (result) {
      await editEntry({
        ...entry,
        clips: [...entry.clips, { uri: result.uri, durationMs: result.durationMs }],
        clipUri: entry.clipUri ?? result.uri,
        clipDurationMs: entry.clipDurationMs ?? result.durationMs,
      });
    }
  }, [date, editEntry]);

  const handleUpdateTodos = useCallback(async (entry: Entry, todos: import('../../src/types/entry').TodoItem[]) => {
    await editEntry({ ...entry, todos });
  }, [editEntry]);

  const handleAddTodoEntry = useCallback(() => {
    const entry: Entry = {
      id: generateId('entry'),
      date,
      text: null,
      mood: null,
      category: null,
      habits: [],
      todos: [],
      clipUri: null,
      clipDurationMs: null,
      clips: [],
      createdAt: new Date().toISOString(),
    };
    addEntry(entry);
    setEditingEntry(entry);
  }, [date, addEntry]);

  const handleAddClipEntry = useCallback(async () => {
    const result = await pickAndCopyClip(date);
    if (result) {
      addEntry({
        id: generateId('entry'),
        date,
        text: null,
        mood: null,
        category: null,
        habits: [],
        todos: [],
        clipUri: result.uri,
        clipDurationMs: result.durationMs,
        clips: [{ uri: result.uri, durationMs: result.durationMs }],
        createdAt: new Date().toISOString(),
      });
    }
  }, [date, addEntry]);

  // Final save — updates state and clears editing
  const handleEditTextSave = useCallback(async (text: string) => {
    const current = editingEntryRef.current;
    if (current) {
      await editEntry({ ...current, text });
    }
  }, [editEntry]);

  const handleEditCancel = useCallback(() => {
    setEditingEntry(null);
  }, []);

  const alreadyLoggedHabits = [...new Set(entries.flatMap(e => e.habits))];

  const handleToggleHabit = (habitId: string, checked: boolean) => {
    if (checked) {
      addEntry({
        id: generateId('entry'),
        date,
        text: null,
        mood: null,
        category: null,
        habits: [habitId],
        clipUri: null,
        clipDurationMs: null,
        clips: [],
        createdAt: new Date().toISOString(),
      });
    } else {
      const habitEntry = entries.find(e => e.habits.includes(habitId));
      if (habitEntry) {
        if (habitEntry.habits.length === 1) {
          removeEntry(habitEntry.id);
        } else {
          editEntry({ ...habitEntry, habits: habitEntry.habits.filter(h => h !== habitId) });
        }
      }
    }
  };

  const dismissAll = async () => {
    if (justTappedEntry.current) {
      justTappedEntry.current = false;
      return;
    }
    // Save any pending text before dismissing
    const current = editingEntryRef.current;
    if (current && liveTextRef.current.trim()) {
      await editEntry({ ...current, text: liveTextRef.current.trim() });
    }
    if (current) {
      liveTextRef.current = '';
      setEditingEntry(null);
    }
    if (isAddingText && liveTextRef.current.trim()) {
      addEntry({
        id: generateId('entry'),
        date,
        text: liveTextRef.current.trim(),
        mood: null,
        category: null,
        habits: [],
        clipUri: null,
        clipDurationMs: null,
        clips: [],
        createdAt: new Date().toISOString(),
      });
      liveTextRef.current = '';
      setIsAddingText(false);
    }
    Keyboard.dismiss();
    setShowHabitPicker(false);
  };

  return (
    <Pressable style={styles.container} onPress={dismissAll}>
      <HomeHeader
        dayStarted={false}
        dateLabel=""
        entries={entries}
        habits={habits}
      />

      {/* Title + Date + Edit Vlog */}
      <View style={styles.titleRow}>
        <View style={styles.titleLeft}>
          <TextInput
            value={dayTitle}
            onChangeText={setDayTitle}
            placeholder="Untitled day"
            placeholderTextColor={colors.textDimmer}
            style={styles.titleInput}
          />
          <Text style={styles.dateText}>{formatDate(new Date(date + 'T12:00:00'))}</Text>
        </View>
        {entries.length > 0 && (
          <Pressable onPress={() => router.push(`/editor/${date}`)} style={styles.editVlogBtn}>
            <Icon name="clapperboard" size={16} color={colors.accent} />
          </Pressable>
        )}
      </View>

      {/* Entries */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="none"
        onScrollBeginDrag={() => {
        }}
      >
        {sorted.map(entry => (
          editingEntry?.id === entry.id ? (
            <View key={entry.id} style={{ marginBottom: 16 }}>
              <InlineEntry
                entry={{ ...entry, text: null, todos: [] }}
                habits={habits}
                onTapToEdit={() => {}}
                compact
              />
              <InlineTodoList
                todos={entry.todos ?? []}
                onUpdate={(todos) => handleUpdateTodos(entry, todos)}
                editable
              />
              <InlineTextInput
                initialValue={entry.text ?? ''}
                onSave={handleEditTextSave}
                onSilentSave={handleEditTextSilent}
                onCancel={handleEditCancel}
                liveTextRef={liveTextRef}
              />
            </View>
          ) : (
            <InlineEntry
              key={entry.id}
              entry={entry}
              habits={habits}
              onTapToEdit={handleTapToEdit}
              onAddClip={handleAddClipToEntry}
              onUpdateTodos={handleUpdateTodos}
            />
          )
        ))}

        {/* Add new text entry */}
        {isAddingText ? (
          <InlineTextInput
            onSave={handleSaveNewText}
            onCancel={handleCancelNewText}
            liveTextRef={liveTextRef}
          />
        ) : (
          <Pressable onPress={handleTapEmptySpace} style={styles.emptyTap}>
            <Text style={styles.emptyTapText}>Tap to write...</Text>
          </Pressable>
        )}

      </ScrollView>
      </KeyboardAvoidingView>

      {/* Keyboard toolbar — shows above keyboard when typing */}
      <KeyboardToolbar
        visible={isAddingText || !!editingEntry}
        actions={[
          { icon: 'checkSquare', label: 'Todo', onPress: handleAddTodoEntry },
          { icon: 'video', label: 'Clip', onPress: handleAddClipEntry },
          { icon: 'checkSquare', label: 'Habit', onPress: () => setShowHabitPicker(true) },
        ]}
        habits={habits}
        alreadyLoggedHabits={alreadyLoggedHabits}
        onToggleHabit={handleToggleHabit}
        showHabits={showHabitPicker}
        onShowHabits={setShowHabitPicker}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 4,
  },
  titleLeft: {
    flex: 1,
  },
  titleInput: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.text,
    padding: 0,
    letterSpacing: -0.3,
    textAlign: 'left',
  },
  dateText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
    marginTop: 4,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: GLOBAL_NAV_HEIGHT + 80,
  },
  entryTime: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    marginBottom: 4,
  },
  emptyTap: {
    minHeight: 200,
    paddingTop: 16,
  },
  editVlogBtn: {
    padding: 8,
  },
  emptyTapText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.textDimmer,
  },
});
