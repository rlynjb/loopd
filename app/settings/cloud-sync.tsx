// Minimal cloud-sync page for M1 testing. Push button + last-result.
// M5 fleshes this out (status, dev menu, force pull, etc).
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { colors, fonts } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';
import { isCloudConfigured } from '../../src/services/sync/client';
import { pushAll } from '../../src/services/sync/orchestrator';
import { getAllSyncMeta, type SyncMetaRow } from '../../src/services/sync/syncMeta';
import type { PushResult } from '../../src/services/sync/types';

export default function CloudSyncScreen() {
  const router = useRouter();
  const [configured] = useState(isCloudConfigured());
  const [pushing, setPushing] = useState(false);
  const [results, setResults] = useState<PushResult[] | null>(null);
  const [meta, setMeta] = useState<SyncMetaRow[]>([]);

  const refreshMeta = async () => {
    try {
      setMeta(await getAllSyncMeta());
    } catch (err) {
      console.warn('[loopd] sync meta load failed:', err);
    }
  };

  useEffect(() => { refreshMeta(); }, []);

  const handlePush = async () => {
    setPushing(true);
    const r = await pushAll();
    setResults(r);
    await refreshMeta();
    setPushing(false);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 8 }}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Cloud Sync</Text>

        <View style={styles.statusCard}>
          <Text style={styles.statusLabel}>STATUS</Text>
          <Text style={[styles.statusValue, { color: configured ? colors.green : colors.amber }]}>
            {configured ? 'CONFIGURED' : 'NOT CONFIGURED'}
          </Text>
          {!configured && (
            <Text style={styles.hint}>
              Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in .env, then rebuild the app.
            </Text>
          )}
        </View>

        <Pressable
          onPress={handlePush}
          disabled={!configured || pushing}
          style={[styles.pushBtn, (!configured || pushing) && { opacity: 0.4 }]}
        >
          <Icon name="upload" size={16} color={colors.amber} />
          <Text style={styles.pushBtnText}>{pushing ? 'PUSHING…' : 'PUSH ALL NOW'}</Text>
        </Pressable>

        {results && (
          <View style={styles.resultsCard}>
            <Text style={styles.statusLabel}>LAST PUSH</Text>
            {results.length === 0
              ? <Text style={styles.hint}>No tables registered.</Text>
              : results.map(r => (
                <View key={r.tableName} style={styles.resultRow}>
                  <Text style={styles.tableName}>{r.tableName}</Text>
                  <Text style={[
                    styles.resultText,
                    { color: r.failed > 0 ? colors.coral : r.succeeded > 0 ? colors.green : colors.textDim },
                  ]}>
                    {r.attempted === 0 ? 'nothing to push' : `${r.succeeded}/${r.attempted} ok${r.failed > 0 ? `, ${r.failed} failed` : ''}`}
                  </Text>
                  {r.error && <Text style={styles.errorText}>{r.error}</Text>}
                </View>
              ))}
          </View>
        )}

        {meta.length > 0 && (
          <View style={styles.resultsCard}>
            <Text style={styles.statusLabel}>SYNC LEDGER</Text>
            {meta.map(m => (
              <View key={m.tableName} style={styles.resultRow}>
                <Text style={styles.tableName}>{m.tableName}</Text>
                <Text style={styles.metaText}>
                  push: {m.lastPushAt ? new Date(m.lastPushAt).toLocaleTimeString() : '—'}
                  {m.lastError ? ` · err: ${m.lastError.slice(0, 40)}` : ''}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  scroll: { flex: 1 },
  content: { padding: 24, paddingBottom: 60, gap: 16 },
  title: { fontFamily: fonts.heading, fontSize: 28, color: colors.text, letterSpacing: -0.5, marginBottom: 4 },
  statusCard: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: colors.radiusLg, padding: 16, gap: 6 },
  statusLabel: { fontFamily: fonts.mono, fontSize: 10, color: colors.textDim, letterSpacing: 1 },
  statusValue: { fontFamily: fonts.mono, fontSize: 14, letterSpacing: 1 },
  hint: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, lineHeight: 18 },
  pushBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 14, borderRadius: colors.radiusLg,
    borderWidth: 1, borderColor: 'rgba(251,191,36,0.3)', backgroundColor: 'rgba(251,191,36,0.08)',
  },
  pushBtnText: { fontFamily: fonts.mono, fontSize: 12, color: colors.amber, letterSpacing: 1 },
  resultsCard: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: colors.radiusLg, padding: 16, gap: 8 },
  resultRow: { gap: 2 },
  tableName: { fontFamily: fonts.mono, fontSize: 11, color: colors.text, letterSpacing: 0.5 },
  resultText: { fontFamily: fonts.mono, fontSize: 10 },
  metaText: { fontFamily: fonts.mono, fontSize: 9, color: colors.textDim },
  errorText: { fontFamily: fonts.mono, fontSize: 9, color: colors.coral },
});
