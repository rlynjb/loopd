import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { colors, fonts } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';
import { isNotionConfigured, getLastSyncTimestamp } from '../../src/services/notion/config';

export default function SettingsMenu() {
  const router = useRouter();
  const [configured, setConfigured] = useState(false);
  const [lastSynced, setLastSynced] = useState<string | null>(null);

  useEffect(() => {
    isNotionConfigured().then(setConfigured);
    getLastSyncTimestamp().then(setLastSynced);
  }, []);

  const formatLastSync = (ts: string | null): string => {
    if (!ts) return 'Never';
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ts).toLocaleDateString();
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 8 }}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Settings</Text>

        {/* Notion Sync */}
        <Pressable onPress={() => router.push('/settings/notion-sync')} style={styles.menuItem}>
          <View style={styles.menuIcon}>
            <Icon name="refresh" size={18} color={colors.accent2} />
          </View>
          <View style={styles.menuInfo}>
            <Text style={styles.menuLabel}>Notion Sync</Text>
            <Text style={styles.menuSub}>
              {configured ? `Connected — last sync ${formatLastSync(lastSynced)}` : 'Not configured'}
            </Text>
          </View>
          <View style={[styles.menuDot, { backgroundColor: configured ? colors.green : colors.amber }]} />
        </Pressable>

        {/* Notion Setup Guide */}
        <Pressable onPress={() => router.push('/settings/notion-guide')} style={styles.menuItem}>
          <View style={styles.menuIcon}>
            <Icon name="bookOpen" size={18} color={colors.accent2} />
          </View>
          <View style={styles.menuInfo}>
            <Text style={styles.menuLabel}>Notion Setup Guide</Text>
            <Text style={styles.menuSub}>How to set up your Notion databases</Text>
          </View>
        </Pressable>

        {/* App Updates */}
        <Pressable onPress={() => router.push('/settings/updates')} style={styles.menuItem}>
          <View style={styles.menuIcon}>
            <Icon name="zap" size={18} color={colors.accent2} />
          </View>
          <View style={styles.menuInfo}>
            <Text style={styles.menuLabel}>App Updates</Text>
            <Text style={styles.menuSub}>Check for new versions</Text>
          </View>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 24,
    paddingBottom: 60,
    gap: 12,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 28,
    color: colors.text,
    letterSpacing: -0.5,
    marginBottom: 12,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: colors.radiusLg,
    padding: 16,
  },
  menuIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: `${colors.accent2}10`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuInfo: {
    flex: 1,
    gap: 2,
  },
  menuLabel: {
    fontFamily: fonts.body,
    fontSize: 15,
    fontWeight: '500',
    color: colors.text,
  },
  menuSub: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
  },
  menuDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
