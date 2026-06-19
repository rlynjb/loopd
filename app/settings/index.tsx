// Settings root — tabbed page combining what used to be at /settings/ai and
// /settings/cloud-sync. The user lands here directly from the global nav;
// no more menu indirection.
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert, Modal } from 'react-native';
import { useRouter } from 'expo-router';
import { useState, useEffect, useCallback } from 'react';
import { colors, fonts } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';
import {
  getAnthropicKey, setAnthropicKey, clearAnthropicKey,
  getOpenAIKey, setOpenAIKey, clearOpenAIKey,
  getStrictLocalMode, setStrictLocalMode,
  getProvider, setProvider,
  getChainRoute, setChainRoute,
  type AIProvider, type ChainName, type RouteChoice,
} from '../../src/services/ai/config';
import { testConnection } from '../../src/services/ai/summarize';
import { getDeviceInfo, type DeviceClass } from '../../src/services/ai/deviceClass';
import {
  downloadGemmaModel, deleteGemmaModel, getModelDiskSize,
  MODEL_FILENAME,
  type DownloadProgress,
} from '../../src/services/ai/download';
import { resetGemmaLocalSkip } from '../../src/services/ai/providers/gemma';
import { isCloudConfigured } from '../../src/services/sync/client';
import { pushAll, pullAll } from '../../src/services/sync/orchestrator';
import { getAllSyncMeta, type SyncMetaRow } from '../../src/services/sync/syncMeta';
import type { PushResult } from '../../src/services/sync/types';
import type { PullResult } from '../../src/services/sync/pull';
import { forcePushAll, resetCloud, resetLocalFromCloud } from '../../src/services/sync/devActions';

// ============================================================================
// Types + constants
// ============================================================================

type DeviceInfo = {
  deviceClass: DeviceClass;
  totalMemoryGB: number;
  modelName: string | null;
  brand: string | null;
  overrideActive: boolean;
};

type TabKey = 'routing' | 'on-device' | 'anthropic' | 'openai' | 'cloud-sync';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'routing', label: 'Routing' },
  { key: 'on-device', label: 'On-Device' },
  { key: 'anthropic', label: 'Anthropic' },
  { key: 'openai', label: 'OpenAI' },
  { key: 'cloud-sync', label: 'Cloud Sync' },
];

const CHAINS: { key: ChainName; title: string; description: string }[] = [
  { key: 'summarize', title: 'Summarize', description: 'Generates the structured AI summary for each day — clip order, mood, themes.' },
  { key: 'caption', title: 'Caption', description: '4-variant tonal caption for the vlog editor (clean / smoother / reflective / punchy).' },
  { key: 'interpret', title: 'Interpret', description: 'Long-form journal interpretation modal — emotional read of an entry.' },
  { key: 'classify', title: 'Classify', description: 'Labels todos as todo / idea / knowledge / study / reflect.' },
];

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// ============================================================================
// Root
// ============================================================================

