import { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, Keyboard, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { Icon, type IconName } from '../ui/Icon';
import type { Habit } from '../../types/entry';

type Action = {
  icon: IconName;
  label: string;
  onPress: () => void;
};

type Props = {
  actions: Action[];
  visible: boolean;
  // Habit sub-view
  habits?: Habit[];
  alreadyLoggedHabits?: string[];
  onToggleHabit?: (habitId: string, checked: boolean) => void;
  showHabits?: boolean;
  onShowHabits?: (show: boolean) => void;
};

export function KeyboardToolbar({
  actions, visible,
  habits, alreadyLoggedHabits = [], onToggleHabit,
  showHabits, onShowHabits,
}: Props) {
  const [keyboardTop, setKeyboardTop] = useState(0);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardTop(e.endCoordinates.screenY);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardTop(0);
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  if (!visible || keyboardTop === 0) return null;

  const loggedSet = new Set(alreadyLoggedHabits);

  return (
    <View style={[styles.container, { top: keyboardTop - 44 }]}>
      {showHabits ? (
        // Sub-view: habit chips
        <>
          <Pressable onPress={() => onShowHabits?.(false)} style={styles.backBtn}>
            <Icon name="chevronLeft" size={18} color={colors.textMuted} />
          </Pressable>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.habitScroll}>
            {habits?.map(h => {
              const isLogged = loggedSet.has(h.id);
              return (
                <Pressable
                  key={h.id}
                  onPress={() => onToggleHabit?.(h.id, !isLogged)}
                  style={[styles.habitChip, isLogged && styles.habitChipActive]}
                >
                  {isLogged && <Icon name="checkSquare" size={12} color={colors.green} />}
                  <Text style={[styles.habitLabel, isLogged && { color: colors.green }]}>{h.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </>
      ) : (
        // Main toolbar actions
        actions.map((action, i) => (
          <Pressable key={i} onPress={action.onPress} style={styles.btn}>
            <Icon name={action.icon} size={18} color={colors.textMuted} />
            <Text style={styles.label}>{action.label}</Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 44,
    flexDirection: 'row',
    backgroundColor: colors.bg2,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    alignItems: 'center',
    paddingHorizontal: 8,
    gap: 8,
    zIndex: 100,
  },
  backBtn: {
    padding: 6,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textMuted,
  },
  habitScroll: {
    gap: 6,
    alignItems: 'center',
  },
  habitChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  habitChipActive: {
    borderColor: `${colors.green}50`,
    backgroundColor: `${colors.green}12`,
  },
  habitLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
  },
});
