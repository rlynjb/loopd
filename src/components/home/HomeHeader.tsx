import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { SpinningIcon } from '../ui/SpinningIcon';
import { useNotionSync } from '../../hooks/useNotionSync';
import type { Habit, Entry } from '../../types/entry';

type Props = {
  dayStarted: boolean;
  dateLabel: string;
  entries: Entry[];
  habits: Habit[];
  onBack?: () => void;
};

function formatSyncTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function HomeHeader({ dayStarted, dateLabel, entries, habits, onBack }: Props) {
  const router = useRouter();
  const { status: syncStatus, configured: syncConfigured, syncNow, result: syncResult, lastSynced } = useNotionSync();
  const syncing = syncStatus === 'syncing';


  return (
    <View style={styles.container}>
      {onBack && (
        <Pressable onPress={onBack} style={styles.backBtn} hitSlop={12}>
          <Icon name="dashboard" size={20} color={colors.textMuted} />
        </Pressable>
      )}
      <View style={styles.logoBlock}>
        <Text style={styles.logo}>loopd</Text>
        <Text style={styles.slogan}>Plan. Capture. Reflect. Think.</Text>
      </View>
      <View style={styles.headerRight}>
        {syncConfigured && (
          <Pressable onPress={!syncing ? syncNow : undefined} hitSlop={8} style={styles.headerIconBtn}>
            <SpinningIcon name="refresh" size={18} color={syncing ? colors.accent2 : colors.textDim} spinning={syncing} />
          </Pressable>
        )}
        <Pressable onPress={() => router.push('/settings')} hitSlop={8} style={styles.headerIconBtn}>
          <Icon name="settings" size={18} color={colors.textDim} />
        </Pressable>
      </View>

      {/* Sync status */}
      {syncConfigured && syncResult && syncStatus !== 'syncing' && (
        <View style={styles.syncStatus}>
          {syncResult.pulled > 0 && (
            <Text style={styles.syncStatusText}>↓ {syncResult.pulled} pulled from Notion</Text>
          )}
          {syncResult.pushed > 0 && (
            <Text style={styles.syncStatusText}>↑ {syncResult.pushed} pushed to Notion</Text>
          )}
          {syncResult.pulled === 0 && syncResult.pushed === 0 && syncResult.errors.length === 0 && (
            <Text style={styles.syncStatusText}>Synced — no changes</Text>
          )}
          {syncResult.errors.length > 0 && (
            <Text style={[styles.syncStatusText, { color: colors.coral }]}>{syncResult.errors[0].slice(0, 60)}</Text>
          )}
          {lastSynced && (
            <Text style={styles.syncTimeText}>{formatSyncTime(lastSynced)}</Text>
          )}
        </View>
      )}
      {syncConfigured && syncing && (
        <View style={styles.syncStatus}>
          <Text style={[styles.syncStatusText, { color: colors.accent2 }]}>Syncing with Notion...</Text>
        </View>
      )}

      {dayStarted && (
        <Text style={styles.dateText}>{dateLabel}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  backBtn: {
    position: 'absolute',
    left: 12,
    top: 54,
    padding: 12,
    zIndex: 2,
  },
  headerRight: {
    position: 'absolute',
    right: 12,
    top: 54,
    flexDirection: 'row',
    gap: 4,
    zIndex: 2,
  },
  headerIconBtn: {
    padding: 10,
  },
  syncStatus: {
    alignItems: 'center',
    marginTop: 6,
    gap: 2,
  },
  syncStatusText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.green,
  },
  syncTimeText: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: colors.textDimmer,
  },
  logoBlock: {
    alignItems: 'center',
  },
  logo: {
    fontFamily: fonts.heading,
    fontSize: 24,
    color: colors.accent,
    letterSpacing: -0.4,
  },
  slogan: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 0.3,
    fontStyle: 'italic',
    marginTop: 2,
  },
  dateText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
    textAlign: 'center',
    marginTop: 6,
  },
});
