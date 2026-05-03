// Cloud sync page — push/pull, sync ledger, and a hidden long-press dev menu.
// See docs/loopd-cloud-sync-spec.md §7.
import { View, Text, Pressable, ScrollView, StyleSheet, Modal, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { colors, fonts } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';
import { isCloudConfigured } from '../../src/services/sync/client';
import { pushAll, pullAll } from '../../src/services/sync/orchestrator';
import { getAllSyncMeta, type SyncMetaRow } from '../../src/services/sync/syncMeta';
import type { PushResult } from '../../src/services/sync/types';
import type { PullResult } from '../../src/services/sync/pull';
import { forcePushAll, resetCloud, resetLocalFromCloud } from '../../src/services/sync/devActions';

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function CloudSyncScreen() {
  const router = useRouter();
  const [configured] = useState(isCloudConfigured());
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pushResults, setPushResults] = useState<PushResult[] | null>(null);
  const [pullResults, setPullResults] = useState<PullResult[] | null>(null);
  const [meta, setMeta] = useState<SyncMetaRow[]>([]);
  const [devMenuOpen, setDevMenuOpen] = useState(false);
  const [devBusy, setDevBusy] = useState(false);

  const refreshMeta = async () => {
    try { setMeta(await getAllSyncMeta()); } catch (err) {
      console.warn('[loopd] sync meta load failed:', err);
    }
  };

  useEffect(() => { refreshMeta(); }, []);

  const handlePush = async () => {
    setPushing(true);
    setPushResults(await pushAll());
    await refreshMeta();
    setPushing(false);
  };

  const handlePull = async () => {
    setPulling(true);
    setPullResults(await pullAll());
    await refreshMeta();
    setPulling(false);
  };

  // Aggregate per-table state into a single header line.
  const lastPushAt = meta.reduce<string | null>((latest, m) => {
    if (!m.lastPushAt) return latest;
    if (!latest || m.lastPushAt > latest) return m.lastPushAt;
    return latest;
  }, null);
  const lastPullAt = meta.reduce<string | null>((latest, m) => {
    if (!m.lastPullAt) return latest;
    if (!latest || m.lastPullAt > latest) return m.lastPullAt;
    return latest;
  }, null);
  const errorCount = meta.filter(m => m.lastError).length;

  const runDevAction = async (label: string, fn: () => Promise<unknown>) => {
    setDevBusy(true);
    try {
      const result = await fn();
      console.log(`[loopd sync] dev ${label}:`, result);
      Alert.alert(label, JSON.stringify(result, null, 2).slice(0, 600));
      await refreshMeta();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert(`${label} failed`, msg);
    } finally {
      setDevBusy(false);
      setDevMenuOpen(false);
    }
  };

  const confirmAndRun = (label: string, body: string, fn: () => Promise<unknown>) => {
    Alert.alert(label, body, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Run', style: 'destructive', onPress: () => runDevAction(label, fn) },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 8 }}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {/* Long-press the title to open the dev menu — hidden from public UX */}
        <Pressable onLongPress={() => setDevMenuOpen(true)} delayLongPress={800}>
          <Text style={styles.title}>Cloud Sync</Text>
        </Pressable>

        <View style={styles.statusCard}>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>STATUS</Text>
            <Text style={[styles.statusValue, { color: configured ? colors.green : colors.amber }]}>
              {configured ? 'CONFIGURED' : 'NOT CONFIGURED'}
            </Text>
          </View>
          {configured && (
            <>
              <View style={styles.statusRow}>
                <Text style={styles.statusLabel}>LAST PUSH</Text>
                <Text style={styles.statusInfo}>{formatRelative(lastPushAt)}</Text>
              </View>
              <View style={styles.statusRow}>
                <Text style={styles.statusLabel}>LAST PULL</Text>
                <Text style={styles.statusInfo}>{formatRelative(lastPullAt)}</Text>
              </View>
              {errorCount > 0 && (
                <View style={styles.statusRow}>
                  <Text style={styles.statusLabel}>ERRORS</Text>
                  <Text style={[styles.statusInfo, { color: colors.coral }]}>{errorCount} table{errorCount === 1 ? '' : 's'}</Text>
                </View>
              )}
            </>
          )}
          {!configured && (
            <Text style={styles.hint}>
              Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in .env, then rebuild.
            </Text>
          )}
        </View>

        <View style={styles.btnRow}>
          <Pressable
            onPress={handlePush}
            disabled={!configured || pushing || pulling}
            style={[styles.pushBtn, (!configured || pushing || pulling) && { opacity: 0.4 }]}
          >
            <Icon name="upload" size={16} color={colors.amber} />
            <Text style={styles.pushBtnText}>{pushing ? 'PUSHING…' : 'PUSH'}</Text>
          </Pressable>
          <Pressable
            onPress={handlePull}
            disabled={!configured || pushing || pulling}
            style={[styles.pullBtn, (!configured || pushing || pulling) && { opacity: 0.4 }]}
          >
            <Icon name="download" size={16} color={colors.accent2} />
            <Text style={styles.pullBtnText}>{pulling ? 'PULLING…' : 'PULL'}</Text>
          </Pressable>
        </View>

        {pushResults && (
          <View style={styles.resultsCard}>
            <Text style={styles.statusLabel}>LAST PUSH</Text>
            {pushResults.length === 0
              ? <Text style={styles.hint}>No tables registered.</Text>
              : pushResults.map(r => (
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

        {pullResults && (
          <View style={styles.resultsCard}>
            <Text style={styles.statusLabel}>LAST PULL</Text>
            {pullResults.map(r => (
              <View key={r.tableName} style={styles.resultRow}>
                <Text style={styles.tableName}>{r.tableName}</Text>
                <Text style={[
                  styles.resultText,
                  { color: r.error ? colors.coral : r.applied > 0 ? colors.green : colors.textDim },
                ]}>
                  {r.fetched === 0 ? 'nothing new' : `${r.applied} applied · ${r.skipped} skipped (of ${r.fetched})`}
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
                  {' · pull: '}{m.lastPullAt ? new Date(m.lastPullAt).toLocaleTimeString() : '—'}
                </Text>
                {m.lastError && <Text style={styles.errorText}>err: {m.lastError.slice(0, 80)}</Text>}
              </View>
            ))}
          </View>
        )}

        <Text style={styles.devHint}>long-press title for dev actions</Text>
      </ScrollView>

      <Modal visible={devMenuOpen} transparent animationType="fade" onRequestClose={() => setDevMenuOpen(false)}>
        <Pressable style={styles.modalScrim} onPress={() => !devBusy && setDevMenuOpen(false)}>
          <Pressable style={styles.modalCard} onPress={() => {/* swallow */}}>
            <Text style={styles.modalTitle}>Dev Menu</Text>

            <Pressable
              style={[styles.devBtn, devBusy && { opacity: 0.4 }]}
              disabled={devBusy}
              onPress={() => runDevAction('Force push all', forcePushAll)}
            >
              <Icon name="upload" size={14} color={colors.amber} />
              <View style={styles.devBtnInner}>
                <Text style={styles.devBtnText}>FORCE PUSH ALL</Text>
                <Text style={styles.devBtnSub}>Re-upload every row, ignoring synced_at</Text>
              </View>
            </Pressable>

            <Pressable
              style={[styles.devBtn, devBusy && { opacity: 0.4 }]}
              disabled={devBusy}
              onPress={() => confirmAndRun(
                'Reset cloud database',
                'Delete every cloud row for this user. Local DB is untouched. Use this when iterating on schema. Cannot be undone.',
                resetCloud,
              )}
            >
              <Icon name="trash" size={14} color={colors.coral} />
              <View style={styles.devBtnInner}>
                <Text style={styles.devBtnText}>RESET CLOUD DB</Text>
                <Text style={styles.devBtnSub}>Drop every cloud row for this user</Text>
              </View>
            </Pressable>

            <Pressable
              style={[styles.devBtn, devBusy && { opacity: 0.4 }]}
              disabled={devBusy}
              onPress={() => confirmAndRun(
                'Reset local from cloud',
                'WIPE local SQLite then re-pull everything from cloud. Use only when local DB is corrupted. Video clip files are NOT in cloud — those will be lost. Cannot be undone.',
                resetLocalFromCloud,
              )}
            >
              <Icon name="download" size={14} color={colors.coral} />
              <View style={styles.devBtnInner}>
                <Text style={styles.devBtnText}>RESET LOCAL FROM CLOUD</Text>
                <Text style={styles.devBtnSub}>Wipe local + first-pull from cloud</Text>
              </View>
            </Pressable>

            <Pressable style={styles.devClose} onPress={() => !devBusy && setDevMenuOpen(false)} disabled={devBusy}>
              <Text style={styles.devCloseText}>{devBusy ? 'WORKING…' : 'CLOSE'}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  scroll: { flex: 1 },
  content: { padding: 24, paddingBottom: 60, gap: 16 },
  title: { fontFamily: fonts.heading, fontSize: 28, color: colors.text, letterSpacing: -0.5, marginBottom: 4 },
  statusCard: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: colors.radiusLg, padding: 16, gap: 8 },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statusLabel: { fontFamily: fonts.mono, fontSize: 10, color: colors.textDim, letterSpacing: 1 },
  statusValue: { fontFamily: fonts.mono, fontSize: 12, letterSpacing: 1 },
  statusInfo: { fontFamily: fonts.mono, fontSize: 12, color: colors.text },
  hint: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, lineHeight: 18 },
  btnRow: { flexDirection: 'row', gap: 8 },
  pushBtn: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 14, borderRadius: colors.radiusLg,
    borderWidth: 1, borderColor: 'rgba(251,191,36,0.3)', backgroundColor: 'rgba(251,191,36,0.08)',
  },
  pushBtnText: { fontFamily: fonts.mono, fontSize: 12, color: colors.amber, letterSpacing: 1 },
  pullBtn: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 14, borderRadius: colors.radiusLg,
    borderWidth: 1, borderColor: `${colors.accent2}40`, backgroundColor: `${colors.accent2}14`,
  },
  pullBtnText: { fontFamily: fonts.mono, fontSize: 12, color: colors.accent2, letterSpacing: 1 },
  resultsCard: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: colors.radiusLg, padding: 16, gap: 8 },
  resultRow: { gap: 2 },
  tableName: { fontFamily: fonts.mono, fontSize: 11, color: colors.text, letterSpacing: 0.5 },
  resultText: { fontFamily: fonts.mono, fontSize: 10 },
  metaText: { fontFamily: fonts.mono, fontSize: 9, color: colors.textDim },
  errorText: { fontFamily: fonts.mono, fontSize: 9, color: colors.coral },
  devHint: { fontFamily: fonts.mono, fontSize: 9, color: colors.textDim, textAlign: 'center', marginTop: 12, opacity: 0.5 },

  modalScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: colors.radiusLg, padding: 20, width: '100%', maxWidth: 400, gap: 12 },
  modalTitle: { fontFamily: fonts.heading, fontSize: 22, color: colors.text, marginBottom: 4 },
  devBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14, paddingHorizontal: 14,
    borderRadius: colors.radiusLg, borderWidth: 1, borderColor: colors.cardBorder,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  devBtnInner: { flex: 1, gap: 2 },
  devBtnText: { fontFamily: fonts.mono, fontSize: 11, color: colors.text, letterSpacing: 1 },
  devBtnSub: { fontFamily: fonts.body, fontSize: 11, color: colors.textMuted },
  devClose: { paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  devCloseText: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, letterSpacing: 1 },
});
