import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { MOODS } from '../../constants/moods';
import { CATEGORIES } from '../../constants/categories';
import { Icon } from '../ui/Icon';
import type { Vlog } from '../../types/entry';
import { formatRelativeDate, formatDuration } from '../../utils/time';

type Props = {
  vlog: Vlog;
  title?: string;
  onPress?: () => void;
};

export function PastVlogCard({ vlog, title, onPress }: Props) {
  const mood = MOODS.find(m => m.id === vlog.mood);
  const moodColor = mood?.color ?? colors.textDim;

  return (
    <Pressable onPress={onPress} style={styles.card}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <View style={styles.topRow}>
        <View style={styles.dateGroup}>
          <View style={[styles.moodDot, { backgroundColor: moodColor }]} />
          <Text style={styles.dateText}>{formatRelativeDate(vlog.date)}</Text>
          {mood && <Text style={[styles.moodLabel, { color: moodColor }]}>{mood.id}</Text>}
        </View>
        <Text style={styles.duration}>{formatDuration(vlog.durationSeconds)}</Text>
      </View>

      {vlog.caption && <Text style={styles.caption} numberOfLines={2}>{vlog.caption}</Text>}

      <View style={styles.bottomRow}>
        <View style={styles.stats}>
          <Text style={styles.stat}>{vlog.clipCount} clips</Text>
          <Text style={styles.stat}>{vlog.habitCount} habits</Text>
        </View>
        <View style={styles.catEmojis}>
          {vlog.categories.slice(0, 4).map(catId => {
            const cat = CATEGORIES.find(c => c.id === catId);
            return cat ? (
              <Icon key={catId} name={cat.icon} size={13} color={colors.textDim} />
            ) : null;
          })}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 0,
    padding: 15,
    marginBottom: 10,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.text,
    marginBottom: 8,
    letterSpacing: -0.3,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  dateGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  moodDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dateText: {
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
  },
  moodLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    opacity: 0.8,
  },
  duration: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
  },
  caption: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 19,
    marginBottom: 10,
  },
  bottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  stats: {
    flexDirection: 'row',
    gap: 10,
  },
  stat: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
  },
  catEmojis: {
    flexDirection: 'row',
    gap: 4,
  },
  catEmoji: {
    fontSize: 11,
  },
});
