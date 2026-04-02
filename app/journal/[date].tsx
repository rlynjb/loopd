import { useState, useCallback, useEffect, useRef } from 'react';
import { View, Pressable, Text, TextInput, ScrollView, Keyboard, KeyboardAvoidingView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../../src/constants/theme';
import { HomeHeader } from '../../src/components/home/HomeHeader';
import { InlineEntry } from '../../src/components/journal/InlineEntry';
import { InlineTextInput } from '../../src/components/journal/InlineTextInput';
import { JournalToolbar } from '../../src/components/journal/JournalToolbar';
import { useEntries } from '../../src/hooks/useEntries';
import { useHabits } from '../../src/hooks/useHabits';
import { useDayTitle } from '../../src/hooks/useDayTitle';
import { formatDate } from '../../src/utils/time';
import { generateId } from '../../src/utils/id';
import { useNotionSync } from '../../src/hooks/useNotionSync';
import type { Entry } from '../../src/types/entry';

export default function JournalScreen() {
  const { date } = useLocalSearchParams<{ date: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { entries, addEntry, editEntry, removeEntry, reload } = useEntries(date);
  const habits = useHabits();
  const { title: dayTitle, updateTitle: setDayTitle, reload: reloadTitle } = useDayTitle(date);
  const { onSyncComplete } = useNotionSync();

  const [isAddingText, setIsAddingText] = useState(false);
  const [editingEntry, setEditingEntry] = useState<Entry | null>(null);
  const [toolbarExpanded, setToolbarExpanded] = useState<'habit' | null>(null);

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

  const sorted = [...entries].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const handleTapEmptySpace = () => {
    if (!isAddingText) {
      setEditingEntry(null);
      setToolbarExpanded(null);
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

  const handleTapToEdit = (entry: Entry) => {
    // Only inline-edit pure text entries (no clips, no habits)
    if (entry.clips.length > 0 || entry.habits.length > 0) return;
    setIsAddingText(false);
    setEditingEntry(entry);
  };

  const handleEditTextSave = async (text: string) => {
    if (editingEntry) {
      await editEntry({ ...editingEntry, text });
      setEditingEntry(null);
    }
  };

  // Habits already logged today
  const alreadyLoggedHabits = [...new Set(entries.flatMap(e => e.habits))];

  const handleToggleHabit = (habitId: string, checked: boolean) => {
    if (checked) {
      // Add a new habit entry for this habit
      const entry: Entry = {
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
      };
      addEntry(entry);
    } else {
      // Remove the habit entry that contains this habit
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

  const handleSaveClip = (result: { uri: string; durationMs: number }) => {
    const entry: Entry = {
      id: generateId('entry'),
      date,
      text: null,
      mood: null,
      category: null,
      habits: [],
      clipUri: result.uri,
      clipDurationMs: result.durationMs,
      clips: [{ uri: result.uri, durationMs: result.durationMs }],
      createdAt: new Date().toISOString(),
    };
    addEntry(entry);
  };

  const handleEditDone = (updated: Entry) => {
    editEntry(updated);
    setEditingEntry(null);
    setToolbarExpanded(null);
  };

  const dismissAll = () => {
    Keyboard.dismiss();
    setToolbarExpanded(null);
  };

  return (
    <Pressable style={styles.container} onPress={dismissAll}>
      <HomeHeader
        dayStarted={false}
        dateLabel=""
        entries={entries}
        habits={habits}
        onBack={() => router.push('/')}
      />

      {/* Title + Date */}
      <View style={styles.titleRow}>
        <TextInput
          value={dayTitle}
          onChangeText={setDayTitle}
          placeholder="Untitled day"
          placeholderTextColor={colors.textDimmer}
          style={styles.titleInput}
        />
        <Text style={styles.dateText}>{formatDate(new Date(date + 'T12:00:00'))}</Text>
      </View>

      {/* Entries */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        onScrollBeginDrag={() => {
          if (toolbarExpanded) setToolbarExpanded(null);
        }}
      >
        {sorted.map(entry => (
          editingEntry?.id === entry.id ? (
            <View key={entry.id} style={{ marginBottom: 16 }}>
              <Text style={styles.entryTime}>
                {new Date(entry.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
              </Text>
              <InlineTextInput
                initialValue={entry.text ?? ''}
                onSave={handleEditTextSave}
                onCancel={() => setEditingEntry(null)}
              />
            </View>
          ) : (
            <InlineEntry
              key={entry.id}
              entry={entry}
              habits={habits}
              onTapToEdit={handleTapToEdit}
            />
          )
        ))}

        {/* Add new text entry */}
        {isAddingText ? (
          <InlineTextInput
            onSave={handleSaveNewText}
            onCancel={handleCancelNewText}
          />
        ) : (
          <Pressable onPress={handleTapEmptySpace} style={styles.emptyTap}>
            <Text style={styles.emptyTapText}>Tap to write...</Text>
          </Pressable>
        )}
      </ScrollView>
      </KeyboardAvoidingView>

      {/* Journal toolbar */}
      <JournalToolbar
        date={date}
        habits={habits}
        expanded={toolbarExpanded}
        onExpand={setToolbarExpanded}
        alreadyLoggedHabits={alreadyLoggedHabits}
        onToggleHabit={handleToggleHabit}
        onSaveClip={handleSaveClip}
        editingEntry={editingEntry}
        onEditDone={handleEditDone}
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
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 4,
    alignItems: 'center',
  },
  titleInput: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.text,
    padding: 0,
    letterSpacing: -0.3,
    textAlign: 'center',
    width: '100%',
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
  emptyTapText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.textDimmer,
  },
});
