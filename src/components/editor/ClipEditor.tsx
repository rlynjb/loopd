import { View, Text, Pressable, TextInput, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import type { ClipItem } from '../../types/project';
import { formatDuration } from '../../utils/time';
import Slider from '../../components/ui/Slider';

type Props = {
  clip: ClipItem;
  onUpdate: (updates: Partial<ClipItem>) => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onDelete: () => void;
};

function getWaveform(clipId: string, bars: number): number[] {
  const seed = clipId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return Array.from({ length: bars }).map((_, i) => {
    const v = Math.sin(i * 0.7 + seed * 0.1) * 0.4 + Math.cos(i * 1.3 + seed * 0.3) * 0.3 + 0.5;
    return Math.max(0.15, Math.min(1, v));
  });
}

export function ClipEditor({ clip, onUpdate, onMoveLeft, onMoveRight, onDelete }: Props) {
  const durationSec = clip.durationMs / 1000;
  const effectiveSec = Math.round(durationSec * (clip.trimEndPct - clip.trimStartPct) / 100);
  const waveform = getWaveform(clip.id, 56);

  return (
    <View style={[styles.container, { backgroundColor: `${clip.color}08`, borderColor: `${clip.color}20` }]}>
      <View style={styles.header}>
        <Text style={[styles.headerLabel, { color: clip.color }]} numberOfLines={1}>
          EDIT — 🎥 {clip.caption.slice(0, 24)}
        </Text>
        <View style={styles.headerActions}>
          <Pressable onPress={onMoveLeft} style={styles.actionBtn}>
            <Text style={styles.actionBtnText}>◀</Text>
          </Pressable>
          <Pressable onPress={onMoveRight} style={styles.actionBtn}>
            <Text style={styles.actionBtnText}>▶</Text>
          </Pressable>
          <Pressable onPress={onDelete} style={[styles.actionBtn, styles.deleteBtn]}>
            <Text style={styles.deleteBtnText}>✕</Text>
          </Pressable>
        </View>
      </View>

      <Text style={styles.fieldLabel}>CAPTION</Text>
      <TextInput
        value={clip.caption}
        onChangeText={caption => onUpdate({ caption })}
        style={styles.textArea}
        multiline
      />

      <View style={styles.trimHeader}>
        <Text style={styles.fieldLabel}>TRIM</Text>
        <Text style={styles.trimInfo}>
          {formatDuration(Math.round(durationSec * clip.trimStartPct / 100))} → {formatDuration(Math.round(durationSec * clip.trimEndPct / 100))}
        </Text>
      </View>

      {/* Waveform visualization */}
      <View style={styles.waveformBox}>
        <View style={styles.waveformBars}>
          {waveform.map((h, i) => {
            const pct = (i / 56) * 100;
            const inRange = pct >= clip.trimStartPct && pct <= clip.trimEndPct;
            return (
              <View
                key={i}
                style={{
                  flex: 1,
                  height: `${h * 85}%`,
                  backgroundColor: inRange ? `${clip.color}60` : 'rgba(255,255,255,0.06)',
                  borderRadius: 0.5,
                }}
              />
            );
          })}
        </View>
      </View>

      <View style={styles.sliderRow}>
        <View style={styles.sliderCol}>
          <Text style={styles.sliderLabel}>IN</Text>
          <Slider
            min={0}
            max={clip.trimEndPct - 5}
            value={clip.trimStartPct}
            onValueChange={v => onUpdate({ trimStartPct: v })}
            color={clip.color}
          />
        </View>
        <View style={styles.sliderCol}>
          <Text style={styles.sliderLabel}>OUT</Text>
          <Slider
            min={clip.trimStartPct + 5}
            max={100}
            value={clip.trimEndPct}
            onValueChange={v => onUpdate({ trimEndPct: v })}
            color={clip.color}
          />
        </View>
      </View>

      <Text style={styles.effectiveLabel}>{formatDuration(effectiveSec)} trimmed</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
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
    flex: 1,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 6,
  },
  actionBtn: {
    width: 28,
    height: 28,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: {
    color: colors.textMuted,
    fontSize: 11,
  },
  deleteBtn: {
    backgroundColor: 'rgba(251,113,133,0.1)',
    borderColor: 'rgba(251,113,133,0.2)',
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
  textArea: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: 12,
    color: colors.text,
    fontSize: 13,
    fontFamily: fonts.body,
    height: 56,
    textAlignVertical: 'top',
    marginBottom: 14,
  },
  trimHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  trimInfo: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
  },
  waveformBox: {
    height: 32,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 8,
  },
  waveformBars: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 4,
    gap: 1,
  },
  sliderRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
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
  effectiveLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    textAlign: 'center',
    marginTop: 8,
  },
});
