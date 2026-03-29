import { View, Text, Pressable, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { colors, fonts } from '../../constants/theme';
import type { ExportProgress } from '../../types/project';

const STAGE_LABELS: Record<string, string> = {
  preparing: 'Preparing clips...',
  encoding: 'Encoding video...',
  finalizing: 'Finalizing...',
  done: 'Export Complete',
  error: 'Export Failed',
};

type Props = {
  progress: ExportProgress | null;
  clipCount: number;
  textCount: number;
  filterCount: number;
  onCancel: () => void;
};

export function ExportModal({ progress, clipCount, textCount, filterCount, onCancel }: Props) {
  if (!progress) return null;

  const pct = progress.progress;
  const isDone = progress.stage === 'done';
  const isError = progress.stage === 'error';
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);

  return (
    <View style={styles.overlay}>
      <View style={styles.ringWrap}>
        <Svg width={100} height={100} style={{ transform: [{ rotate: '-90deg' }] }}>
          <Circle cx={50} cy={50} r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={4} />
          <Circle
            cx={50} cy={50} r={radius} fill="none"
            stroke={isError ? colors.coral : isDone ? colors.teal : colors.purple}
            strokeWidth={4} strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        </Svg>
        <View style={styles.ringCenter}>
          <Text style={[styles.pctText, { color: isError ? colors.coral : isDone ? colors.teal : colors.text }]}>
            {isDone ? '✓' : isError ? '!' : `${pct}%`}
          </Text>
        </View>
      </View>

      <Text style={[styles.title, { color: isError ? colors.coral : isDone ? colors.teal : colors.text }]}>
        {STAGE_LABELS[progress.stage] ?? progress.stage}
      </Text>

      {isError && progress.error && (
        <Text style={styles.errorText} numberOfLines={4}>{progress.error}</Text>
      )}

      {!isError && !isDone && (
        <Text style={styles.stageText}>
          {Math.round(progress.currentTimeMs / 1000)}s / {Math.round(progress.totalDurationMs / 1000)}s
        </Text>
      )}

      <View style={styles.stats}>
        {[
          { label: 'clips', value: clipCount, color: colors.coral },
          { label: 'texts', value: textCount, color: colors.amber },
          { label: 'filters', value: filterCount, color: colors.purple },
        ].map(s => (
          <View key={s.label} style={styles.statItem}>
            <Text style={[styles.statValue, { color: s.color }]}>{s.value}</Text>
            <Text style={styles.statLabel}>{s.label.toUpperCase()}</Text>
          </View>
        ))}
      </View>

      <Pressable onPress={onCancel} style={styles.cancelBtn}>
        <Text style={styles.cancelBtnText}>{isDone ? 'DISMISS' : isError ? 'DISMISS' : 'CANCEL'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 200,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringWrap: {
    width: 100,
    height: 100,
    marginBottom: 24,
    position: 'relative',
  },
  ringCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pctText: {
    fontFamily: fonts.heading,
    fontSize: 22,
    fontWeight: '700',
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  stageText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
    letterSpacing: 0.4,
  },
  errorText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: 32,
    marginBottom: 8,
  },
  stats: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 20,
  },
  statItem: {
    alignItems: 'center',
  },
  statValue: {
    fontFamily: fonts.heading,
    fontSize: 16,
    fontWeight: '700',
  },
  statLabel: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: colors.textDim,
    letterSpacing: 0.8,
  },
  cancelBtn: {
    marginTop: 24,
    paddingVertical: 10,
    paddingHorizontal: 24,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
  },
  cancelBtnText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
    letterSpacing: 0.5,
  },
});
