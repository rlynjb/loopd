import { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import type { TextOverlay } from '../../types/project';
import { Icon, type IconName } from '../ui/Icon';
import Slider from '../ui/Slider';

const TEXT_COLORS = ['#ffffff', '#fbbf24', '#00d9a3', '#fb7185', '#a78bfa', '#38bdf8', '#e05555', '#d4922a', '#000000'];

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
  const [showColors, setShowColors] = useState(false);

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

      {/* Weight + Align */}
      <View style={styles.btnRow}>
        <IconBtn icon="thin" active={overlay.fontWeight === 300} onPress={() => onUpdate({ fontWeight: 300 })} />
        <IconBtn icon="type" active={overlay.fontWeight === 400} onPress={() => onUpdate({ fontWeight: 400 })} />
        <IconBtn icon="bold" active={overlay.fontWeight === 700} onPress={() => onUpdate({ fontWeight: 700 })} />
        <View style={styles.divider} />
        <IconBtn icon="alignLeft" active={align === 'left'} onPress={() => onUpdate({ textAlign: 'left' })} />
        <IconBtn icon="alignCenter" active={align === 'center'} onPress={() => onUpdate({ textAlign: 'center' })} />
        <IconBtn icon="alignRight" active={align === 'right'} onPress={() => onUpdate({ textAlign: 'right' })} />
      </View>

      {/* Position */}
      <View style={styles.btnRow}>
        <IconBtn icon="posTop" active={pos === 'top'} onPress={() => onUpdate({ position: 'top' })} />
        <IconBtn icon="posCenter" active={pos === 'center'} onPress={() => onUpdate({ position: 'center' })} />
        <IconBtn icon="posBottom" active={pos === 'bottom'} onPress={() => onUpdate({ position: 'bottom' })} />
        <View style={styles.divider} />

        {/* Color picker toggle */}
        <Pressable onPress={() => setShowColors(!showColors)} style={[styles.colorToggle, showColors && styles.iconBtnActive]}>
          <View style={[styles.colorDot, { backgroundColor: overlay.color }]} />
        </Pressable>

        <View style={{ flex: 1 }} />

        {/* Delete */}
        <Pressable onPress={onDelete} style={styles.deleteBtn}>
          <Icon name="trash" size={14} color={colors.coral} />
        </Pressable>
      </View>

      {/* Color picker — expandable */}
      {showColors && (
        <View style={styles.colorGrid}>
          {TEXT_COLORS.map(c => (
            <Pressable
              key={c}
              onPress={() => { onUpdate({ color: c }); setShowColors(false); }}
              style={[
                styles.colorSwatch,
                {
                  backgroundColor: c,
                  borderColor: overlay.color === c ? '#ffffff' : 'rgba(255,255,255,0.1)',
                },
              ]}
            />
          ))}
        </View>
      )}
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
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 0.5,
    width: 28,
  },
  sliderWrap: {
    flex: 1,
  },
  value: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.amber,
    width: 28,
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
  colorToggle: {
    width: 34,
    height: 34,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  colorDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  colorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  colorSwatch: {
    width: 30,
    height: 30,
    borderRadius: 6,
    borderWidth: 2,
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
