import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter, usePathname, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { pickAndCopyClip, recordClip } from '../../services/fileManager';
import { insertEntry } from '../../services/database';
import { generateId } from '../../utils/id';
import { getTodayString } from '../../utils/time';
import type { Entry } from '../../types/entry';
import { emit } from '../../utils/events';

export function GlobalBottomNav() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  // Hide on editor and settings screens
  if (pathname.startsWith('/editor') || pathname.startsWith('/settings')) return null;

  const { showHabits: showHabitsParam } = useLocalSearchParams<{ showHabits?: string }>();
  const isHome = pathname === '/' || pathname === '';
  const isJournal = pathname.startsWith('/journal');

  const createClipEntry = async (result: { uri: string; durationMs: number }) => {
    const today = getTodayString();
    const entry: Entry = {
      id: generateId('entry'),
      date: today,
      text: null,
      habits: [],
      todos: [],
      clipUri: result.uri,
      clipDurationMs: result.durationMs,
      clips: [{ uri: result.uri, durationMs: result.durationMs }],
      createdAt: new Date().toISOString(),
    };
    await insertEntry(entry);
  };

  const handleRecord = async () => {
    const today = getTodayString();
    const result = await recordClip(today);
    if (result) await createClipEntry(result);
  };

  const handleClip = async () => {
    const today = getTodayString();
    const result = await pickAndCopyClip(today);
    if (result) await createClipEntry(result);
  };

  const handleHabit = () => {
    const today = getTodayString();
    if (pathname.startsWith('/journal')) {
      emit('toggleHabitPicker');
    } else {
      router.push(`/journal/${today}?showHabits=1`);
    }
  };

  return (
    <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, 64) }]}>
      <Pressable onPress={() => router.push('/')} style={styles.tab}>
        <Icon name="house" size={18} color={isHome ? colors.accent : colors.textDim} strokeWidth={2.5} />
        <Text style={[styles.label, isHome && { color: colors.accent }]}>Home</Text>
      </Pressable>

      <Pressable onPress={handleRecord} style={styles.tab}>
        <View style={styles.recordBtn}>
          <Icon name="circle" size={20} color={colors.coral} strokeWidth={2.5} />
        </View>
        <Text style={[styles.label, { color: colors.coral }]}>Record</Text>
      </Pressable>

      <Pressable onPress={() => router.push(`/journal/${getTodayString()}`)} style={styles.tab}>
        <Icon name="penLine" size={18} color={isJournal ? colors.accent : colors.textDim} strokeWidth={2.5} />
        <Text style={[styles.label, isJournal && { color: colors.accent }]}>Journal</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: GLOBAL_NAV_HEIGHT,
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    paddingTop: 14,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: colors.textDim,
  },
  recordBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(224,85,85,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
