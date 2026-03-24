import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';

const CAPTURE_TYPES = [
  { id: 'video', label: 'Clip', icon: '🎥', color: '#e05555' },
  { id: 'journal', label: 'Journal', icon: '✍️', color: '#4caf7d' },
  { id: 'habit', label: 'Habit', icon: '💪', color: '#c46fd4' },
  { id: 'moment', label: 'Moment', icon: '📍', color: '#d4922a' },
] as const;

type Props = {
  onCapture: (type: string) => void;
};

export function CaptureCard({ onCapture }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.timeLabel}>now</Text>

      <View style={styles.card}>
        <Text style={styles.label}>CAPTURE</Text>
        <View style={styles.buttons}>
          {CAPTURE_TYPES.map(ct => (
            <Pressable
              key={ct.id}
              onPress={() => onCapture(ct.id)}
              style={styles.btn}
            >
              <Text style={styles.btnIcon}>{ct.icon}</Text>
              <Text style={styles.btnLabel}>{ct.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    marginBottom: 10,
  },
  timeLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
    marginBottom: 6,
    paddingLeft: 2,
  },
  card: {
    borderRadius: colors.radiusLg,
    padding: 14,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.cardBorder,
    backgroundColor: colors.bg2,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 0.8,
    marginBottom: 12,
  },
  buttons: {
    flexDirection: 'row',
    gap: 10,
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.bg3,
    alignItems: 'center',
    gap: 5,
  },
  btnIcon: {
    fontSize: 20,
  },
  btnLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textMuted,
  },
});
