import { ScrollView, Text, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { TimelineEntry } from './TimelineEntry';
import { CaptureCard } from './CaptureCard';
import type { Entry, Habit } from '../../types/entry';

type Props = {
  entries: Entry[];
  habits: Habit[];
  onCapture: (type: string) => void;
};

export function TimelineList({ entries, habits, onCapture }: Props) {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {sorted.length === 0 && (
        <Text style={styles.empty}>Your timeline is empty. Capture your first moment.</Text>
      )}
      {sorted.map(entry => (
        <TimelineEntry key={entry.id} entry={entry} habits={habits} />
      ))}
      <CaptureCard onCapture={onCapture} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    paddingTop: 8,
    paddingBottom: 140,
  },
  empty: {
    textAlign: 'center',
    padding: 24,
    color: colors.textDimmer,
    fontFamily: fonts.body,
    fontSize: 13,
  },
});
