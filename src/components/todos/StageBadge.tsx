import { Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { STAGE_META } from '../../services/todos/stageMeta';
import type { TodoStage } from '../../types/todoMeta';

type Props = {
  stage: TodoStage;
  onPress?: () => void;
};

// Always-visible chip showing the current stage. Default ('todo') gets a
// muted look so it doesn't shout; in_progress and backlog stand out.
// Tapping opens the StageChangePicker.
export function StageBadge({ stage, onPress }: Props) {
  const meta = STAGE_META[stage];
  const tinted = `${meta.color}15`;
  const border = `${meta.color}40`;

  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={[styles.badge, { borderColor: border, backgroundColor: tinted }]}
    >
      <Icon name={meta.icon} size={10} color={meta.color} />
      <Text style={[styles.label, { color: meta.color }]}>{meta.label.toLowerCase()}</Text>
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
});
