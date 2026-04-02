import { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import type { Habit } from '../../types/entry';

type Props = {
  habits: Habit[];
  alreadyLogged?: string[];
  initialNote?: string;
  onToggle: (habitId: string, checked: boolean) => void;
  onCancel: () => void;
};

export function HabitPicker({ habits, alreadyLogged = [], initialNote = '', onToggle, onCancel }: Props) {
  const loggedSet = new Set(alreadyLogged);

  return (
    <View style={styles.container}>
      <View style={styles.chipRow}>
        {habits.map(h => {
          const isLogged = loggedSet.has(h.id);
          return (
            <Pressable
              key={h.id}
              onPress={() => onToggle(h.id, !isLogged)}
              style={[styles.chip, isLogged && styles.chipSelected]}
            >
              {isLogged && <Icon name="checkSquare" size={12} color={colors.green} />}
              <Text style={[styles.chipText, isLogged && { color: colors.green }]}>{h.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bg2,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    padding: 12,
    gap: 10,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  chipSelected: {
    borderColor: `${colors.green}50`,
    backgroundColor: `${colors.green}12`,
  },
  chipText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  noteInput: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.text,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  doneBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: colors.green,
  },
  doneBtnText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: '700',
    color: colors.bg,
  },
});
