import { View, StyleSheet } from 'react-native';

type Props = {
  color?: string;
  size?: number;
  top?: number;
  left?: number;
  opacity?: number;
};

export function GlowOrb({ color = '#00d9a3', size = 200, top = 0, left = 0, opacity = 0.12 }: Props) {
  return (
    <View
      style={[
        styles.orb,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          top,
          left,
          opacity,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  orb: {
    position: 'absolute',
    pointerEvents: 'none',
  },
});
