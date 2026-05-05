// Legend strip for the Daily Schedule grid. Five swatches with one-word
// labels; renders unconditionally per spec §2.8 to lower the cognitive
// cost of the new design's first few weeks.
import { View, Text, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';

type SwatchKey = 'done' | 'today' | 'upcoming' | 'missed' | 'offDay';
type Swatch = { label: string; styleKey: SwatchKey };

const ITEMS: Swatch[] = [
  { label: 'done', styleKey: 'done' },
  { label: 'today', styleKey: 'today' },
  { label: 'upcoming', styleKey: 'upcoming' },
  { label: 'missed', styleKey: 'missed' },
  { label: 'off-day', styleKey: 'offDay' },
];

export function DailyScheduleLegend() {
  return (
    <View style={styles.row}>
      {ITEMS.map(item => (
        <View key={item.label} style={styles.item}>
          <View style={[styles.swatchBase, swatchStyles[item.styleKey]]}>
            {item.styleKey === 'done' && <Text style={styles.checkmark}>✓</Text>}
          </View>
          <Text style={styles.label}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    paddingVertical: 6,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  swatchBase: {
    width: 12,
    height: 12,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmark: {
    fontFamily: fonts.body,
    fontSize: 8,
    color: 'rgba(232, 213, 176, 0.9)',
    fontWeight: '700',
    lineHeight: 9,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 0.4,
  },
});

// Separate map so the View styles aren't co-mingled with the Text-only ones
// in the main StyleSheet (TS rejects passing Text styles to a View).
const swatchStyles = StyleSheet.create({
  done: {
    backgroundColor: 'rgba(95, 189, 128, 0.4)',
  },
  today: {
    borderWidth: 1,
    borderColor: 'rgba(232, 213, 176, 0.7)',
  },
  upcoming: {
    borderWidth: 1,
    borderColor: 'rgba(232, 213, 176, 0.3)',
    borderStyle: 'dashed',
  },
  missed: {
    borderWidth: 1,
    borderColor: 'rgba(226, 75, 74, 0.4)',
    borderStyle: 'dashed',
  },
  offDay: {
    borderWidth: 1,
    borderColor: 'rgba(232, 213, 176, 0.15)',
  },
});
