import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { TYPE_META, TYPES_IN_ORDER } from '../../services/todos/typeMeta';
import type { TodoType } from '../../types/todoMeta';

type Props = {
  visible: boolean;
  todoText: string;
  currentType: TodoType;
  onCancel: () => void;
  onPick: (type: TodoType) => void;
};

// Bottom-sheet picker for manual type override. Tapping a row commits the
// change and dismisses; the parent flips user_overridden_type to true so
// the row is locked from future re-classification.
export function TypeChangePicker({ visible, todoText, currentType, onCancel, onPick }: Props) {
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
          <Text style={styles.title}>change type</Text>
          <Text style={styles.quote} numberOfLines={2}>"{todoText}"</Text>

          <View style={styles.list}>
            {TYPES_IN_ORDER.map(t => {
              const meta = TYPE_META[t];
              const isCurrent = t === currentType;
              return (
                <Pressable
                  key={t}
                  onPress={() => onPick(t)}
                  style={[styles.row, isCurrent && styles.rowActive]}
                >
                  <View style={[styles.bullet, isCurrent && styles.bulletActive]} />
                  <Icon name={meta.icon} size={14} color={meta.color} />
                  <Text style={[styles.label, isCurrent && { color: colors.text }]}>{meta.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.footnote}>
            your choice locks this row from future AI re-classification
          </Text>

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
  footnote: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    marginTop: 12,
    textAlign: 'center',
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
