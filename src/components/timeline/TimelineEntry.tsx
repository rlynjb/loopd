import { View, Text, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { MOODS } from '../../constants/moods';
import { CATEGORIES } from '../../constants/categories';
import type { Entry, Habit } from '../../types/entry';

const CAPTURE_TYPES = [
  { id: 'video', label: 'Clip', icon: '🎥', color: '#fb7185' },
  { id: 'journal', label: 'Journal', icon: '✍️', color: '#00d9a3' },
  { id: 'habit', label: 'Habit', icon: '💪', color: '#a78bfa' },
  { id: 'moment', label: 'Moment', icon: '📍', color: '#fbbf24' },
] as const;

type Props = {
  entry: Entry;
  habits: Habit[];
};

export function TimelineEntry({ entry, habits }: Props) {
  const mood = MOODS.find(m => m.id === entry.mood);
  const cat = CATEGORIES.find(c => c.id === entry.category);
  const captureType = CAPTURE_TYPES.find(c => c.id === entry.type);
  const isHabit = entry.type === 'habit';

  const time = new Date(entry.createdAt);
  const timeStr = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  return (
    <View style={styles.row}>
      <View style={styles.timeCol}>
        <Text style={styles.timeText}>{timeStr}</Text>
      </View>

      <View style={styles.lineCol}>
        <View style={[styles.dot, { backgroundColor: captureType?.color ?? colors.teal }]} />
      </View>

      <View style={styles.card}>
        <View style={styles.badges}>
          <View style={[styles.typeBadge, { backgroundColor: `${captureType?.color}18`, borderColor: `${captureType?.color}30` }]}>
            <Text style={[styles.typeText, { color: captureType?.color }]}>
              {captureType?.icon} {captureType?.label}
            </Text>
          </View>
          {mood && (
            <Text style={[styles.moodText, { color: mood.color }]}>
              {mood.emoji} {mood.label}
            </Text>
          )}
          {cat && (
            <Text style={styles.catText}>{cat.emoji} {cat.label}</Text>
          )}
        </View>

        {isHabit && entry.habits.length > 0 ? (
          <View style={styles.habitList}>
            {entry.habits.map(hId => {
              const h = habits.find(x => x.id === hId);
              if (!h) return null;
              return (
                <View key={hId} style={styles.habitRow}>
                  <View style={styles.checkBox}>
                    <Text style={styles.checkMark}>✓</Text>
                  </View>
                  <Text style={styles.habitLabel}>{h.emoji} {h.label}</Text>
                </View>
              );
            })}
            {entry.text ? (
              <Text style={styles.habitNote}>{entry.text}</Text>
            ) : null}
          </View>
        ) : (
          <Text style={styles.entryText}>{entry.text}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 24,
  },
  timeCol: {
    width: 58,
    alignItems: 'flex-end',
    paddingTop: 14,
  },
  timeText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
  },
  lineCol: {
    width: 2,
    backgroundColor: 'rgba(0,217,163,0.2)',
    borderRadius: 2,
    alignItems: 'center',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 16,
  },
  card: {
    flex: 1,
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  typeBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
  },
  typeText: {
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  moodText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    opacity: 0.8,
  },
  catText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
  },
  entryText: {
    fontFamily: fonts.body,
    fontSize: 13.5,
    color: '#cbd5e1',
    lineHeight: 21,
  },
  habitList: {
    gap: 6,
  },
  habitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  checkBox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    backgroundColor: `${colors.purple}25`,
    borderWidth: 1.5,
    borderColor: colors.purple,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkMark: {
    fontSize: 11,
    color: colors.purple,
  },
  habitLabel: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: '#cbd5e1',
  },
  habitNote: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textMuted,
    fontStyle: 'italic',
    marginTop: 4,
  },
});