export default function SettingsScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('routing');

  // Cloud config
  const [provider, setProviderState] = useState<AIProvider>('claude');
  const [claudeKey, setClaudeKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<'none' | 'ok' | 'error'>('none');

  // Routing
  const [strictLocal, setStrictLocalState] = useState(false);
  const [routes, setRoutes] = useState<Record<ChainName, RouteChoice>>({
    summarize: 'cloud', caption: 'cloud', interpret: 'cloud', classify: 'on-device',
  });

  // Gemma on-device
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [modelDiskBytes, setModelDiskBytes] = useState(0);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);

  useEffect(() => {
    (async () => {
      const [p, ck, ok, sl, info, sz, rSummarize, rCaption, rInterpret, rClassify] = await Promise.all([
        getProvider(),
        getAnthropicKey(),
        getOpenAIKey(),
        getStrictLocalMode(),
        getDeviceInfo(),
        getModelDiskSize(),
        getChainRoute('summarize'),
        getChainRoute('caption'),
        getChainRoute('interpret'),
        getChainRoute('classify'),
      ]);
      setProviderState(p);
      if (ck) setClaudeKey(ck);
      if (ok) setOpenaiKey(ok);
      setStrictLocalState(sl);
      setDeviceInfo(info);
      setModelDiskBytes(sz);
      setRoutes({ summarize: rSummarize, caption: rCaption, interpret: rInterpret, classify: rClassify });
      if ((p === 'claude' && ck) || (p === 'openai' && ok)) setStatus('ok');
    })();
  }, []);

  const handleProviderChange = async (p: AIProvider) => {
    setProviderState(p);
    await setProvider(p);
    const key = p === 'openai' ? openaiKey : claudeKey;
    setStatus(key ? 'ok' : 'none');
  };

  const handleStrictLocalToggle = async (on: boolean) => {
    setStrictLocalState(on);
    await setStrictLocalMode(on);
  };

  const handleRouteChange = async (chain: ChainName, route: RouteChoice) => {
    setRoutes(prev => ({ ...prev, [chain]: route }));
    await setChainRoute(chain, route);
  };

  const handleSaveKey = async (which: 'claude' | 'openai') => {
    if (which === 'claude') {
      if (!claudeKey.trim()) return;
      await setAnthropicKey(claudeKey.trim());
    } else {
      if (!openaiKey.trim()) return;
      await setOpenAIKey(openaiKey.trim());
    }
    if (provider === which) setStatus('ok');
  };

  const handleClearKey = async (which: 'claude' | 'openai') => {
    if (which === 'claude') {
      await clearAnthropicKey();
      setClaudeKey('');
    } else {
      await clearOpenAIKey();
      setOpenaiKey('');
    }
    if (provider === which) setStatus('none');
  };

  const handleTest = async () => {
    setTesting(true);
    const result = await testConnection();
    setTesting(false);
    if (result.ok) {
      setStatus('ok');
      Alert.alert('Connected', 'API key is valid.');
    } else {
      setStatus('error');
      Alert.alert('Connection Failed', result.error ?? 'Unknown error');
    }
  };

  const handleDownloadModel = async () => {
    if (!deviceInfo) return;
    if (deviceInfo.deviceClass === 'disabled') {
      Alert.alert('Unsupported device', 'On-device AI requires at least 2 GB of RAM. Use cloud only.');
      return;
    }
    const variant = deviceInfo.deviceClass === 'full' ? 'gemma-3-4b' : 'gemma-3-1b';
    setDownloadProgress({ totalBytesWritten: 0, totalBytesExpectedToWrite: 0, fraction: 0 });
    const result = await downloadGemmaModel(variant, p => setDownloadProgress(p));
    setDownloadProgress(null);
    if (result.success) {
      const sz = await getModelDiskSize();
      setModelDiskBytes(sz);
      Alert.alert('Download complete', 'Gemma is ready to run on-device.');
    } else {
      Alert.alert('Download failed', result.error ?? 'Unknown error');
    }
  };

  const handleDeleteModel = async () => {
    Alert.alert(
      'Remove model?',
      'This frees disk space but disables on-device Gemma until you re-download.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await deleteGemmaModel();
            setModelDiskBytes(0);
          },
        },
      ],
    );
  };

  const handleResetSkip = async () => {
    await resetGemmaLocalSkip();
    Alert.alert('Reset', 'Per-chain auto-skip flags cleared. Slow chains will be re-probed.');
  };

  const modelDownloaded = modelDiskBytes > 0;
  const modelSizeGB = modelDiskBytes / GB;
  const onDeviceUnavailable =
    !deviceInfo ||
    deviceInfo.deviceClass === 'disabled' ||
    !modelDownloaded;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 8 }}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 38 }} />
      </View>

      {/* Tab bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabsRow}
        contentContainerStyle={styles.tabsContent}
      >
        {TABS.map(t => (
          <Pressable
            key={t.key}
            onPress={() => setTab(t.key)}
            style={[styles.tabBtn, tab === t.key && styles.tabBtnActive]}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {tab === 'routing' && (
          <RoutingTab
            provider={provider}
            onProviderChange={handleProviderChange}
            strictLocal={strictLocal}
            onStrictLocalChange={handleStrictLocalToggle}
            routes={routes}
            onRouteChange={handleRouteChange}
            onDeviceUnavailable={onDeviceUnavailable}
          />
        )}
        {tab === 'on-device' && (
          <OnDeviceTab
            deviceInfo={deviceInfo}
            modelDownloaded={modelDownloaded}
            modelSizeGB={modelSizeGB}
            downloadProgress={downloadProgress}
            onDownload={handleDownloadModel}
            onDelete={handleDeleteModel}
            onResetSkip={handleResetSkip}
          />
        )}
        {tab === 'anthropic' && (
          <ProviderTab
            providerName="Anthropic"
            placeholder="sk-ant-..."
            description="The primary cloud provider when set as cloud-primary in the Routing tab. Used for summarize, caption, interpret, and classify when routed to cloud."
            value={claudeKey}
            onChangeText={setClaudeKey}
            onSave={() => handleSaveKey('claude')}
            onClear={() => handleClearKey('claude')}
            onTest={handleTest}
            testing={testing && provider === 'claude'}
            status={provider === 'claude' ? status : 'none'}
            isPrimary={provider === 'claude'}
            onMakePrimary={() => handleProviderChange('claude')}
          />
        )}
        {tab === 'openai' && (
          <ProviderTab
            providerName="OpenAI"
            placeholder="sk-..."
            description="Fallback when Anthropic is unavailable (5xx, 429, network). Becomes primary when set as cloud-primary in the Routing tab."
            value={openaiKey}
            onChangeText={setOpenaiKey}
            onSave={() => handleSaveKey('openai')}
            onClear={() => handleClearKey('openai')}
            onTest={handleTest}
            testing={testing && provider === 'openai'}
            status={provider === 'openai' ? status : 'none'}
            isPrimary={provider === 'openai'}
            onMakePrimary={() => handleProviderChange('openai')}
          />
        )}
        {tab === 'cloud-sync' && <CloudSyncTab />}
      </ScrollView>
    </View>
  );
}

// ============================================================================
// Routing tab
// ============================================================================

function RoutingTab(props: {
  provider: AIProvider;
  onProviderChange: (p: AIProvider) => void;
  strictLocal: boolean;
  onStrictLocalChange: (on: boolean) => void;
  routes: Record<ChainName, RouteChoice>;
  onRouteChange: (chain: ChainName, route: RouteChoice) => void;
  onDeviceUnavailable: boolean;
}) {
  return (
    <View style={{ gap: 14 }}>
      <Text style={styles.subtitle}>
        Pick on-device or cloud per chain. Cloud follows the primary picker below — Anthropic falls back to OpenAI (or vice versa) on transient failure.
      </Text>

      <Text style={styles.label}>CLOUD PRIMARY</Text>
      <Chip
        options={[
          { value: 'claude', label: 'Anthropic' },
          { value: 'openai', label: 'OpenAI' },
        ]}
        value={props.provider}
        onChange={(v) => props.onProviderChange(v as AIProvider)}
      />

      <View style={styles.divider} />

      {CHAINS.map(chain => (
        <View key={chain.key} style={{ gap: 6 }}>
          <Text style={styles.rowTitle}>{chain.title}</Text>
          <Chip
            options={[
              { value: 'on-device', label: 'On-device', disabled: props.onDeviceUnavailable },
              { value: 'cloud', label: 'Cloud' },
            ]}
            value={props.routes[chain.key]}
            onChange={(v) => props.onRouteChange(chain.key, v as RouteChoice)}
          />
          <Text style={styles.rowDescription}>{chain.description}</Text>
        </View>
      ))}

      <View style={styles.divider} />

      <Text style={styles.label}>STRICT LOCAL MODE</Text>
      <Chip
        options={[
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ]}
        value={props.strictLocal ? 'on' : 'off'}
        onChange={(v) => props.onStrictLocalChange(v === 'on')}
      />
      <Text style={styles.rowDescription}>
        {props.strictLocal
          ? 'On-device only. Cloud paths are off; chains that can\'t run on-device are disabled.'
          : 'Cloud fallback enabled when on-device AI can\'t serve.'}
      </Text>
    </View>
  );
}

// ============================================================================
// On-Device tab
// ============================================================================

function OnDeviceTab(props: {
  deviceInfo: DeviceInfo | null;
  modelDownloaded: boolean;
  modelSizeGB: number;
  downloadProgress: DownloadProgress | null;
  onDownload: () => void;
  onDelete: () => void;
  onResetSkip: () => void;
}) {
  if (!props.deviceInfo) {
    return <Text style={styles.hint}>Detecting device…</Text>;
  }
  const { deviceInfo, modelDownloaded, modelSizeGB, downloadProgress } = props;
  return (
    <View style={{ gap: 14 }}>
      <Text style={styles.subtitle}>
        Runs Gemma 3 (4B or 1B based on device RAM) locally via llama.cpp. Free, offline, private.
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardLine}>
          Device class: <Text style={styles.cardValue}>{deviceInfo.deviceClass}</Text>
        </Text>
        <Text style={styles.cardLine}>
          RAM: <Text style={styles.cardValue}>{deviceInfo.totalMemoryGB.toFixed(1)} GB</Text>
        </Text>
        {deviceInfo.brand && (
          <Text style={styles.cardLine}>
            Device: <Text style={styles.cardValue}>{deviceInfo.brand} {deviceInfo.modelName ?? ''}</Text>
          </Text>
        )}

        {deviceInfo.deviceClass === 'disabled' ? (
          <Text style={[styles.hint, { marginTop: 8 }]}>
            On-device AI requires {'>='} 2 GB RAM. This device should use cloud only.
          </Text>
        ) : modelDownloaded ? (
          <>
            <Text style={[styles.cardLine, { marginTop: 8 }]}>
              Model: <Text style={styles.cardValue}>{MODEL_FILENAME}</Text>
            </Text>
            <Text style={styles.cardLine}>
              Size on disk: <Text style={styles.cardValue}>{modelSizeGB.toFixed(2)} GB</Text>
            </Text>
            <Pressable onPress={props.onDelete} style={styles.removeBtn}>
              <Text style={styles.removeBtnText}>Remove model</Text>
            </Pressable>
          </>
        ) : downloadProgress !== null ? (
          <>
            <Text style={[styles.cardLine, { marginTop: 8 }]}>
              Downloading… <Text style={styles.cardValue}>{(downloadProgress.fraction * 100).toFixed(0)}%</Text>
            </Text>
            <Text style={styles.cardLine}>
              <Text style={styles.cardValue}>{(downloadProgress.totalBytesWritten / MB).toFixed(0)} MB</Text>
              {downloadProgress.totalBytesExpectedToWrite > 0 && (
                <>
                  {' / '}
                  <Text style={styles.cardValue}>{(downloadProgress.totalBytesExpectedToWrite / MB).toFixed(0)} MB</Text>
                </>
              )}
            </Text>
          </>
        ) : (
          <Pressable onPress={props.onDownload} style={[styles.btn, styles.downloadBtn, { marginTop: 8 }]}>
            <Text style={styles.downloadBtnText}>
              Download {deviceInfo.deviceClass === 'full' ? 'Gemma 3 4B (~2.5 GB)' : 'Gemma 3 1B (~700 MB)'}
            </Text>
          </Pressable>
        )}
      </View>

      {deviceInfo.deviceClass !== 'disabled' && modelDownloaded && (
        <>
          <View style={styles.divider} />
          <Text style={styles.label}>AUTO-SKIP</Text>
          <Text style={styles.rowDescription}>
            Chains that exceed their per-chain latency budget on 3 consecutive runs auto-skip the on-device path. Reset clears the flags so slow chains are re-probed.
          </Text>
          <Pressable onPress={props.onResetSkip} style={[styles.btn, styles.outlineBtn]}>
            <Text style={styles.outlineBtnText}>Reset auto-skip</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

// ============================================================================
// Provider tab (Anthropic / OpenAI — shared shape)
// ============================================================================

function ProviderTab(props: {
  providerName: string;
  placeholder: string;
  description: string;
  value: string;
  onChangeText: (v: string) => void;
  onSave: () => void;
  onClear: () => void;
  onTest: () => void;
  testing: boolean;
  status: 'none' | 'ok' | 'error';
  isPrimary: boolean;
  onMakePrimary: () => void;
}) {
  const hasSaved = props.value.length > 0;
  return (
    <View style={{ gap: 14 }}>
      <Text style={styles.subtitle}>{props.description}</Text>

      <Text style={styles.label}>{props.providerName.toUpperCase()} API KEY</Text>
      <KeyField value={props.value} onChangeText={props.onChangeText} placeholder={props.placeholder} />

      <View style={styles.btnRow}>
        <Pressable onPress={props.onSave} style={[styles.btn, styles.saveBtn]}>
          <Text style={styles.saveBtnText}>Save</Text>
        </Pressable>
        <Pressable onPress={props.onTest} style={[styles.btn, styles.testBtn]} disabled={!hasSaved || props.testing}>
          <Text style={[styles.testBtnText, (!hasSaved || props.testing) && { opacity: 0.4 }]}>
            {props.testing ? 'Testing...' : 'Test Connection'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.statusRow}>
        <View style={[styles.statusDot, {
          backgroundColor: props.status === 'ok' ? colors.green : props.status === 'error' ? colors.coral : colors.textDim,
        }]} />
        <Text style={styles.statusText}>
          {props.status === 'ok' ? 'Connected' : props.status === 'error' ? 'Connection failed' : 'Not configured'}
        </Text>
      </View>

      {hasSaved && (
        <Pressable onPress={props.onClear} style={styles.disconnectBtn}>
          <Text style={styles.disconnectText}>Clear key</Text>
        </Pressable>
      )}

      <View style={styles.divider} />

      <Text style={styles.label}>CLOUD-PRIMARY ROLE</Text>
      {props.isPrimary ? (
        <Text style={styles.hint}>
          {props.providerName} is the cloud-primary. Falls back to the other provider on transient failure.
        </Text>
      ) : (
        <Pressable onPress={props.onMakePrimary} style={[styles.btn, styles.outlineBtn]}>
          <Text style={styles.outlineBtnText}>Make {props.providerName} the cloud-primary</Text>
        </Pressable>
      )}
    </View>
  );
}

// ============================================================================
// Cloud Sync tab — moved inline from the deleted /settings/cloud-sync route
// ============================================================================

function CloudSyncTab() {
  const [configured] = useState(isCloudConfigured());
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pushResults, setPushResults] = useState<PushResult[] | null>(null);
  const [pullResults, setPullResults] = useState<PullResult[] | null>(null);
  const [meta, setMeta] = useState<SyncMetaRow[]>([]);
  const [devMenuOpen, setDevMenuOpen] = useState(false);
  const [devBusy, setDevBusy] = useState(false);

  const refreshMeta = useCallback(async () => {
    try { setMeta(await getAllSyncMeta()); } catch (err) {
      console.warn('[loopd] sync meta load failed:', err);
    }
  }, []);

  useEffect(() => { refreshMeta(); }, [refreshMeta]);

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
    <View style={{ gap: 14 }}>
      <Pressable onLongPress={() => setDevMenuOpen(true)} delayLongPress={800}>
        <Text style={styles.subtitle}>
          Supabase backup (Phase A — personal). Long-press here for dev actions.
        </Text>
      </Pressable>

      <View style={styles.syncStatusCard}>
        <View style={styles.syncStatusRow}>
          <Text style={styles.syncStatusLabel}>STATUS</Text>
          <Text style={[styles.syncStatusValue, { color: configured ? colors.green : colors.amber }]}>
            {configured ? 'CONFIGURED' : 'NOT CONFIGURED'}
          </Text>
        </View>
        {configured && (
          <>
            <View style={styles.syncStatusRow}>
              <Text style={styles.syncStatusLabel}>LAST PUSH</Text>
              <Text style={styles.syncStatusInfo}>{formatRelative(lastPushAt)}</Text>
            </View>
            <View style={styles.syncStatusRow}>
              <Text style={styles.syncStatusLabel}>LAST PULL</Text>
              <Text style={styles.syncStatusInfo}>{formatRelative(lastPullAt)}</Text>
            </View>
            {errorCount > 0 && (
              <View style={styles.syncStatusRow}>
                <Text style={styles.syncStatusLabel}>ERRORS</Text>
                <Text style={[styles.syncStatusInfo, { color: colors.coral }]}>{errorCount} table{errorCount === 1 ? '' : 's'}</Text>
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
        <View style={styles.syncResultsCard}>
          <Text style={styles.syncStatusLabel}>LAST PUSH</Text>
          {pushResults.length === 0
            ? <Text style={styles.hint}>No tables registered.</Text>
            : pushResults.map(r => (
              <View key={r.tableName} style={styles.syncResultRow}>
                <Text style={styles.syncTableName}>{r.tableName}</Text>
                <Text style={[
                  styles.syncResultText,
                  { color: r.failed > 0 ? colors.coral : r.succeeded > 0 ? colors.green : colors.textDim },
                ]}>
                  {r.attempted === 0 ? 'nothing to push' : `${r.succeeded}/${r.attempted} ok${r.failed > 0 ? `, ${r.failed} failed` : ''}`}
                </Text>
                {r.error && <Text style={styles.syncErrorText}>{r.error}</Text>}
              </View>
            ))}
        </View>
      )}

      {pullResults && (
        <View style={styles.syncResultsCard}>
          <Text style={styles.syncStatusLabel}>LAST PULL</Text>
          {pullResults.map(r => (
            <View key={r.tableName} style={styles.syncResultRow}>
              <Text style={styles.syncTableName}>{r.tableName}</Text>
              <Text style={[
                styles.syncResultText,
                { color: r.error ? colors.coral : r.applied > 0 ? colors.green : colors.textDim },
              ]}>
                {r.fetched === 0 ? 'nothing new' : `${r.applied} applied · ${r.skipped} skipped (of ${r.fetched})`}
              </Text>
              {r.error && <Text style={styles.syncErrorText}>{r.error}</Text>}
            </View>
          ))}
        </View>
      )}

      {meta.length > 0 && (
        <View style={styles.syncResultsCard}>
          <Text style={styles.syncStatusLabel}>SYNC LEDGER</Text>
          {meta.map(m => (
            <View key={m.tableName} style={styles.syncResultRow}>
              <Text style={styles.syncTableName}>{m.tableName}</Text>
              <Text style={styles.syncMetaText}>
                push: {m.lastPushAt ? new Date(m.lastPushAt).toLocaleTimeString() : '—'}
                {' · pull: '}{m.lastPullAt ? new Date(m.lastPullAt).toLocaleTimeString() : '—'}
              </Text>
              {m.lastError && <Text style={styles.syncErrorText}>err: {m.lastError.slice(0, 80)}</Text>}
            </View>
          ))}
        </View>
      )}

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
                'Delete every cloud row for this user. Local DB is untouched. Cannot be undone.',
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
                'WIPE local SQLite then re-pull everything from cloud. Video clip files are NOT in cloud — those will be lost. Cannot be undone.',
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

// ============================================================================
// Shared primitives
// ============================================================================

type ChipOption = { value: string; label: string; disabled?: boolean };

function Chip(props: {
  options: ChipOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={styles.providerRow}>
      {props.options.map(opt => {
        const active = props.value === opt.value;
        const disabled = !!opt.disabled;
        return (
          <Pressable
            key={opt.value}
            onPress={() => !disabled && props.onChange(opt.value)}
            style={[
              styles.providerBtn,
              active && styles.providerBtnActive,
              disabled && { opacity: 0.4 },
            ]}
          >
            <Text style={[styles.providerText, active && styles.providerTextActive]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function KeyField(props: { value: string; onChangeText: (v: string) => void; placeholder: string }) {
  const [shown, setShown] = useState(false);
  return (
    <View style={styles.keyFieldRow}>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={colors.textDimmer}
        secureTextEntry={!shown}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { flex: 1 }]}
      />
      <Pressable onPress={() => setShown(s => !s)} style={styles.eyeBtn}>
        <Text style={styles.eyeText}>{shown ? 'Hide' : 'Show'}</Text>
      </Pressable>
    </View>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: { fontFamily: fonts.heading, fontSize: 18, color: colors.text, letterSpacing: -0.3 },

  tabsRow: {
    flexGrow: 0,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  tabsContent: { paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  tabBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 16,
  },
  tabBtnActive: {
    backgroundColor: 'rgba(232,213,176,0.1)',
    borderColor: colors.accent,
  },
  tabText: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
  tabTextActive: { color: colors.accent },

  scroll: { flex: 1 },
  content: { padding: 24, paddingBottom: 60, gap: 14 },

  subtitle: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, lineHeight: 18 },
  label: { fontFamily: fonts.mono, fontSize: 9, color: colors.textDim, letterSpacing: 1, marginTop: 4 },
  hint: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  rowTitle: { fontFamily: fonts.body, fontSize: 14, color: colors.text, fontWeight: '500' },
  rowDescription: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  divider: { height: 1, backgroundColor: colors.cardBorder, marginVertical: 6 },

  providerRow: { flexDirection: 'row', gap: 8 },
  providerBtn: {
    flex: 1,
    paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 8,
    alignItems: 'center',
  },
  providerBtnActive: {
    backgroundColor: 'rgba(232,213,176,0.1)',
    borderColor: colors.accent,
  },
  providerText: { fontFamily: fonts.mono, fontSize: 12, color: colors.textMuted },
  providerTextActive: { color: colors.accent },

  input: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 8,
    padding: 14,
    color: colors.text,
    fontSize: 14,
    fontFamily: fonts.mono,
  },
  keyFieldRow: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  eyeBtn: {
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 8,
  },
  eyeText: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },

  btnRow: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  saveBtn: { backgroundColor: 'rgba(232,213,176,0.1)', borderWidth: 1, borderColor: 'rgba(232,213,176,0.2)' },
  saveBtnText: { fontFamily: fonts.mono, fontSize: 12, color: colors.accent },
  testBtn: { backgroundColor: 'rgba(76,175,125,0.1)', borderWidth: 1, borderColor: 'rgba(76,175,125,0.2)' },
  testBtnText: { fontFamily: fonts.mono, fontSize: 12, color: colors.green },
  outlineBtn: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  outlineBtnText: { fontFamily: fonts.mono, fontSize: 12, color: colors.textMuted },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },

  disconnectBtn: { paddingVertical: 12, alignItems: 'center', backgroundColor: 'rgba(251,113,133,0.08)', borderWidth: 1, borderColor: 'rgba(251,113,133,0.2)', borderRadius: 8 },
  disconnectText: { fontFamily: fonts.mono, fontSize: 12, color: colors.coral },

  card: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 8,
    padding: 14,
    gap: 6,
  },
  cardLine: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
  cardValue: { color: colors.text },

  downloadBtn: { backgroundColor: 'rgba(232,213,176,0.1)', borderWidth: 1, borderColor: 'rgba(232,213,176,0.2)' },
  downloadBtnText: { fontFamily: fonts.mono, fontSize: 12, color: colors.accent },
  removeBtn: {
    marginTop: 6,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: 'rgba(251,113,133,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(251,113,133,0.2)',
    borderRadius: 8,
  },
  removeBtnText: { fontFamily: fonts.mono, fontSize: 11, color: colors.coral },

  // ----- Cloud Sync styles (ported from the deleted cloud-sync.tsx) -----
  syncStatusCard: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: colors.radiusLg,
    padding: 16,
    gap: 8,
  },
  syncStatusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  syncStatusLabel: { fontFamily: fonts.mono, fontSize: 10, color: colors.textDim, letterSpacing: 1 },
  syncStatusValue: { fontFamily: fonts.mono, fontSize: 12, letterSpacing: 1 },
  syncStatusInfo: { fontFamily: fonts.mono, fontSize: 12, color: colors.text },
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
  syncResultsCard: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: colors.radiusLg,
    padding: 16,
    gap: 8,
  },
  syncResultRow: { gap: 2 },
  syncTableName: { fontFamily: fonts.mono, fontSize: 11, color: colors.text, letterSpacing: 0.5 },
  syncResultText: { fontFamily: fonts.mono, fontSize: 10 },
  syncMetaText: { fontFamily: fonts.mono, fontSize: 9, color: colors.textDim },
  syncErrorText: { fontFamily: fonts.mono, fontSize: 9, color: colors.coral },

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
