import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { FILTERS } from '../../constants/filters';
import type { FilterOverlay } from '../../types/project';
import { formatDuration } from '../../utils/time';
import Slider from '../ui/Slider';

type Props = {
  overlay: FilterOverlay;
  totalDurationSec: number;
  onUpdate: (updates: Partial<FilterOverlay>) => void;
  onDelete: () => void;
};

export function FilterEditor({ overlay, totalDurationSec, onUpdate, onDelete }: Props) {
  const preset = FILTERS.find(x => x.id === overlay.filterId) ?? FILTERS[0];

  const handlePresetChange = (filterId: string) => {
    const f = FILTERS.find(x => x.id === filterId) ?? FILTERS[0];
    onUpdate({ filterId: f.id, brightness: f.brightness, contrast: f.contrast, saturate: f.saturate });
  };

  const handleReset = () => {
    onUpdate({ brightness: preset.brightness, contrast: preset.contrast, saturate: preset.saturate });
  };

  return (
    <View style={[styles.container, { borderColor: `${preset.color}20` }]}>
      <View style={styles.header}>
        <Text style={[styles.headerLabel, { color: preset.color }]}>EDIT FILTER — {preset.label}</Text>
        <Pressable onPress={onDelete} style={styles.deleteBtn}>
          <Text style={styles.deleteBtnText}>✕</Text>
        </Pressable>
      </View>

      <Text style={styles.fieldLabel}>TYPE</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.presetScroll}>
        {FILTERS.filter(f => f.id !== 'none').map(f => {
          const isActive = overlay.filterId === f.id;
          return (
            <Pressable
              key={f.id}
              onPress={() => handlePresetChange(f.id)}
              style={[
                styles.presetBtn,
                {
                  backgroundColor: isActive ? `${f.color}18` : 'rgba(255,255,255,0.03)',
                  borderColor: isActive ? f.color : colors.cardBorder,
                },
              ]}
            >
              <View style={[styles.presetSwatch, { backgroundColor: `${f.color}35`, borderColor: `${f.color}30` }]} />
              <Text style={[styles.presetLabel, { color: isActive ? f.color : colors.textDim }]}>{f.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <Text style={[styles.fieldLabel, { marginTop: 14 }]}>ADJUST</Text>
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
              color={preset.color}
            />
          </View>
          <Text style={styles.adjustValue}>{overlay[ctrl.key]}%</Text>
        </View>
      ))}
      <Pressable onPress={handleReset} style={styles.resetBtn}>
        <Text style={styles.resetBtnText}>RESET TO PRESET</Text>
      </Pressable>

      <View style={[styles.timingHeader, { marginTop: 14 }]}>
        <Text style={styles.fieldLabel}>TIMING</Text>
        <Text style={styles.timingInfo}>
          {formatDuration(Math.round(totalDurationSec * overlay.startPct / 100))} → {formatDuration(Math.round(totalDurationSec * overlay.endPct / 100))}
        </Text>
      </View>
      <View style={styles.sliderRow}>
        <View style={styles.sliderCol}>
          <Text style={styles.sliderLabel}>START</Text>
          <Slider min={0} max={overlay.endPct - 5} value={overlay.startPct} onValueChange={v => onUpdate({ startPct: v })} color={preset.color} />
        </View>
        <View style={styles.sliderCol}>
          <Text style={styles.sliderLabel}>END</Text>
          <Slider min={overlay.startPct + 5} max={100} value={overlay.endPct} onValueChange={v => onUpdate({ endPct: v })} color={preset.color} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(167,139,250,0.06)',
    borderWidth: 1,
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
    letterSpacing: 1,
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
  presetScroll: {
    marginBottom: 4,
  },
  presetBtn: {
    width: 48,
    paddingVertical: 6,
    borderRadius: 7,
    borderWidth: 1.5,
    alignItems: 'center',
    gap: 2,
    marginRight: 6,
  },
  presetSwatch: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1,
  },
  presetLabel: {
    fontFamily: fonts.mono,
    fontSize: 7,
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
  resetBtn: {
    marginTop: 4,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  resetBtnText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 0.4,
  },
  timingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
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
