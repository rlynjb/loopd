import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';

const CAPTURE_TYPES = [
  { id: 'video', label: 'Clip', icon: '🎥', color: '#fb7185' },
  { id: 'journal', label: 'Journal', icon: '✍️', color: '#00d9a3' },
  { id: 'habit', label: 'Habit', icon: '💪', color: '#a78bfa' },
  { id: 'moment', label: 'Moment', icon: '📍', color: '#fbbf24' },
] as const;

type Props = {
  onCapture: (type: string) => void;
};

export function CaptureCard({ onCapture }: Props) {
  return (
    <View style={styles.row}>
      <View style={styles.timeCol}>
        <Text style={styles.timeText}>now</Text>
      </View>

      <View style={styles.lineCol}>
        <View style={styles.dot} />
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>CAPTURE</Text>
        <View style={styles.buttons}>
          {CAPTURE_TYPES.map(ct => (
            <Pressable
              key={ct.id}
              onPress={() => onCapture(ct.id)}
              style={[styles.btn, { backgroundColor: `${ct.color}08`, borderColor: `${ct.color}20` }]}
            >
              <Text style={styles.btnIcon}>{ct.icon}</Text>
              <Text style={[styles.btnLabel, { color: ct.color }]}>{ct.label}</Text>
            </Pressable>
          ))}
        </View>
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
    backgroundColor: 'rgba(0,217,163,0.15)',
    borderRadius: 2,
    alignItems: 'center',
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.15)',
    marginTop: 16,
  },
  card: {
    flex: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.015)',
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 9,
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
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    gap: 5,
  },
  btnIcon: {
    fontSize: 20,
  },
  btnLabel: {
    fontFamily: fonts.mono,
    fontSize: 8,
    letterSpacing: 0.6,
  },
});
