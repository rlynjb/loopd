import { useState, useCallback, useEffect, useRef } from 'react';
import { View, Pressable, Text, TextInput, ScrollView, Keyboard, KeyboardAvoidingView, StyleSheet, Alert } from 'react-native';
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
import { updateEntry as updateEntryDB, deleteEmptyEntries } from '../../src/services/database';
import { pickVideoAssets, captureToProxy, TranscodeCancelledError, DiskFullError, type TranscodeHandle } from '../../src/services/fileManager';
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
  // Per-entry in-flight clip transcodes. Tracked by id so each placeholder
  // can individually cancel the running FFmpeg session (tapping the spinner).
  type PendingClip = { pendingId: string; cancel: () => void };
  const [pendingByEntry, setPendingByEntry] = useState<Record<string, PendingClip[]>>({});

  const addPending = useCallback((entryId: string, pending: PendingClip) => {
    setPendingByEntry(prev => ({
      ...prev,
      [entryId]: [...(prev[entryId] ?? []), pending],
    }));
  }, []);

  const removePending = useCallback((entryId: string, pendingId: string) => {
    setPendingByEntry(prev => {
      const list = (prev[entryId] ?? []).filter(p => p.pendingId !== pendingId);
      const copy = { ...prev };
      if (list.length === 0) delete copy[entryId];
      else copy[entryId] = list;
      return copy;
    });
  }, []);

  const cancelPending = useCallback((entryId: string, pendingId: string) => {
    setPendingByEntry(prev => {
      const list = prev[entryId] ?? [];
      const target = list.find(p => p.pendingId === pendingId);
      target?.cancel();
      const next = list.filter(p => p.pendingId !== pendingId);
      const copy = { ...prev };
      if (next.length === 0) delete copy[entryId];
      else copy[entryId] = next;
      return copy;
    });
  }, []);

  useEffect(() => {
    return on('toggleHabitPicker', () => setShowHabitPicker(prev => !prev));
  }, []);


  const isAddingTextRef = useRef(isAddingText);
  isAddingTextRef.current = isAddingText;

  // Reload on focus, save on blur. Also purge truly-empty entries (no text,
  // no habits, no todos, no clips) left behind by interrupted adds.
  useFocusEffect(
    useCallback(() => {
      deleteEmptyEntries().then(() => reload()).catch(() => reload());
      reloadTitle();
      return () => {
        // Save pending text when navigating away
        console.log('[focus cleanup]', { editing: !!editingEntryRef.current, isAdding: isAddingTextRef.current, liveText: liveTextRef.current });
        const current = editingEntryRef.current;
        if (current && liveTextRef.current.trim()) {
          editEntry({ ...current, text: liveTextRef.current.trim() });
        } else if (isAddingTextRef.current && liveTextRef.current.trim() && !newEntryIdRef.current) {
          // Only create new entry if silent save hasn't already created one
          addEntry({
            id: generateId('entry'),
            date,
            text: liveTextRef.current.trim(),
      
                       habits: [],
            todos: [],
            clipUri: null,
            clipDurationMs: null,
            clips: [],
            createdAt: new Date().toISOString(),
          });
        }
        newEntryIdRef.current = null;
      };
    }, [reload, reloadTitle, date, editEntry, addEntry])
  );

  // Reload on sync complete
  useEffect(() => {
    return onSyncComplete(() => {
      reload();
      reloadTitle();
    });
  }, [onSyncComplete, reload, reloadTitle]);

  // Hide todos-only entries — the dashboard's TODOS add flow funnels into a
  // shared bucket entry per day, and those shouldn't clutter the journal
  // timeline. Todos added inline from a journal entry (text + todos together)
  // still render normally since the entry has other content too.
  const sorted = [...entries]
    .filter(e => {
      const onlyTodos = (e.todos?.length ?? 0) > 0
        && !e.text
        && e.clips.length === 0
        && !e.clipUri
        && e.habits.length === 0;
      return !onlyTodos;
    })
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const handleTapEmptySpace = async () => {
    if (!isAddingText) {
      // Save or delete pending edits first
      const current = editingEntryRef.current;
      if (current) {
        const newText = liveTextRef.current.trim() || null;
        await editEntry({ ...current, text: newText });
      }
      liveTextRef.current = '';
      setEditingEntry(null);
      editingEntryRef.current = null;
      setShowHabitPicker(false);
      setShowTodoInput(false);
      setIsAddingText(true);
    }
  };

  const newEntryIdRef = useRef<string | null>(null);

  const handleSaveNewText = useCallback((text: string) => {
    if (!text) return;
    const id = generateId('entry');
    addEntry({
      id,
      date,
      text,

           habits: [],
      todos: [],
      clipUri: null,
      clipDurationMs: null,
      clips: [],
      createdAt: new Date().toISOString(),
    });
    setIsAddingText(false);
  }, [date, addEntry]);

  // Silent save for new text — creates on first call, updates on subsequent
  const handleSilentNewText = useCallback(async (text: string) => {
    if (!text) return;
    if (newEntryIdRef.current) {
      await updateEntryDB({ id: newEntryIdRef.current, date, text, habits: [], todos: [], clipUri: null, clipDurationMs: null, clips: [], createdAt: '' } as Entry);
    } else {
      const id = generateId('entry');
      newEntryIdRef.current = id;
      const { insertEntry } = await import('../../src/services/database');
      await insertEntry({ id, date, text, habits: [], todos: [], clipUri: null, clipDurationMs: null, clips: [], createdAt: new Date().toISOString() });
    }
  }, [date]);

  const handleCancelNewText = useCallback(() => {
    newEntryIdRef.current = null;
    setIsAddingText(false);
  }, []);

  const handleAutoCommitNewText = useCallback(async () => {
    console.log('[autoCommitNew]', { entryId: newEntryIdRef.current, liveText: liveTextRef.current });
    const entryId = newEntryIdRef.current;
    if (entryId) {
      newEntryIdRef.current = null;
      setIsAddingText(false);
      await reload();
      const { getEntryById } = await import('../../src/services/database');
      const entry = await getEntryById(entryId);
      if (entry) {
        // Has content — exit edit mode, dismiss keyboard
        liveTextRef.current = '';
        setEditingEntry(null);
        editingEntryRef.current = null;
        Keyboard.dismiss();
      }
    } else {
      // Nothing was typed — just close
      setIsAddingText(false);
      Keyboard.dismiss();
    }
  }, [reload]);

  const justTappedEntry = useRef(false);
  const liveTextRef = useRef('');

  const handleTapToEdit = async (entry: Entry) => {
    justTappedEntry.current = true;
    // Save previous editing entry
    const prev = editingEntryRef.current;
    if (prev && liveTextRef.current !== (prev.text ?? '')) {
      const newText = liveTextRef.current.trim() || null;
      await editEntry({ ...prev, text: newText });
    }
    // If was adding new text, the silent save already saved to DB — reload to show it
    if (isAddingText && newEntryIdRef.current) {
      newEntryIdRef.current = null;
      await reload();
    }
    liveTextRef.current = entry.text ?? '';
    setIsAddingText(false);
    setShowTodoInput(false);
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
    const assets = await pickVideoAssets(true);
    if (!assets) return;

    // Start all transcodes in parallel (capped by fileManager's FFmpeg queue),
    // but commit results in the order the user picked them. If clip 2 finishes
    // before clip 1, its result waits on tasks[0] before writing to the entry.
    type Outcome =
      | { status: 'done'; result: { uri: string; durationMs: number } }
      | { status: 'failed'; error: unknown };
    const tasks: Promise<Outcome>[] = assets.map(asset => {
      const pendingId = generateId('pending');
      const handleRef: { current: TranscodeHandle | null } = { current: null };
      addPending(entry.id, {
        pendingId,
        cancel: () => handleRef.current?.cancel(),
      });
      return captureToProxy(asset, h => { handleRef.current = h; })
        .then((result): Outcome => ({ status: 'done', result }))
        .catch((error): Outcome => ({ status: 'failed', error }))
        .finally(() => removePending(entry.id, pendingId));
    });

    (async () => {
      const { getEntryById } = await import('../../src/services/database');
      for (const task of tasks) {
        const outcome = await task;
        if (outcome.status === 'failed') {
          if (outcome.error instanceof TranscodeCancelledError) continue;
          if (outcome.error instanceof DiskFullError) Alert.alert('Out of storage', outcome.error.message);
          else console.warn('[loopd] clip transcode failed:', outcome.error);
          continue;
        }
        const current = await getEntryById(entry.id);
        if (!current) continue;
        const updated = {
          ...current,
          clips: [...current.clips, { uri: outcome.result.uri, durationMs: outcome.result.durationMs }],
          clipUri: current.clipUri ?? outcome.result.uri,
          clipDurationMs: current.clipDurationMs ?? outcome.result.durationMs,
        };
        await editEntry(updated);
        if (editingEntryRef.current?.id === entry.id) {
          setEditingEntry(updated);
          editingEntryRef.current = updated;
        }
      }
    })();
  }, [editEntry, addPending, removePending]);

  const handleRemoveHabitFromEntry = useCallback(async (entry: Entry, habitId: string) => {
    const currentText = editingEntryRef.current?.id === entry.id ? (liveTextRef.current.trim() || entry.text) : entry.text;
    const updated = {
      ...entry,
      text: currentText,
      habits: entry.habits.filter(h => h !== habitId),
    };
    await editEntry(updated);
    // Update editingEntry ref so focus cleanup doesn't re-save stale data
    if (editingEntryRef.current?.id === entry.id) {
      setEditingEntry(updated);
      editingEntryRef.current = updated;
    }
  }, [editEntry]);

  const handleRemoveClipFromEntry = useCallback(async (entry: Entry, clipIndex: number) => {
    const currentText = editingEntryRef.current?.id === entry.id ? (liveTextRef.current.trim() || entry.text) : entry.text;
    const newClips = entry.clips.filter((_, i) => i !== clipIndex);
    const updated = {
      ...entry,
      text: currentText,
      clips: newClips,
      clipUri: newClips[0]?.uri ?? null,
      clipDurationMs: newClips[0]?.durationMs ?? null,
    };
    await editEntry(updated);
    if (editingEntryRef.current?.id === entry.id) {
      setEditingEntry(updated);
      editingEntryRef.current = updated;
    }
  }, [editEntry]);

  const handleUpdateTodos = useCallback(async (entry: Entry, todos: import('../../src/types/entry').TodoItem[]) => {
    const updated = { ...entry, todos };
    await editEntry(updated);
    if (editingEntryRef.current?.id === entry.id) {
      setEditingEntry(updated);
      editingEntryRef.current = updated;
    }
  }, [editEntry]);

  const [showTodoInput, setShowTodoInput] = useState(false);

  const handleAddTodoEntry = useCallback(() => {
    setShowTodoInput(true);
  }, []);

  const handleAddClipEntry = useCallback(async () => {
    // Target: current editing entry OR the silently-saved new entry
    let targetId = editingEntryRef.current?.id ?? newEntryIdRef.current ?? null;
    // Save pending text first
    if (targetId && liveTextRef.current.trim()) {
      const { getEntryById } = await import('../../src/services/database');
      const existing = await getEntryById(targetId);
      if (existing) {
        await updateEntryDB({ ...existing, text: liveTextRef.current.trim() });
      }
    }
    const assets = await pickVideoAssets(true);
    if (!assets) return;

    // Make sure we have a target entry so the placeholder cards have somewhere
    // to render. If no entry exists yet (new-entry flow from the toolbar),
    // create one with whatever text is in flight.
    if (!targetId) {
      const stub: Entry = {
        id: generateId('entry'),
        date,
        text: liveTextRef.current.trim() || null,
        habits: [],
        todos: [],
        clipUri: null,
        clipDurationMs: null,
        clips: [],
        createdAt: new Date().toISOString(),
      };
      addEntry(stub);
      setEditingEntry(stub);
      editingEntryRef.current = stub;
      newEntryIdRef.current = stub.id;
      targetId = stub.id;
    }
    const entryId = targetId;
    setIsAddingText(false);

    // See handleAddClipToEntry for the parallel-transcode / in-order-commit
    // pattern used here.
    type Outcome =
      | { status: 'done'; result: { uri: string; durationMs: number } }
      | { status: 'failed'; error: unknown };
    const tasks: Promise<Outcome>[] = assets.map(asset => {
      const pendingId = generateId('pending');
      const handleRef: { current: TranscodeHandle | null } = { current: null };
      addPending(entryId, {
        pendingId,
        cancel: () => handleRef.current?.cancel(),
      });
      return captureToProxy(asset, h => { handleRef.current = h; })
        .then((result): Outcome => ({ status: 'done', result }))
        .catch((error): Outcome => ({ status: 'failed', error }))
        .finally(() => removePending(entryId, pendingId));
    });

    (async () => {
      const { getEntryById } = await import('../../src/services/database');
      for (const task of tasks) {
        const outcome = await task;
        if (outcome.status === 'failed') {
          if (outcome.error instanceof TranscodeCancelledError) continue;
          if (outcome.error instanceof DiskFullError) Alert.alert('Out of storage', outcome.error.message);
          else console.warn('[loopd] clip transcode failed:', outcome.error);
          continue;
        }
        const current = await getEntryById(entryId);
        if (!current) continue;
        const updated = {
          ...current,
          clips: [...current.clips, { uri: outcome.result.uri, durationMs: outcome.result.durationMs }],
          clipUri: current.clipUri ?? outcome.result.uri,
          clipDurationMs: current.clipDurationMs ?? outcome.result.durationMs,
        };
        await editEntry(updated);
        if (editingEntryRef.current?.id === entryId) {
          setEditingEntry(updated);
          editingEntryRef.current = updated;
        }
        newEntryIdRef.current = null;
      }
    })();
  }, [date, addEntry, editEntry, addPending, removePending]);

  // Final save — updates state and clears editing
  const handleEditTextSave = useCallback(async (text: string) => {
    const current = editingEntryRef.current;
    if (current) {
      await editEntry({ ...current, text });
    }
  }, [editEntry]);

  const handleEditCancel = useCallback(() => {
    setEditingEntry(null);
    setShowTodoInput(false);
  }, []);

  const handleAutoCommitEdit = useCallback(async () => {
    const current = editingEntryRef.current;
    if (!current) return;
    // Read latest from DB — liveTextRef might be stale after focus changes
    const { getEntryById } = await import('../../src/services/database');
    const dbEntry = await getEntryById(current.id);
    const liveText = liveTextRef.current.trim() || null;
    // Use whichever has text — live text or DB text
    const text = liveText || dbEntry?.text || null;
    const clips = dbEntry?.clips ?? current.clips;
    const habits = dbEntry?.habits ?? current.habits;
    const todos = dbEntry?.todos ?? current.todos;
    const hasContent = text || clips.length > 0 || habits.length > 0 || (todos?.length ?? 0) > 0;
    if (!hasContent) {
      removeEntry(current.id);
    } else if (liveText) {
      await editEntry({ ...current, text: liveText });
    }
    liveTextRef.current = '';
    setEditingEntry(null);
    editingEntryRef.current = null;
    setShowTodoInput(false);
    Keyboard.dismiss();
  }, [editEntry, removeEntry]);

  const alreadyLoggedHabits = [...new Set(entries.flatMap(e => e.habits))];

  const handleToggleHabit = async (habitId: string, checked: boolean) => {
    let current = editingEntryRef.current;

    // If adding new text, create the entry first so habit goes on the same entry
    if (!current && isAddingTextRef.current) {
      const id = newEntryIdRef.current || generateId('entry');
      const text = liveTextRef.current.trim() || null;
      const entry: Entry = {
        id, date, text,        habits: [], todos: [],
        clipUri: null, clipDurationMs: null, clips: [],
        createdAt: new Date().toISOString(),
      };
      if (newEntryIdRef.current) {
        // Already in DB from silent save — update it
        await editEntry(entry);
      } else {
        newEntryIdRef.current = id;
        await addEntry(entry);
      }
      setIsAddingText(false);
      setEditingEntry(entry);
      editingEntryRef.current = entry;
      current = entry;
    }

    if (current) {
      const habits = checked
        ? [...current.habits, habitId]
        : current.habits.filter(h => h !== habitId);
      const updated = { ...current, habits };
      await editEntry(updated);
      setEditingEntry(updated);
      editingEntryRef.current = updated;
      return;
    }
    if (checked) {
      addEntry({
        id: generateId('entry'),
        date,
        text: null,
  
               habits: [habitId],
        todos: [],
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
    if (current) {
      const newText = liveTextRef.current.trim() || null;
      await editEntry({ ...current, text: newText });
      liveTextRef.current = '';
      setEditingEntry(null);
    }
    if (isAddingText) {
      // Silent save already saved to DB — just reload to show it
      if (newEntryIdRef.current) {
        newEntryIdRef.current = null;
        await reload();
      } else if (liveTextRef.current.trim()) {
        addEntry({
          id: generateId('entry'),
          date,
          text: liveTextRef.current.trim(),
    
                   habits: [],
          todos: [],
          clipUri: null,
          clipDurationMs: null,
          clips: [],
          createdAt: new Date().toISOString(),
        });
      }
      liveTextRef.current = '';
      setIsAddingText(false);
    }
    Keyboard.dismiss();
    setShowHabitPicker(false);
    setShowTodoInput(false);
  };

  return (
    <View style={styles.container}>
      <Pressable onPress={dismissAll}>
        <HomeHeader
          dayStarted={false}
          dateLabel=""
          entries={entries}
          habits={habits}
        />
      </Pressable>

      {/* Title + Date */}
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
        {entries.some(e => e.clips.length > 0) && (
          <Pressable onPress={() => router.push(`/editor/${date}`)} style={styles.vlogBtn} hitSlop={12}>
            <Icon name="clapperboard" size={22} color={colors.accent} />
            <Text style={styles.vlogBtnText}>Vlog</Text>
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
            <View key={entry.id} style={styles.editingEntry}>
              <Text style={styles.editingTime}>
                {new Date(entry.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
              </Text>
              <InlineTextInput
                initialValue={entry.text ?? ''}
                onSave={handleEditTextSave}
                onSilentSave={handleEditTextSilent}
                onCancel={handleEditCancel}
                liveTextRef={liveTextRef}
              />
              {(showTodoInput || (entry.todos && entry.todos.length > 0)) && (
                <InlineTodoList
                  todos={entry.todos ?? []}
                  onUpdate={(todos) => handleUpdateTodos(entry, todos)}
                  editable
                />
              )}
              <InlineEntry
                entry={{ ...entry, text: null, todos: [] }}
                habits={habits}
                onTapToEdit={() => {}}
                onAddClip={handleAddClipToEntry}
                onRemoveClip={handleRemoveClipFromEntry}
                onRemoveHabit={handleRemoveHabitFromEntry}
                pendingClips={pendingByEntry[entry.id] ?? []}
                onCancelPending={pid => cancelPending(entry.id, pid)}
                compact
              />
            </View>
          ) : (
            <InlineEntry
              key={entry.id}
              entry={entry}
              habits={habits}
              onTapToEdit={handleTapToEdit}
              onAddClip={handleAddClipToEntry}
              onRemoveClip={handleRemoveClipFromEntry}
              onRemoveHabit={handleRemoveHabitFromEntry}
              onUpdateTodos={handleUpdateTodos}
              pendingClips={pendingByEntry[entry.id] ?? []}
              onCancelPending={pid => cancelPending(entry.id, pid)}
            />
          )
        ))}

        {/* Add new text entry */}
        {isAddingText ? (
          <InlineTextInput
            onSave={handleSaveNewText}
            onSilentSave={handleSilentNewText}
            onCancel={handleCancelNewText}
            onAutoCommit={handleAutoCommitNewText}
            liveTextRef={liveTextRef}
          />
        ) : (
          <Pressable onPress={handleTapEmptySpace} style={styles.emptyTap}>
            <Text style={styles.emptyTapText}>Write something...</Text>
          </Pressable>
        )}

      </ScrollView>
      </KeyboardAvoidingView>

      {/* Keyboard toolbar — outside Pressable so taps aren't intercepted */}
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
    </View>
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
  editingEntry: {
    marginBottom: 24,
    paddingBottom: 24,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  editingTime: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.accent,
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
  vlogBtn: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingTop: 2,
  },
  vlogBtnText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.accent,
  },
});
