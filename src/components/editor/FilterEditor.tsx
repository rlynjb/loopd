import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import type { FilterOverlay } from '../../types/project';
import Slider from '../ui/Slider';

type Props = {
  overlay: FilterOverlay;
  onUpdate: (updates: Partial<FilterOverlay>) => void;
  onDelete: () => void;
};

export function FilterEditor({ overlay, onUpdate, onDelete }: Props) {
  const handleReset = () => {
    onUpdate({ brightness: 100, contrast: 100, saturate: 100 });
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>COLOR ADJUST</Text>
        <View style={styles.headerActions}>
          <Pressable onPress={handleReset} style={styles.resetBtn}>
            <Text style={styles.resetBtnText}>RESET</Text>
          </Pressable>
          <Pressable onPress={onDelete} style={styles.deleteBtn}>
            <Text style={styles.deleteBtnText}>✕</Text>
          </Pressable>
        </View>
      </View>

      {([
        { key: 'brightness' as const, label: 'Brightness', icon: '☀', min: 50, max: 150 },
        { key: 'contrast' as const, label: 'Contrast', icon: '◐', min: 50, max: 150 },
        { key: 'saturate' as const, label: 'Saturation', icon: '◉', min: 0, max: 200 },
      ]).map(ctrl => (
        <View key={ctrl.key} style={styles.adjustRow}>
          <Text style={styles.adjustIcon}>{ctrl.icon}</Text>
          <Text style={styles.adjustLabel}>{ctrl.label}</Text>
          <View style={styles.adjustSlider}>
            <Slider
              min={ctrl.min}
              max={ctrl.max}
              value={overlay[ctrl.key]}
              onValueChange={v => onUpdate({ [ctrl.key]: v })}
              color={colors.purple}
            />
          </View>
          <Text style={styles.adjustValue}>{overlay[ctrl.key]}%</Text>
        </View>
      ))}

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(167,139,250,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(167,139,250,0.20)',
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  headerLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.purple,
    letterSpacing: 1,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 6,
  },
  resetBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 7,
  },
  resetBtnText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 0.4,
  },
  deleteBtn: {
    width: 28,
    height: 28,
    borderRadius: 7,
    backgroundColor: 'rgba(251,113,133,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(251,113,133,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtnText: {
    color: colors.coral,
    fontSize: 11,
  },
  fieldLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
    marginBottom: 8,
  },
  adjustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  adjustIcon: {
    fontSize: 11,
    width: 16,
    textAlign: 'center',
  },
  adjustLabel: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: colors.textDim,
    width: 52,
  },
  adjustSlider: {
    flex: 1,
  },
  adjustValue: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textMuted,
    width: 30,
    textAlign: 'right',
  },
  timingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
    marginBottom: 6,
  },
  timingInfo: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
  },
  sliderRow: {
    flexDirection: 'row',
    gap: 12,
  },
  sliderCol: {
    flex: 1,
  },
  sliderLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    marginBottom: 3,
  },
});
