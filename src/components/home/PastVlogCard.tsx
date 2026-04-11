import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { CATEGORIES } from '../../constants/categories';
import { Icon } from '../ui/Icon';
import type { Vlog } from '../../types/entry';
import { formatRelativeDate, formatDuration } from '../../utils/time';

type Props = {
  vlog: Vlog;
  title?: string;
  preview?: string;
  onPress?: () => void;
};

export function PastVlogCard({ vlog, title, preview, onPress }: Props) {
  return (
    <Pressable onPress={onPress} style={styles.card}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <Text style={styles.dateText}>{formatRelativeDate(vlog.date)}</Text>
      {preview ? <Text style={styles.caption} numberOfLines={2}>{preview}</Text> : null}
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
  dateText: {
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
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
