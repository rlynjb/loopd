import { useRef, useState } from 'react';
import { View, StyleSheet, PanResponder, LayoutChangeEvent } from 'react-native';

type Props = {
  min: number;
  max: number;
  value: number;
  onValueChange: (value: number) => void;
  color?: string;
  step?: number;
};

export default function Slider({ min, max, value, onValueChange, color = '#00d9a3', step }: Props) {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);

  const pct = max > min ? (value - min) / (max - min) : 0;

  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;

  const layoutRef = useRef({ x: 0 });

  const updateValue = (pageX: number) => {
    const localX = pageX - layoutRef.current.x;
    const ratio = Math.max(0, Math.min(1, localX / widthRef.current));
    let newVal = min + ratio * (max - min);
    newVal = step ? Math.round(newVal / step) * step : Math.round(newVal);
    newVal = Math.max(min, Math.min(max, newVal));
    onValueChangeRef.current(newVal);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (_, gs) => {
        updateValue(gs.x0);
      },
      onPanResponderMove: (_, gs) => {
        updateValue(gs.moveX);
      },
    })
  ).current;

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setWidth(w);
    widthRef.current = w;
    e.target.measureInWindow((x: number) => {
      layoutRef.current.x = x;
    });
  };

  return (
    <View style={styles.container} onLayout={onLayout} {...panResponder.panHandlers}>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: color }]} />
      </View>
      <View style={[styles.thumb, { left: Math.max(0, Math.min(width - 16, pct * width - 8)), backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 24,
    justifyContent: 'center',
  },
  track: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 2,
  },
  thumb: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
  },
});
