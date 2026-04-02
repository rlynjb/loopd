import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { HabitPicker } from './HabitPicker';
import { pickAndCopyClip } from '../../services/fileManager';
import type { Habit, Entry } from '../../types/entry';

type Props = {
  date: string;
  habits: Habit[];
  alreadyLoggedHabits: string[];
  expanded: 'habit' | null;
  onExpand: (type: 'habit' | null) => void;
  onToggleHabit: (habitId: string, checked: boolean) => void;
  onSaveClip: (result: { uri: string; durationMs: number }) => void;
  editingEntry?: Entry | null;
  onEditDone?: (updatedEntry: Entry) => void;
};

export function JournalToolbar({
  date, habits, alreadyLoggedHabits, expanded, onExpand,
  onToggleHabit, onSaveClip,
  editingEntry, onEditDone,
}: Props) {

  const handleClip = async () => {
    const result = await pickAndCopyClip(date);
    if (result) onSaveClip(result);
  };



  return (
    <View style={[styles.wrapper, { bottom: GLOBAL_NAV_HEIGHT }]}>
      {/* Expanded picker */}
      {expanded === 'habit' && (
        <HabitPicker
          habits={habits}
          alreadyLogged={alreadyLoggedHabits}
          onToggle={onToggleHabit}
          onCancel={() => onExpand(null)}
        />
      )}
      {/* Toolbar buttons */}
      <View style={styles.toolbar}>
        <Pressable
          onPress={() => onExpand(expanded === 'habit' ? null : 'habit')}
          style={[styles.btn, expanded === 'habit' && styles.btnActive]}
        >
          <Icon name="checkSquare" size={16} color={expanded === 'habit' ? colors.green : colors.textDim} />
          <Text style={[styles.btnLabel, expanded === 'habit' && { color: colors.green }]}>Habit</Text>
        </Pressable>

        <Pressable onPress={handleClip} style={styles.btn}>
          <Icon name="video" size={16} color={colors.coral} />
          <Text style={[styles.btnLabel, { color: colors.coral }]}>Clip</Text>
        </Pressable>

      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  toolbar: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    paddingVertical: 8,
  },
  btn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 4,
  },
  btnActive: {
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  btnLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
  },
});
