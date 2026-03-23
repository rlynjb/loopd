import { View, Text, Pressable, TextInput, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import type { ClipItem } from '../../types/project';

type Props = {
  clip: ClipItem;
  playheadPctInClip: number;
  onUpdate: (updates: Partial<ClipItem>) => void;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onDelete: () => void;
  onSplit: () => void;
};

export function ClipEditor({ clip, playheadPctInClip, onUpdate, onMoveLeft, onMoveRight, onDelete, onSplit }: Props) {
  // Can split if playhead is inside the clip (not at the very start or end)
  const canSplit = playheadPctInClip > 5 && playheadPctInClip < 95;

  return (
    <View style={[styles.container, { backgroundColor: `${clip.color}08`, borderColor: `${clip.color}20` }]}>
      <Text style={[styles.headerLabel, { color: clip.color }]} numberOfLines={1}>
        EDIT — 🎥 {clip.caption.slice(0, 24)}
      </Text>

      <View style={styles.actionRow}>
        <Pressable
          onPress={canSplit ? onSplit : undefined}
          style={[styles.splitBtn, !canSplit && styles.splitBtnDisabled]}
        >
          <Text style={[styles.splitBtnText, !canSplit && styles.splitBtnTextDisabled]}>✂ Split</Text>
        </Pressable>
        <Pressable onPress={onMoveLeft} style={styles.actionBtn}>
          <Text style={styles.actionBtnText}>◀</Text>
        </Pressable>
        <Pressable onPress={onMoveRight} style={styles.actionBtn}>
          <Text style={styles.actionBtnText}>▶</Text>
        </Pressable>
        <Pressable onPress={onDelete} style={[styles.actionBtn, styles.deleteBtn]}>
          <Text style={styles.deleteBtnText}>✕</Text>
        </Pressable>
      </View>

      <Text style={styles.fieldLabel}>CAPTION</Text>
      <TextInput
        value={clip.caption}
        onChangeText={caption => onUpdate({ caption })}
        style={styles.textArea}
        multiline
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
  },
  headerLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
    marginBottom: 10,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 14,
  },
  actionBtn: {
    width: 28,
    height: 28,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnText: {
    color: colors.textMuted,
    fontSize: 11,
  },
  deleteBtn: {
    backgroundColor: 'rgba(251,113,133,0.1)',
    borderColor: 'rgba(251,113,133,0.2)',
  },
  deleteBtnText: {
    color: colors.coral,
    fontSize: 11,
  },
  fieldLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
    marginBottom: 8,
  },
  textArea: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: 12,
    color: colors.text,
    fontSize: 13,
    fontFamily: fonts.body,
    height: 56,
    textAlignVertical: 'top',
    marginBottom: 14,
  },
  splitBtn: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 7,
    backgroundColor: 'rgba(251,191,36,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  splitBtnDisabled: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderColor: 'rgba(255,255,255,0.06)',
  },
  splitBtnText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.amber,
    letterSpacing: 0.5,
  },
  splitBtnTextDisabled: {
    color: colors.textDimmer,
  },
});
