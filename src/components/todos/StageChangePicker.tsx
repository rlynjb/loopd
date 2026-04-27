import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { STAGE_META, STAGES_IN_ORDER } from '../../services/todos/stageMeta';
import type { TodoStage } from '../../types/todoMeta';

type Props = {
  visible: boolean;
  todoText: string;
  currentStage: TodoStage;
  onCancel: () => void;
  onPick: (stage: TodoStage) => void;
};

// Bottom-sheet picker for the lifecycle stage. Smaller list than
// TypeChangePicker (3 options vs 7) but shares the same visual structure
// for consistency.
export function StageChangePicker({ visible, todoText, currentStage, onCancel, onPick }: Props) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onCancel}
    >
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={styles.sheet} onPress={() => { /* swallow */ }}>
          <View style={styles.handle} />
          <Text style={styles.title}>set stage</Text>
          <Text style={styles.quote} numberOfLines={2}>"{todoText}"</Text>

          <View style={styles.list}>
            {STAGES_IN_ORDER.map(s => {
              const meta = STAGE_META[s];
              const isCurrent = s === currentStage;
              return (
                <Pressable
                  key={s}
                  onPress={() => onPick(s)}
                  style={[styles.row, isCurrent && styles.rowActive]}
                >
                  <View style={[styles.bullet, isCurrent && styles.bulletActive]} />
                  <Icon name={meta.icon} size={14} color={meta.color} />
                  <Text style={[styles.label, isCurrent && { color: colors.text }]}>{meta.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable onPress={onCancel} style={styles.cancel}>
            <Text style={styles.cancelText}>cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.bg2,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 32,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignSelf: 'center',
    marginBottom: 16,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: colors.text,
    marginBottom: 6,
  },
  quote: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textDim,
    fontStyle: 'italic',
    backgroundColor: colors.bg3,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    marginBottom: 16,
  },
  list: {
    gap: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  rowActive: {
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  bullet: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.textDim,
  },
  bulletActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  label: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.textMuted,
  },
  cancel: {
    alignSelf: 'center',
    marginTop: 12,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  cancelText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
    letterSpacing: 0.5,
  },
});
