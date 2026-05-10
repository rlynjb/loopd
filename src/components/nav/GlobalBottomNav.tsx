import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { getTodayString } from '../../utils/time';

export function GlobalBottomNav() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  // Hide on editor and settings screens
  if (pathname.startsWith('/editor') || pathname.startsWith('/settings')) return null;

  const isHome = pathname === '/' || pathname === '';
  const isJournal = pathname.startsWith('/journal');
  const isTodos = pathname.startsWith('/todos');
  const isVlogs = pathname.startsWith('/vlogs');
  const isMore = pathname.startsWith('/more');

  return (
    <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, 64) }]}>
      <Pressable onPress={() => router.push('/')} style={styles.tab}>
        <Icon name="house" size={18} color={isHome ? colors.accent : colors.textDim} strokeWidth={2.5} />
        <Text style={[styles.label, isHome && { color: colors.accent }]}>Home</Text>
      </Pressable>

      <Pressable onPress={() => router.push(`/journal/${getTodayString()}`)} style={styles.tab}>
        <Icon name="penLine" size={18} color={isJournal ? colors.accent : colors.textDim} strokeWidth={2.5} />
        <Text style={[styles.label, isJournal && { color: colors.accent }]}>Journal</Text>
      </Pressable>

      <Pressable onPress={() => router.push('/todos')} style={styles.tab}>
        <Icon name="listTodo" size={18} color={isTodos ? colors.accent : colors.textDim} strokeWidth={2.5} />
        <Text style={[styles.label, isTodos && { color: colors.accent }]}>Todos</Text>
      </Pressable>

      <Pressable onPress={() => router.push('/vlogs')} style={styles.tab}>
        <Icon name="film" size={18} color={isVlogs ? colors.accent : colors.textDim} strokeWidth={2.5} />
        <Text style={[styles.label, isVlogs && { color: colors.accent }]}>Vlogs</Text>
      </Pressable>

      <Pressable onPress={() => router.push('/more')} style={styles.tab}>
        <Icon name="settings" size={18} color={isMore ? colors.accent : colors.textDim} strokeWidth={2.5} />
        <Text style={[styles.label, isMore && { color: colors.accent }]}>More</Text>
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
});
