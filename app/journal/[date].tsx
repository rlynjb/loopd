import { useState } from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { colors, fonts } from '../../src/constants/theme';
import { CAPTURE_TYPES } from '../../src/constants/captureTypes';
import { Icon } from '../../src/components/ui/Icon';
import { HomeHeader } from '../../src/components/home/HomeHeader';
import { TimelineList } from '../../src/components/timeline/TimelineList';
import { CaptureSheet } from '../../src/components/capture/CaptureSheet';
import { EditEntrySheet } from '../../src/components/capture/EditEntrySheet';
import { GlowOrb } from '../../src/components/ui/GlowOrb';
import { useEntries } from '../../src/hooks/useEntries';
import { useHabits } from '../../src/hooks/useHabits';
import { formatDate } from '../../src/utils/time';
import type { Entry } from '../../src/types/entry';

export default function JournalScreen() {
  const { date } = useLocalSearchParams<{ date: string }>();
  const router = useRouter();
  const { entries, addEntry, editEntry, removeEntry } = useEntries(date);
  const habits = useHabits();
  const [showCapture, setShowCapture] = useState(false);
  const [captureType, setCaptureType] = useState<string | null>(null);
  const [editingEntry, setEditingEntry] = useState<Entry | null>(null);

  const handleCapture = (type: string) => {
    setCaptureType(type);
    setShowCapture(true);
  };

  const handleCloseDay = () => {
    router.push(`/editor/${date}`);
  };

  return (
    <View style={styles.container}>
      <GlowOrb color={colors.accent2} size={300} top={50} left={-80} opacity={0.05} />
      <GlowOrb color={colors.green} size={250} top={300} left={250} opacity={0.04} />

      <HomeHeader
        dayStarted
        dateLabel={formatDate(new Date(date + 'T12:00:00'))}
        entries={entries}
        habits={habits}
        onBack={() => router.back()}
      />

      <TimelineList
        entries={entries}
        habits={habits}
        onEditEntry={entry => setEditingEntry(entry)}
      />

      {/* Bottom capture bar */}
      <View style={styles.bottomBar}>
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
          <Pressable onPress={handleCloseDay} style={styles.closeBtn}>
            <Icon name="moon" size={20} color={colors.accent2} />
            <Text style={styles.closeLabel}>Close</Text>
          </Pressable>
        </View>
      </View>

      <CaptureSheet
        visible={showCapture}
        initialType={captureType}
        habits={habits}
        date={date}
        onClose={() => { setShowCapture(false); setCaptureType(null); }}
        onSave={entry => {
          addEntry(entry);
          setShowCapture(false);
          setCaptureType(null);
        }}
      />

      <EditEntrySheet
        entry={editingEntry}
        habits={habits}
        onClose={() => setEditingEntry(null)}
        onSave={updated => {
          editEntry(updated);
          setEditingEntry(null);
        }}
        onDelete={id => {
          removeEntry(id);
          setEditingEntry(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 40,
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
