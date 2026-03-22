import { Pressable, Text, StyleSheet } from 'react-native';
import { fonts } from '../../constants/theme';

type Props = {
  label: string;
  selected?: boolean;
  color?: string;
  onPress: () => void;
};

export function Chip({ label, selected = false, color = '#00d9a3', onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: selected ? `${color}15` : 'rgba(255,255,255,0.03)',
          borderColor: selected ? color : 'rgba(255,255,255,0.06)',
        },
      ]}
    >
      <Text
        style={[
          styles.label,
          { color: selected ? color : '#94a3b8' },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 11,
  },
});
