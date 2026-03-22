import { Pressable, Text, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';

type Props = {
  label: string;
  enabled?: boolean;
  onPress: () => void;
  variant?: 'teal' | 'coral' | 'amber';
};

export function PrimaryButton({ label, enabled = true, onPress, variant = 'teal' }: Props) {
  const bg = enabled
    ? variant === 'teal'
      ? colors.teal
      : variant === 'coral'
        ? colors.coral
        : colors.amber
    : 'rgba(255,255,255,0.05)';

  return (
    <Pressable
      onPress={enabled ? onPress : undefined}
      style={[styles.btn, { backgroundColor: bg }]}
    >
      <Text
        style={[
          styles.label,
          { color: enabled ? colors.bg : colors.textDimmer },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.7,
  },
});
