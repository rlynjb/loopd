import { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import * as Updates from 'expo-updates';
import { colors, fonts } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';

export default function UpdatesScreen() {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const checkForUpdates = async () => {
    if (__DEV__) {
      setStatusMsg('Updates are disabled in development mode');
      return;
    }
    setChecking(true);
    setStatusMsg(null);
    try {
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable) {
        setStatusMsg('Update found. Downloading...');
        setChecking(false);
        setDownloading(true);
        await Updates.fetchUpdateAsync();
        setDownloading(false);
        setUpdateReady(true);
        setStatusMsg('Update downloaded. Ready to install.');
      } else {
        setStatusMsg('You are on the latest version');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMsg(`Check failed: ${msg}`);
    } finally {
      setChecking(false);
      setDownloading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 8 }}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.title}>App Updates</Text>

        <View style={styles.card}>
          <View style={styles.versionRow}>
            <Text style={styles.versionLabel}>Version</Text>
            <Text style={styles.versionValue}>{Updates.runtimeVersion ?? '1.0.0'}</Text>
          </View>

          {statusMsg && (
            <Text style={[
              styles.statusText,
              {
                color: updateReady ? colors.green
                  : statusMsg.startsWith('Check failed') ? colors.coral
                  : statusMsg.includes('latest') ? colors.green
                  : colors.textMuted,
              },
            ]}>
              {statusMsg}
            </Text>
          )}

          {updateReady ? (
            <Pressable onPress={() => Updates.reloadAsync()} style={[styles.btn, { backgroundColor: colors.green }]}>
              <Text style={styles.btnText}>Install & Restart</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={!checking && !downloading ? checkForUpdates : undefined}
              style={[styles.btn, (checking || downloading) && { opacity: 0.4 }]}
            >
              {checking || downloading ? (
                <ActivityIndicator size="small" color={colors.bg} />
              ) : (
                <Text style={styles.btnText}>Check for Updates</Text>
              )}
            </Pressable>
          )}
        </View>

        <Text style={styles.infoText}>
          Updates are delivered over-the-air. When a new update is available, it downloads in the background and you can install it with a single tap.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  scroll: { flex: 1 },
  content: { padding: 24, paddingBottom: 60, gap: 20 },
  title: { fontFamily: fonts.heading, fontSize: 28, color: colors.text, letterSpacing: -0.5 },
  card: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: colors.radiusLg, padding: 18, gap: 14 },
  versionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  versionLabel: { fontFamily: fonts.body, fontSize: 14, color: colors.textMuted },
  versionValue: { fontFamily: fonts.mono, fontSize: 13, color: colors.accent },
  statusText: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 16 },
  btn: { paddingVertical: 14, borderRadius: colors.radius, backgroundColor: colors.accent, alignItems: 'center' },
  btnText: { fontFamily: fonts.body, fontSize: 14, fontWeight: '600', color: colors.bg },
  infoText: { fontFamily: fonts.body, fontSize: 12, color: colors.textDim, lineHeight: 18 },
});
