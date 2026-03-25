import { useState, useCallback } from 'react';
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
import type { Entry } from '../../src/types/entry';

export default function JournalScreen() {
  const { date } = useLocalSearchParams<{ date: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { entries, addEntry, editEntry, removeEntry, reload } = useEntries(date);
  const habits = useHabits();

  // Reload entries when screen regains focus (after sync, reimport, etc.)
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload])
  );
  const { title: dayTitle, updateTitle: setDayTitle } = useDayTitle(date);
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

  return (
    <View style={styles.container}>
      <HomeHeader
        dayStarted
        dateLabel={formatDate(new Date(date + 'T12:00:00'))}
        entries={entries}
        habits={habits}
        onBack={() => router.back()}
      />

      <View style={styles.titleRow}>
        <TextInput
          value={dayTitle}
          onChangeText={setDayTitle}
          placeholder="Untitled day"
          placeholderTextColor={colors.textDimmer}
          style={styles.titleInput}
        />
      </View>

      <TimelineList
        entries={entries}
        habits={habits}
        onEditEntry={handleEdit}
      />

      <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 16) + 10 }]}>
        <View style={styles.captureRow}>
          {CAPTURE_TYPES.map(ct => (
            <Pressable
              key={ct.id}
              onPress={() => handleCapture(ct.id)}
              style={styles.captureBtn}
            >
              <Icon name={ct.icon} size={20} color={colors.textMuted} />
              <Text style={styles.captureLabel}>{ct.label}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => router.push(`/editor/${date}`)} style={styles.closeBtn}>
            <Icon name="moon" size={20} color={colors.accent2} />
            <Text style={styles.closeLabel}>Close</Text>
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
    paddingTop: 8,
    paddingBottom: 4,
  },
  titleInput: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.text,
    padding: 0,
    letterSpacing: -0.3,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 14,
  },
  captureRow: {
    flexDirection: 'row',
    gap: 8,
  },
  captureBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: colors.radius,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
    gap: 4,
  },
  captureLabel: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: colors.textDim,
  },
  closeBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: colors.radius,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: `${colors.accent2}40`,
    alignItems: 'center',
    gap: 4,
  },
  closeLabel: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: colors.accent2,
  },
});
