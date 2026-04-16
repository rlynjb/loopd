import { View, Pressable, StyleSheet } from 'react-native';
import { colors } from '../../constants/theme';
import { Icon, type IconName } from '../ui/Icon';
import type { TextOverlay } from '../../types/project';

type SizeOption = 'S' | 'M' | 'L';
const SIZE_MAP: Record<SizeOption, number> = { S: 13, M: 16, L: 19 };
const SIZE_REVERSE: Record<number, SizeOption> = { 13: 'S', 16: 'M', 19: 'L' };

const SIZE_ICON_SIZE: Record<SizeOption, number> = { S: 12, M: 16, L: 20 };
const POS_ICONS: Record<string, IconName> = { top: 'posTop', center: 'posCenter', bottom: 'posBottom' };

type WeightOption = 300 | 500 | 700;
const WEIGHT_ICONS: Record<WeightOption, IconName> = { 300: 'thin', 500: 'type', 700: 'bold' };
const WEIGHTS: WeightOption[] = [300, 500, 700];

type Props = {
  overlay: TextOverlay;
  onUpdate: (updates: Partial<TextOverlay>) => void;
};

export function TextOverlaySheet({ overlay, onUpdate }: Props) {
  const currentSize = SIZE_REVERSE[overlay.fontSize] ?? 'S';
  const currentPos = overlay.position ?? 'center';
  const currentWeight = (overlay.fontWeight ?? 700) as WeightOption;

  return (
    <View style={styles.sheet}>
      {(['top', 'center', 'bottom'] as const).map(pos => (
        <Pressable
          key={pos}
          onPress={() => onUpdate({ position: pos })}
          style={[styles.iconBtn, currentPos === pos && styles.iconBtnActive]}
        >
          <Icon name={POS_ICONS[pos]} size={16} color={currentPos === pos ? colors.amber : colors.textMuted} />
        </Pressable>
      ))}

      <View style={styles.divider} />

      {(['S', 'M', 'L'] as SizeOption[]).map(size => (
        <Pressable
          key={size}
          onPress={() => onUpdate({ fontSize: SIZE_MAP[size] })}
          style={[styles.iconBtn, currentSize === size && styles.iconBtnActive]}
        >
          <Icon name="type" size={SIZE_ICON_SIZE[size]} color={currentSize === size ? colors.amber : colors.textMuted} />
        </Pressable>
      ))}

      <View style={styles.divider} />

      {WEIGHTS.map(w => (
        <Pressable
          key={w}
          onPress={() => onUpdate({ fontWeight: w })}
          style={[styles.iconBtn, currentWeight === w && styles.iconBtnActive]}
        >
          <Icon name={WEIGHT_ICONS[w]} size={16} color={currentWeight === w ? colors.amber : colors.textMuted} />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 6,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.15)',
    borderRadius: 10,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
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
});
