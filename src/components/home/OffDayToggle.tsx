// Two-chip segmented control for the daily-schedule grid's off-day rendering.
// Persists per-user choice to SecureStore. See spec §2.7.
import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { colors, fonts } from '../../constants/theme';

const STORAGE_KEY = 'daily_schedule_offday_mode';

export type OffDayMode = 'hidden' | 'faded';

const DEFAULT_MODE: OffDayMode = 'faded';

export function getStoredOffDayMode(): Promise<OffDayMode> {
  return SecureStore.getItemAsync(STORAGE_KEY).then(v => {
    if (v === 'hidden' || v === 'faded') return v;
    return DEFAULT_MODE;
  });
}

export function OffDayToggle({
  mode,
  onChange,
}: {
  mode: OffDayMode;
  onChange: (next: OffDayMode) => void;
}) {
  const setAndPersist = useCallback(async (next: OffDayMode) => {
    if (next === mode) return;
    onChange(next);
    try {
      await SecureStore.setItemAsync(STORAGE_KEY, next);
    } catch (err) {
      console.warn('[buffr] off-day mode persist failed:', err);
    }
  }, [mode, onChange]);

  return (
    <View style={styles.row}>
      <Text style={styles.label}>off-days:</Text>
      <View style={styles.chipGroup}>
        <Chip label="hidden" active={mode === 'hidden'} onPress={() => setAndPersist('hidden')} />
        <Chip label="faded" active={mode === 'faded'} onPress={() => setAndPersist('faded')} />
      </View>
    </View>
  );
}

/** Hook that loads + provides the persisted mode. */
export function useOffDayMode(): [OffDayMode, (next: OffDayMode) => void] {
  const [mode, setMode] = useState<OffDayMode>(DEFAULT_MODE);
  useEffect(() => {
    let cancelled = false;
    getStoredOffDayMode().then(stored => {
      if (!cancelled) setMode(stored);
    });
    return () => { cancelled = true; };
  }, []);
  return [mode, setMode];
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 1,
    textTransform: 'lowercase',
  },
  chipGroup: {
    flexDirection: 'row',
    gap: 6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  chipActive: {
    borderColor: 'rgba(232, 213, 176, 0.5)',
    backgroundColor: 'rgba(232, 213, 176, 0.08)',
  },
  chipText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 0.5,
  },
  chipTextActive: {
    color: 'rgba(232, 213, 176, 0.9)',
  },
});
