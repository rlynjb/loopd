import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { TYPE_META } from '../../services/todos/typeMeta';
import type { TodoType, ClassifierConfidence } from '../../types/todoMeta';

type Props = {
  type: TodoType;
  confidence?: ClassifierConfidence | null;
  onPress?: () => void;
};

// Per pushback #3 in the implementation plan: plain 'todo' rows render
// nothing. The absence of a badge IS the signal that a row is a plain
// todo — adding the ☐ badge to 60%+ of rows would be visual noise.
//
// Non-todo rows render a colored pill with type icon + label, plus a "?"
// glyph when the classifier wasn't confident (medium/low). Pressing the
// pill opens the manual type-change picker.
export function TypeBadge({ type, confidence, onPress }: Props) {
  if (type === 'todo') return null;
  const meta = TYPE_META[type];
  const showUncertain = confidence === 'medium' || confidence === 'low';

  const tinted = `${meta.color}1f`;       // ~12% alpha background
  const border = `${meta.color}55`;       // ~33% alpha border

  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={[styles.badge, { borderColor: border, backgroundColor: tinted }]}
    >
      <Icon name={meta.icon} size={11} color={meta.color} />
      <Text style={[styles.label, { color: meta.color }]}>{meta.label.toLowerCase()}</Text>
      {showUncertain && (
        <Text style={[styles.uncertain, { color: meta.color }]}>?</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderWidth: 1,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.4,
  },
  uncertain: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: '700',
    marginLeft: 1,
    opacity: 0.7,
  },
});
