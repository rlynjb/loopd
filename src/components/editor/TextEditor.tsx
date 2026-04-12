import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import type { TextOverlay } from '../../types/project';
import { Icon, type IconName } from '../ui/Icon';
import Slider from '../ui/Slider';

type Props = {
  overlay: TextOverlay;
  onUpdate: (updates: Partial<TextOverlay>) => void;
  onDelete: () => void;
};

function IconBtn({ icon, active, onPress, size = 16 }: { icon: IconName; active?: boolean; onPress: () => void; size?: number }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.iconBtn, active && styles.iconBtnActive]}
    >
      <Icon name={icon} size={size} color={active ? colors.amber : colors.textMuted} />
    </Pressable>
  );
}

export function TextEditor({ overlay, onUpdate, onDelete }: Props) {
  const align = overlay.textAlign ?? 'center';
  const pos = overlay.position ?? 'bottom';

  return (
    <View style={styles.container}>
      {/* Size */}
      <View style={styles.row}>
        <Text style={styles.label}>SIZE</Text>
        <View style={styles.sliderWrap}>
          <Slider
            min={12}
            max={48}
            value={overlay.fontSize}
            onValueChange={fontSize => onUpdate({ fontSize })}
            color={colors.amber}
          />
        </View>
        <Text style={styles.value}>{overlay.fontSize}px</Text>
      </View>

      {/* Line Height */}
      <View style={styles.row}>
        <Text style={styles.label}>LEADING</Text>
        <View style={styles.sliderWrap}>
          <Slider
            min={10}
            max={25}
            step={1}
            value={overlay.lineHeight ?? 14}
            onValueChange={lineHeight => onUpdate({ lineHeight })}
            color={colors.amber}
          />
        </View>
        <Text style={styles.value}>{((overlay.lineHeight ?? 14) / 10).toFixed(1)}x</Text>
      </View>

      {/* Weight */}
      <View style={styles.row}>
        <Text style={styles.label}>WEIGHT</Text>
        <View style={styles.sliderWrap}>
          <Slider
            min={200}
            max={900}
            step={100}
            value={overlay.fontWeight}
            onValueChange={fontWeight => onUpdate({ fontWeight })}
            color={colors.amber}
          />
        </View>
        <Text style={styles.value}>{overlay.fontWeight}</Text>
      </View>

      {/* Align + Position */}
      <View style={styles.btnRow}>
        <IconBtn icon="alignLeft" active={align === 'left'} onPress={() => onUpdate({ textAlign: 'left' })} />
        <IconBtn icon="alignCenter" active={align === 'center'} onPress={() => onUpdate({ textAlign: 'center' })} />
        <IconBtn icon="alignRight" active={align === 'right'} onPress={() => onUpdate({ textAlign: 'right' })} />
        <View style={styles.divider} />
        <IconBtn icon="posTop" active={pos === 'top'} onPress={() => onUpdate({ position: 'top' })} />
        <IconBtn icon="posCenter" active={pos === 'center'} onPress={() => onUpdate({ position: 'center' })} />
        <IconBtn icon="posBottom" active={pos === 'bottom'} onPress={() => onUpdate({ position: 'bottom' })} />
        <View style={styles.divider} />

        {/* Full duration */}
        <Pressable
          onPress={() => onUpdate({ startPct: 0, endPct: 100 })}
          style={[styles.iconBtn, overlay.startPct === 0 && overlay.endPct === 100 && styles.iconBtnActive]}
        >
          <Text style={{ fontFamily: fonts.mono, fontSize: 8, color: overlay.startPct === 0 && overlay.endPct === 100 ? colors.amber : colors.textMuted }}>FULL</Text>
        </Pressable>

        <View style={{ flex: 1 }} />

        {/* Delete */}
        <Pressable onPress={onDelete} style={styles.deleteBtn}>
          <Icon name="trash" size={14} color={colors.coral} />
        </Pressable>
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(251,191,36,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.18)',
    borderRadius: 0,
    padding: 12,
    marginBottom: 14,
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: colors.textDim,
    letterSpacing: 0.5,
    width: 40,
  },
  sliderWrap: {
    flex: 1,
  },
  value: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: colors.amber,
    width: 32,
    textAlign: 'right',
  },
  btnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnActive: {
    backgroundColor: 'rgba(251,191,36,0.12)',
    borderColor: colors.amber,
  },
  divider: {
    width: 1,
    height: 20,
    backgroundColor: colors.cardBorder,
    marginHorizontal: 2,
  },
  deleteBtn: {
    width: 34,
    height: 34,
    borderRadius: 7,
    backgroundColor: 'rgba(251,113,133,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(251,113,133,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
