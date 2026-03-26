import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import type { ClipItem } from '../../types/project';

type Props = {
  clip: ClipItem;
  playheadPctInClip: number;
  onDelete: () => void;
  onSplit: () => void;
};

export function ClipEditor({ clip, playheadPctInClip, onDelete, onSplit }: Props) {
  const canSplit = playheadPctInClip > 5 && playheadPctInClip < 95;

  return (
    <View style={[styles.container, { backgroundColor: `${clip.color}08`, borderColor: `${clip.color}20` }]}>
      <View style={styles.actionRow}>
        <Pressable
          onPress={canSplit ? onSplit : undefined}
          style={[styles.splitBtn, !canSplit && styles.splitBtnDisabled]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon name="scissors" size={12} color={canSplit ? colors.amber : colors.textDimmer} />
            <Text style={[styles.splitBtnText, !canSplit && styles.splitBtnTextDisabled]}>Split</Text>
          </View>
        </Pressable>
        <Pressable onPress={onDelete} style={[styles.actionBtn, styles.deleteBtn]}>
          <Icon name="trash" size={14} color={colors.coral} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 0,
    padding: 12,
    marginBottom: 14,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 6,
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
  deleteBtn: {
    backgroundColor: 'rgba(251,113,133,0.1)',
    borderColor: 'rgba(251,113,133,0.2)',
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
