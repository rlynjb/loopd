import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { Icon, type IconName } from './Icon';

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  spinning?: boolean;
};

export function SpinningIcon({ name, size = 18, color, spinning = false }: Props) {
  const rotation = useRef(new Animated.Value(0)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (spinning) {
      rotation.setValue(0);
      animRef.current = Animated.loop(
        Animated.timing(rotation, {
          toValue: 1,
          duration: 1000,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      );
      animRef.current.start();
    } else {
      animRef.current?.stop();
      rotation.setValue(0);
    }
    return () => {
      animRef.current?.stop();
    };
  }, [spinning]);

  const spin = rotation.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <Animated.View style={{ transform: [{ rotate: spin }] }}>
      <Icon name={name} size={size} color={color} />
    </Animated.View>
  );
}
