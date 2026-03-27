import { useState, useCallback, useEffect } from 'react';
import { View, Pressable, Text, TextInput, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { colors, fonts } from '../../src/constants/theme';
import { CAPTURE_TYPES } from '../../src/constants/captureTypes';
import { Icon } from '../../src/components/ui/Icon';
import { HomeHeader } from '../../src/components/home/HomeHeader';
import { TimelineList } from '../../src/components/timeline/TimelineList';
import { CaptureSheet } from '../../src/components/capture/CaptureSheet';
import { useEntries } from '../../src/hooks/useEntries';
import { useHabits } from '../../src/hooks/useHabits';
import { useDayTitle } from '../../src/hooks/useDayTitle';
import { formatDate } from '../../src/utils/time';
import { recordClip } from '../../src/services/fileManager';
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

  // Reload entries when screen regains focus
  useFocusEffect(
    useCallback(() => {
      reload();
      reloadTitle();
    }, [reload, reloadTitle])
  );

  // Reload entries and title when sync completes
  useEffect(() => {
    return onSyncComplete(() => {
      reload();
      reloadTitle();
    });
  }, [onSyncComplete, reload, reloadTitle]);
  const [showCapture, setShowCapture] = useState(false);
  const [captureType, setCaptureType] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<Entry | null>(null);

  const handleCapture = (type: string) => {
    setCaptureType(type);
    setEditingEntry(null);
    setShowCapture(true);
  };

  const handleEdit = (entry: Entry) => {
    setEditingEntry(entry);
    setCaptureType(null);
    setShowCapture(true);
  };

  const handleCloseSheet = () => {
    setShowCapture(false);
    setCaptureType(null);
    setEditingEntry(null);
  };

  const handleSave = (entry: Entry) => {
    if (editingEntry) {
      editEntry(entry);
    } else {
      addEntry(entry);
    }
    handleCloseSheet();
  };

  const handleDelete = (id: string) => {
    removeEntry(id);
    handleCloseSheet();
  };

  const [recording, setRecording] = useState(false);
  const handleQuickRecord = async () => {
    if (recording) return;
    setRecording(true);
    try {
      const result = await recordClip(date);
      if (result) {
        const entry: Entry = {
          id: generateId('entry'),
          date,
          type: 'video',
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
      }
    } catch (err) {
      console.warn('[loopd] Quick record failed:', err);
    } finally {
      setRecording(false);
    }
  };

  return (
    <View style={styles.container}>
      <HomeHeader
        dayStarted={false}
        dateLabel=""
        entries={entries}
        habits={habits}
        onBack={() => router.push('/')}
      />

      <View style={styles.titleRow}>
        <TextInput
          value={dayTitle}
          onChangeText={setDayTitle}
          placeholder="Untitled day"
          placeholderTextColor={colors.textDimmer}
          style={styles.titleInput}
        />
        <Text style={styles.dateText}>{formatDate(new Date(date + 'T12:00:00'))}</Text>
        {/* Habit streak */}
        {habits.length > 0 && (
          <View style={styles.habitStreak}>
            {habits.map(h => {
              const checked = entries.some(e => e.type === 'habit' && e.habits.includes(h.id));
              return (
                <View key={h.id} style={styles.habitChip}>
                  <View style={[styles.habitDot, { backgroundColor: checked ? colors.green : colors.textDimmer }]} />
                  <Text style={[styles.habitLabel, { color: checked ? colors.green : colors.textDim }]}>{h.label}</Text>
                </View>
              );
            })}
          </View>
        )}
      </View>

      <TimelineList
        entries={entries}
        habits={habits}
        onEditEntry={handleEdit}
      />

      <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 16) + 10 }]}>
        <View style={styles.captureRow}>
          {/* Journal */}
          <Pressable onPress={() => handleCapture('journal')} style={styles.captureBtn}>
            <Icon name="penLine" size={18} color={colors.textMuted} />
            <Text style={styles.captureLabel}>Journal</Text>
          </Pressable>
          {/* Habit */}
          <Pressable onPress={() => handleCapture('habit')} style={styles.captureBtn}>
            <Icon name="checkSquare" size={18} color={colors.textMuted} />
            <Text style={styles.captureLabel}>Habit</Text>
          </Pressable>
          {/* Record — center */}
          <Pressable onPress={handleQuickRecord} style={styles.captureBtn} disabled={recording}>
            <Icon name="camera" size={18} color={recording ? colors.textDim : colors.coral} />
            <Text style={[styles.captureLabel, { color: colors.coral }]}>Record</Text>
          </Pressable>
          {/* Clip */}
          <Pressable onPress={() => handleCapture('video')} style={styles.captureBtn}>
            <Icon name="video" size={18} color={colors.textMuted} />
            <Text style={styles.captureLabel}>Clip</Text>
          </Pressable>
          {/* Edit */}
          <Pressable onPress={() => router.push(`/editor/${date}`)} style={styles.captureBtn}>
            <Icon name="film" size={18} color={colors.accent2} />
            <Text style={[styles.captureLabel, { color: colors.accent2 }]}>Edit</Text>
          </Pressable>
        </View>
      </View>

      <CaptureSheet
        visible={showCapture}
        initialType={captureType}
        editEntry={editingEntry}
        habits={habits}
        date={date}
        onClose={handleCloseSheet}
        onSave={handleSave}
        onDelete={handleDelete}
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
  habitStreak: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 8,
    justifyContent: 'center',
  },
  habitChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  habitDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  habitLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingTop: 6,
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  },
  captureRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  recordWrap: {
    flex: 1,
    alignItems: 'center',
  },
  recordBtn: {
    paddingVertical: 10,
    alignItems: 'center',
    gap: 4,
  },
  captureBtn: {
    flex: 1,
    paddingVertical: 6,
    alignItems: 'center',
    gap: 3,
  },
  captureLabel: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: colors.textDim,
  },
});
