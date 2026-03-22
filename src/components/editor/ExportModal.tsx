import { View, Text, StyleSheet } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import Svg, { Circle } from 'react-native-svg';
import { colors, fonts } from '../../constants/theme';

type Props = {
  visible: boolean;
  clipCount: number;
  textCount: number;
  filterCount: number;
  onComplete: () => void;
};

const STAGES = [
  { at: 0, label: 'Preparing clips...' },
  { at: 15, label: 'Applying filters...' },
  { at: 30, label: 'Rendering text overlays...' },
  { at: 50, label: 'Encoding video...' },
  { at: 75, label: 'Compressing...' },
  { at: 90, label: 'Finalizing...' },
  { at: 100, label: 'Done' },
];

export function ExportModal({ visible, clipCount, textCount, filterCount, onComplete }: Props) {
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('Preparing clips...');
  const startRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (visible) {
      setProgress(0);
      setStage('Preparing clips...');
      startRef.current = Date.now();
      const duration = 3500;

      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startRef.current;
        const pct = Math.min(100, Math.round((elapsed / duration) * 100));
        setProgress(pct);
        const s = [...STAGES].reverse().find(s => pct >= s.at);
        if (s) setStage(s.label);
        if (pct >= 100) {
          if (timerRef.current) clearInterval(timerRef.current);
          setTimeout(onComplete, 800);
        }
      }, 50);

      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }
  }, [visible, onComplete]);

  if (!visible) return null;

  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - progress / 100);
  const isDone = progress >= 100;

  return (
    <View style={styles.overlay}>
      <View style={styles.ringWrap}>
        <Svg width={100} height={100} style={{ transform: [{ rotate: '-90deg' }] }}>
          <Circle cx={50} cy={50} r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={4} />
          <Circle
            cx={50} cy={50} r={radius} fill="none"
            stroke={isDone ? colors.teal : colors.purple}
            strokeWidth={4} strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        </Svg>
        <View style={styles.ringCenter}>
          <Text style={[styles.pctText, { color: isDone ? colors.teal : colors.text }]}>
            {isDone ? '✓' : `${progress}%`}
          </Text>
        </View>
      </View>

      <Text style={[styles.title, { color: isDone ? colors.teal : colors.text }]}>
        {isDone ? 'Export Complete' : 'Exporting Vlog'}
      </Text>
      <Text style={styles.stageText}>{stage}</Text>

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
});
