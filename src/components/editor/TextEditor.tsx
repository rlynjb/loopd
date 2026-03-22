import { View, Text, Pressable, TextInput, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import type { TextOverlay } from '../../types/project';
import { formatDuration } from '../../utils/time';
import Slider from '../ui/Slider';

const TEXT_COLORS = ['#ffffff', '#fbbf24', '#00d9a3', '#fb7185', '#a78bfa', '#38bdf8'];

type Props = {
  overlay: TextOverlay;
  totalDurationSec: number;
  onUpdate: (updates: Partial<TextOverlay>) => void;
  onDelete: () => void;
};

export function TextEditor({ overlay, totalDurationSec, onUpdate, onDelete }: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerLabel}>EDIT TEXT</Text>
        <Pressable onPress={onDelete} style={styles.deleteBtn}>
          <Text style={styles.deleteBtnText}>✕</Text>
        </Pressable>
      </View>

      <Text style={styles.fieldLabel}>CONTENT</Text>
      <TextInput
        value={overlay.text}
        onChangeText={text => onUpdate({ text })}
        style={[styles.textInput, { fontSize: Math.min(overlay.fontSize, 18), fontWeight: String(overlay.fontWeight) as '300' | '400' | '700' }]}
      />

      <View style={styles.sizeRow}>
        <Text style={styles.fieldLabel}>SIZE</Text>
        <Text style={styles.sizeValue}>{overlay.fontSize}px</Text>
      </View>
      <Slider
        min={12}
        max={48}
        value={overlay.fontSize}
        onValueChange={fontSize => onUpdate({ fontSize })}
        color={colors.amber}
      />

      <Text style={[styles.fieldLabel, { marginTop: 14 }]}>WEIGHT</Text>
      <View style={styles.weightRow}>
        {([
          { value: 300, label: 'Thin' },
          { value: 400, label: 'Normal' },
          { value: 700, label: 'Bold' },
        ] as const).map(w => {
          const isActive = overlay.fontWeight === w.value;
          return (
            <Pressable
              key={w.value}
              onPress={() => onUpdate({ fontWeight: w.value })}
              style={[
                styles.weightBtn,
                {
                  backgroundColor: isActive ? 'rgba(251,191,36,0.15)' : 'rgba(255,255,255,0.03)',
                  borderColor: isActive ? colors.amber : colors.cardBorder,
                },
              ]}
            >
              <Text
                style={[
                  styles.weightBtnText,
                  {
                    color: isActive ? colors.amber : colors.textMuted,
                    fontWeight: String(w.value) as '300' | '400' | '700',
                  },
                ]}
              >
                {w.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={[styles.fieldLabel, { marginTop: 14 }]}>COLOR</Text>
      <View style={styles.colorRow}>
        {TEXT_COLORS.map(c => (
          <Pressable
            key={c}
            onPress={() => onUpdate({ color: c })}
            style={[
              styles.colorSwatch,
              {
                backgroundColor: c,
                borderColor: overlay.color === c ? '#ffffff' : 'transparent',
              },
            ]}
          />
        ))}
      </View>

      <View style={[styles.sizeRow, { marginTop: 14 }]}>
        <Text style={styles.fieldLabel}>TIMING</Text>
        <Text style={styles.timingInfo}>
          {formatDuration(Math.round(totalDurationSec * overlay.startPct / 100))} → {formatDuration(Math.round(totalDurationSec * overlay.endPct / 100))}
        </Text>
      </View>
      <View style={styles.sliderRow}>
        <View style={styles.sliderCol}>
          <Text style={styles.sliderLabel}>START</Text>
          <Slider min={0} max={overlay.endPct - 5} value={overlay.startPct} onValueChange={v => onUpdate({ startPct: v })} color={colors.amber} />
        </View>
        <View style={styles.sliderCol}>
          <Text style={styles.sliderLabel}>END</Text>
          <Slider min={overlay.startPct + 5} max={100} value={overlay.endPct} onValueChange={v => onUpdate({ endPct: v })} color={colors.amber} />
        </View>
      </View>

      {/* Live preview */}
      <View style={styles.preview}>
        <Text style={{
          fontFamily: fonts.heading,
          fontSize: overlay.fontSize,
          fontWeight: String(overlay.fontWeight) as '300' | '400' | '700',
          color: overlay.color,
          textAlign: 'center',
        }}>
          {overlay.text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(251,191,36,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.18)',
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
    color: colors.amber,
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
  textInput: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontFamily: fonts.heading,
    marginBottom: 14,
  },
  sizeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  sizeValue: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.amber,
  },
  weightRow: {
    flexDirection: 'row',
    gap: 6,
  },
  weightBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: 'center',
  },
  weightBtnText: {
    fontFamily: fonts.heading,
    fontSize: 12,
  },
  colorRow: {
    flexDirection: 'row',
    gap: 8,
  },
  colorSwatch: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 2,
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
  preview: {
    marginTop: 14,
    padding: 16,
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 10,
    alignItems: 'center',
  },
});
