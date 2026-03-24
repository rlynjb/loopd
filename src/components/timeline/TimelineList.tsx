import { ScrollView, Text, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { TimelineEntry } from './TimelineEntry';
import type { Entry, Habit } from '../../types/entry';

type Props = {
  entries: Entry[];
  habits: Habit[];
  onEditEntry?: (entry: Entry) => void;
};

export function TimelineList({ entries, habits, onEditEntry }: Props) {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {sorted.length === 0 && (
        <Text style={styles.empty}>Your timeline is empty. Start capturing.</Text>
      )}
      {sorted.map(entry => (
        <TimelineEntry key={entry.id} entry={entry} habits={habits} onEdit={onEditEntry} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    paddingTop: 8,
    paddingBottom: 180,
  },
  empty: {
    textAlign: 'center',
    padding: 24,
    color: colors.textDimmer,
    fontFamily: fonts.body,
    fontSize: 13,
  },
});
