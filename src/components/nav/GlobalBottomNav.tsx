import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { pickAndCopyClip } from '../../services/fileManager';
import { insertEntry } from '../../services/database';
import { generateId } from '../../utils/id';
import { getTodayString } from '../../utils/time';
import type { Entry } from '../../types/entry';

export function GlobalBottomNav() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  // Hide on editor and settings screens
  if (pathname.startsWith('/editor') || pathname.startsWith('/settings')) return null;

  const isHome = pathname === '/' || pathname === '';
  const isEdit = pathname.startsWith('/editor');

  const handleRecord = async () => {
    const today = getTodayString();
    const result = await pickAndCopyClip(today);
    if (result) {
      const entry: Entry = {
        id: generateId('entry'),
        date: today,
        text: null,
        mood: null,
        category: null,
        habits: [],
        clipUri: result.uri,
        clipDurationMs: result.durationMs,
        clips: [{ uri: result.uri, durationMs: result.durationMs }],
        createdAt: new Date().toISOString(),
      };
      await insertEntry(entry);
    }
  };

  return (
    <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, 64) }]}>
      <Pressable onPress={() => router.push('/')} style={styles.tab}>
        <Icon name="house" size={20} color={isHome ? colors.accent : colors.textDim} />
        <Text style={[styles.label, isHome && { color: colors.accent }]}>Home</Text>
      </Pressable>

      <Pressable onPress={handleRecord} style={styles.tab}>
        <View style={styles.recordBtn}>
          <Icon name="circle" size={22} color={colors.coral} />
        </View>
        <Text style={[styles.label, { color: colors.coral }]}>Record</Text>
      </Pressable>

      <Pressable onPress={() => router.push(`/editor/${getTodayString()}`)} style={styles.tab}>
        <Icon name="clapperboard" size={20} color={isEdit ? colors.accent : colors.textDim} />
        <Text style={[styles.label, isEdit && { color: colors.accent }]}>Edit</Text>
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
