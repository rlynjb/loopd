import { useState, useCallback } from 'react';
import { View, Text, Pressable, TextInput, Switch, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';
import { useNotionSync } from '../../src/hooks/useNotionSync';
import {
  getNotionToken, setNotionToken,
  getDailyLogDbId, setDailyLogDbId,
  getEntriesDbId, setEntriesDbId,
  isAutoSyncEnabled, setAutoSync,
  clearNotionConfig, setLastSyncTimestamp,
} from '../../src/services/notion/config';
import { getDatabase as testNotionDb } from '../../src/services/notion/api';

export default function NotionSyncScreen() {
  const router = useRouter();
  const { status, lastSynced, result, configured, syncNow, refresh } = useNotionSync();

  const [token, setToken] = useState('');
  const [entriesDb, setEntriesDb] = useState('');
  const [dailyLogDb, setDailyLogDb] = useState('');
  const [autoSyncOn, setAutoSyncOn] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showToken, setShowToken] = useState(false);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        setToken(await getNotionToken() ?? '');
        setEntriesDb(await getEntriesDbId() ?? '');
        setDailyLogDb(await getDailyLogDbId() ?? '');
        setAutoSyncOn(await isAutoSyncEnabled());
        refresh();
      })();
    }, [])
  );

  const saveCredentials = async () => {
    await setNotionToken(token.trim());
    await setEntriesDbId(entriesDb.trim());
    await setDailyLogDbId(dailyLogDb.trim());
    refresh();
  };

  const handleTestConnection = async () => {
    await saveCredentials();
    setTesting(true);
    setTestResult(null);
    try {
      const t = token.trim();
      const eDb = entriesDb.trim();
      if (!t || !eDb) throw new Error('Token and Entries DB ID are required');
      await testNotionDb(t, eDb);
      if (dailyLogDb.trim()) await testNotionDb(t, dailyLogDb.trim());
      setTestResult({ ok: true, msg: 'Connected successfully' });
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestResult({ ok: false, msg });
    } finally {
      setTesting(false);
    }
  };

  const handleDisconnect = async () => {
    await clearNotionConfig();
    setToken('');
    setEntriesDb('');
    setDailyLogDb('');
    setTestResult(null);
    refresh();
  };

  const handleAutoSyncToggle = async (val: boolean) => {
    setAutoSyncOn(val);
    await setAutoSync(val);
  };

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
        <Text style={styles.title}>Notion Sync</Text>

        {/* Status */}
        <View style={[styles.statusBanner, configured ? styles.statusConnected : styles.statusDisconnected]}>
          <View style={[styles.statusDot, { backgroundColor: configured ? colors.green : colors.amber }]} />
          <Text style={[styles.statusLabel, { color: configured ? colors.green : colors.amber }]}>
            {configured ? 'Connected to Notion' : 'Not configured'}
          </Text>
          <Text style={styles.statusSub}>Last sync: {formatLastSync(lastSynced)}</Text>
        </View>

        {/* Credentials */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Credentials</Text>
          <Text style={styles.cardSub}>Stored locally on your device.</Text>

          <Text style={styles.fieldLabel}>INTEGRATION TOKEN</Text>
          <View style={styles.inputRow}>
            <TextInput
              value={token} onChangeText={setToken} onBlur={saveCredentials}
              placeholder="ntn_xxxxxxxxxxxxxxxx" placeholderTextColor={colors.textDimmer}
              secureTextEntry={!showToken} autoCapitalize="none" autoCorrect={false}
              style={[styles.input, { flex: 1 }]}
            />
            <Pressable onPress={() => setShowToken(!showToken)} style={styles.toggleBtn}>
              <Icon name={showToken ? 'x' : 'target'} size={16} color={colors.textDim} />
            </Pressable>
          </View>

          <Text style={styles.fieldLabel}>ENTRIES DATABASE ID</Text>
          <TextInput
            value={entriesDb} onChangeText={setEntriesDb} onBlur={saveCredentials}
            placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" placeholderTextColor={colors.textDimmer}
            autoCapitalize="none" autoCorrect={false} style={styles.input}
          />

          <Text style={styles.fieldLabel}>DAILY LOG DATABASE ID (optional)</Text>
          <TextInput
            value={dailyLogDb} onChangeText={setDailyLogDb} onBlur={saveCredentials}
            placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" placeholderTextColor={colors.textDimmer}
            autoCapitalize="none" autoCorrect={false} style={styles.input}
          />

          {testResult && (
            <View style={[styles.testResult, testResult.ok ? styles.testSuccess : styles.testFail]}>
              <Text style={[styles.testResultText, { color: testResult.ok ? colors.green : colors.coral }]}>
                {testResult.ok ? '✓' : '✕'} {testResult.msg}
              </Text>
            </View>
          )}

          <View style={styles.btnRow}>
            <Pressable onPress={handleTestConnection} disabled={testing} style={styles.testBtn}>
              {testing ? <ActivityIndicator size="small" color={colors.accent2} /> : <Text style={styles.testBtnText}>Test connection</Text>}
            </Pressable>
            {configured && (
              <Pressable onPress={handleDisconnect} style={styles.disconnectBtn}>
                <Text style={styles.disconnectBtnText}>Disconnect</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* Sync controls */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Sync</Text>

          <View style={styles.syncRow}>
            <Text style={styles.syncLabel}>Auto-sync on app open</Text>
            <Switch
              value={autoSyncOn} onValueChange={handleAutoSyncToggle}
              trackColor={{ false: colors.bg3, true: `${colors.green}60` }}
              thumbColor={autoSyncOn ? colors.green : colors.textDim}
            />
          </View>

          <Pressable
            onPress={configured && status !== 'syncing' ? syncNow : undefined}
            style={[styles.syncBtn, (!configured || status === 'syncing') && { opacity: 0.4 }]}
          >
            {status === 'syncing' ? (
              <ActivityIndicator size="small" color={colors.bg} />
            ) : (
              <Text style={styles.syncBtnText}>Sync Now</Text>
            )}
          </Pressable>

          {result && (
            <Text style={[styles.resultText, { color: result.errors.length > 0 ? colors.coral : colors.green }]}>
              {result.errors.length > 0 ? result.errors[0] : `${result.pulled} pulled, ${result.pushed} pushed`}
            </Text>
          )}

          {configured && (
            <Pressable
              onPress={async () => { await setLastSyncTimestamp(''); refresh(); }}
              style={styles.resetBtn}
            >
              <Text style={styles.resetBtnText}>Reset sync timestamp (force full re-sync)</Text>
            </Pressable>
          )}
        </View>
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
  statusBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: colors.radius, borderWidth: 1 },
  statusConnected: { borderColor: `${colors.green}35`, backgroundColor: `${colors.green}06` },
  statusDisconnected: { borderColor: `${colors.amber}30`, backgroundColor: `${colors.amber}05` },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { fontFamily: fonts.body, fontSize: 13, fontWeight: '500', flex: 1 },
  statusSub: { fontFamily: fonts.mono, fontSize: 9, color: colors.textDim },
  card: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: colors.radiusLg, padding: 18 },
  cardTitle: { fontFamily: fonts.body, fontSize: 14, fontWeight: '600', color: colors.text, marginBottom: 4 },
  cardSub: { fontFamily: fonts.mono, fontSize: 10, color: colors.textDim, marginBottom: 16 },
  fieldLabel: { fontFamily: fonts.mono, fontSize: 9, color: colors.textDim, letterSpacing: 0.6, marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: colors.radius, paddingHorizontal: 12, paddingVertical: 10, fontFamily: fonts.mono, fontSize: 12, color: colors.text },
  inputRow: { flexDirection: 'row', gap: 8 },
  toggleBtn: { width: 40, backgroundColor: colors.bg3, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: colors.radius, alignItems: 'center', justifyContent: 'center' },
  testResult: { marginTop: 12, padding: 10, borderRadius: 8, borderWidth: 1 },
  testSuccess: { borderColor: `${colors.green}25`, backgroundColor: `${colors.green}08` },
  testFail: { borderColor: `${colors.coral}25`, backgroundColor: `${colors.coral}08` },
  testResultText: { fontFamily: fonts.mono, fontSize: 11, lineHeight: 16 },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  testBtn: { flex: 1, paddingVertical: 12, borderRadius: colors.radius, borderWidth: 1, borderColor: colors.accent2, alignItems: 'center' },
  testBtnText: { fontFamily: fonts.body, fontSize: 13, fontWeight: '500', color: colors.accent },
  disconnectBtn: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: colors.radius, borderWidth: 1, borderColor: `${colors.coral}30` },
  disconnectBtnText: { fontFamily: fonts.body, fontSize: 13, color: colors.coral },
  syncRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  syncLabel: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted },
  syncBtn: { paddingVertical: 14, borderRadius: colors.radius, backgroundColor: colors.accent, alignItems: 'center' },
  syncBtnText: { fontFamily: fonts.body, fontSize: 14, fontWeight: '600', color: colors.bg },
  resultText: { fontFamily: fonts.mono, fontSize: 10, textAlign: 'center', marginTop: 10 },
  resetBtn: { marginTop: 14, paddingVertical: 10, borderRadius: colors.radius, borderWidth: 1, borderColor: colors.cardBorder, alignItems: 'center' },
  resetBtnText: { fontFamily: fonts.mono, fontSize: 10, color: colors.textDim },
});
