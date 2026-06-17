import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useState, useEffect } from 'react';
import { colors, fonts } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';
import {
  getAnthropicKey, setAnthropicKey, clearAnthropicKey,
  getOpenAIKey, setOpenAIKey, clearOpenAIKey,
  getStrictLocalMode, setStrictLocalMode,
  getProvider, setProvider, type AIProvider,
} from '../../src/services/ai/config';
import { testConnection } from '../../src/services/ai/summarize';
import { getDeviceInfo, type DeviceClass } from '../../src/services/ai/deviceClass';
import {
  downloadGemmaModel, deleteGemmaModel, getModelDiskSize,
  MODEL_FILENAME,
  type DownloadProgress,
} from '../../src/services/ai/download';

type DeviceInfo = {
  deviceClass: DeviceClass;
  totalMemoryGB: number;
  modelName: string | null;
  brand: string | null;
  overrideActive: boolean;
};

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

// NOTE: This page is the interim cloud-only patch for the dryrun-parity
// refactor. The Tabbed redesign (Routing / On-Device / Anthropic / OpenAI
// / Cloud Sync) lands in a follow-up commit per
// `.aipe/plans/settings-dryrun-parity.md`. For now: only the Anthropic /
// OpenAI provider toggle, single API key field, strict-local toggle, and
// Gemma on-device card.

export default function AISettingsScreen() {
  const router = useRouter();
  const [provider, setProviderState] = useState<AIProvider>('claude');
  const [claudeKey, setClaudeKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [strictLocal, setStrictLocalState] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<'none' | 'ok' | 'error'>('none');

  // Gemma on-device state.
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);
  const [modelDiskBytes, setModelDiskBytes] = useState(0);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);

  useEffect(() => {
    (async () => {
      const p = await getProvider();
      setProviderState(p);
      const ck = await getAnthropicKey();
      if (ck) setClaudeKey(ck);
      const ok = await getOpenAIKey();
      if (ok) setOpenaiKey(ok);
      const sl = await getStrictLocalMode();
      setStrictLocalState(sl);
      if ((p === 'claude' && ck) || (p === 'openai' && ok)) setStatus('ok');

      const info = await getDeviceInfo();
      setDeviceInfo(info);
      const sz = await getModelDiskSize();
      setModelDiskBytes(sz);
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

  const handleSave = async () => {
    if (provider === 'claude') {
      if (!claudeKey.trim()) return;
      await setAnthropicKey(claudeKey.trim());
    } else {
      if (!openaiKey.trim()) return;
      await setOpenAIKey(openaiKey.trim());
    }
    setStatus('ok');
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

  const handleDisconnect = async () => {
    if (provider === 'claude') {
      await clearAnthropicKey();
      setClaudeKey('');
    } else {
      await clearOpenAIKey();
      setOpenaiKey('');
    }
    setStatus('none');
  };

  const handleDownloadModel = async () => {
    if (!deviceInfo) return;
    if (deviceInfo.deviceClass === 'disabled') {
      Alert.alert('Unsupported device', 'On-device AI requires at least 2 GB of RAM. Use cloud (Anthropic / OpenAI) instead.');
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

  const currentKey = provider === 'claude' ? claudeKey : openaiKey;
  const setCurrentKey = provider === 'claude' ? setClaudeKey : setOpenaiKey;
  const placeholder = provider === 'claude' ? 'sk-ant-...' : 'sk-...';
  const keyLabel = provider === 'claude' ? 'ANTHROPIC' : 'OPENAI';
  const hasSavedKey = currentKey.length > 0;
  const modelDownloaded = modelDiskBytes > 0;
  const modelSizeGB = modelDiskBytes / GB;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 8 }}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.title}>AI Settings</Text>
        <Text style={styles.subtitle}>Cloud uses Anthropic primary with OpenAI fallback. On-device runs Gemma 3 (4B / 1B) locally via llama.cpp.</Text>

        {/* Cloud primary picker — which cloud provider to call first. */}
        <Text style={styles.label}>CLOUD PRIMARY</Text>
        <View style={styles.providerRow}>
          <Pressable
            onPress={() => handleProviderChange('claude')}
            style={[styles.providerBtn, provider === 'claude' && styles.providerBtnActive]}
          >
            <Text style={[styles.providerText, provider === 'claude' && styles.providerTextActive]}>Anthropic</Text>
          </Pressable>
          <Pressable
            onPress={() => handleProviderChange('openai')}
            style={[styles.providerBtn, provider === 'openai' && styles.providerBtnActive]}
          >
            <Text style={[styles.providerText, provider === 'openai' && styles.providerTextActive]}>OpenAI</Text>
          </Pressable>
        </View>

        {/* API key */}
        <Text style={styles.label}>{keyLabel} API KEY</Text>
        <TextInput
          value={currentKey}
          onChangeText={setCurrentKey}
          placeholder={placeholder}
          placeholderTextColor={colors.textDimmer}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />

        {/* Strict local mode */}
        <Text style={styles.label}>STRICT LOCAL MODE</Text>
        <View style={styles.providerRow}>
          <Pressable
            onPress={() => handleStrictLocalToggle(false)}
            style={[styles.providerBtn, !strictLocal && styles.providerBtnActive]}
          >
            <Text style={[styles.providerText, !strictLocal && styles.providerTextActive]}>Off</Text>
          </Pressable>
          <Pressable
            onPress={() => handleStrictLocalToggle(true)}
            style={[styles.providerBtn, strictLocal && styles.providerBtnActive]}
          >
            <Text style={[styles.providerText, strictLocal && styles.providerTextActive]}>On</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          {strictLocal
            ? 'AI features that the device can\'t serve are disabled. Nothing leaves your device.'
            : 'Cloud fallback enabled when on-device AI can\'t serve.'}
        </Text>

        <View style={styles.btnRow}>
          <Pressable onPress={handleSave} style={[styles.btn, styles.saveBtn]}>
            <Text style={styles.saveBtnText}>Save</Text>
          </Pressable>
          <Pressable onPress={handleTest} style={[styles.btn, styles.testBtn]} disabled={!hasSavedKey || testing}>
            <Text style={[styles.testBtnText, (!hasSavedKey || testing) && { opacity: 0.4 }]}>
              {testing ? 'Testing...' : 'Test Connection'}
            </Text>
          </Pressable>
        </View>

        {/* Status */}
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, {
            backgroundColor: status === 'ok' ? colors.green : status === 'error' ? colors.coral : colors.textDim,
          }]} />
          <Text style={styles.statusText}>
            {status === 'ok' ? 'Connected' : status === 'error' ? 'Connection failed' : 'Not configured'}
          </Text>
        </View>

        {hasSavedKey && (
          <Pressable onPress={handleDisconnect} style={styles.disconnectBtn}>
            <Text style={styles.disconnectText}>Disconnect</Text>
          </Pressable>
        )}

        {/* Gemma on-device */}
        <Text style={[styles.label, { marginTop: 18 }]}>GEMMA ON-DEVICE</Text>
        {deviceInfo ? (
          <View style={styles.gemmaCard}>
            <Text style={styles.gemmaLine}>
              Device class: <Text style={styles.gemmaValue}>{deviceInfo.deviceClass}</Text>
            </Text>
            <Text style={styles.gemmaLine}>
              RAM: <Text style={styles.gemmaValue}>{deviceInfo.totalMemoryGB.toFixed(1)} GB</Text>
            </Text>
            {deviceInfo.deviceClass === 'disabled' ? (
              <Text style={styles.hint}>
                On-device AI requires {'>='} 2 GB RAM. This device should use cloud only.
              </Text>
            ) : modelDownloaded ? (
              <>
                <Text style={styles.gemmaLine}>
                  Model: <Text style={styles.gemmaValue}>{MODEL_FILENAME}</Text>
                </Text>
                <Text style={styles.gemmaLine}>
                  Size on disk: <Text style={styles.gemmaValue}>{modelSizeGB.toFixed(2)} GB</Text>
                </Text>
                <Pressable onPress={handleDeleteModel} style={styles.removeBtn}>
                  <Text style={styles.removeBtnText}>Remove model</Text>
                </Pressable>
              </>
            ) : downloadProgress !== null ? (
              <>
                <Text style={styles.gemmaLine}>
                  Downloading… <Text style={styles.gemmaValue}>{(downloadProgress.fraction * 100).toFixed(0)}%</Text>
                </Text>
                <Text style={styles.gemmaLine}>
                  <Text style={styles.gemmaValue}>
                    {(downloadProgress.totalBytesWritten / MB).toFixed(0)} MB
                  </Text>
                  {downloadProgress.totalBytesExpectedToWrite > 0 && (
                    <>
                      {' / '}
                      <Text style={styles.gemmaValue}>
                        {(downloadProgress.totalBytesExpectedToWrite / MB).toFixed(0)} MB
                      </Text>
                    </>
                  )}
                </Text>
              </>
            ) : (
              <Pressable onPress={handleDownloadModel} style={styles.downloadBtn}>
                <Text style={styles.downloadBtnText}>
                  Download {deviceInfo.deviceClass === 'full' ? 'Gemma 3 4B (~2.5 GB)' : 'Gemma 3 1B (~700 MB)'}
                </Text>
              </Pressable>
            )}
          </View>
        ) : (
          <Text style={styles.hint}>Detecting device…</Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { paddingTop: 56, paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.cardBorder },
  scroll: { flex: 1 },
  content: { padding: 24, paddingBottom: 60, gap: 14 },
  title: { fontFamily: fonts.heading, fontSize: 28, color: colors.text, letterSpacing: -0.5 },
  subtitle: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted, lineHeight: 18 },
  label: { fontFamily: fonts.mono, fontSize: 9, color: colors.textDim, letterSpacing: 1, marginTop: 4 },
  hint: { fontFamily: fonts.body, fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: -2 },
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
  btnRow: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  saveBtn: { backgroundColor: 'rgba(232,213,176,0.1)', borderWidth: 1, borderColor: 'rgba(232,213,176,0.2)' },
  saveBtnText: { fontFamily: fonts.mono, fontSize: 12, color: colors.accent },
  testBtn: { backgroundColor: 'rgba(76,175,125,0.1)', borderWidth: 1, borderColor: 'rgba(76,175,125,0.2)' },
  testBtnText: { fontFamily: fonts.mono, fontSize: 12, color: colors.green },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
  disconnectBtn: { paddingVertical: 12, alignItems: 'center', backgroundColor: 'rgba(251,113,133,0.08)', borderWidth: 1, borderColor: 'rgba(251,113,133,0.2)', borderRadius: 8 },
  disconnectText: { fontFamily: fonts.mono, fontSize: 12, color: colors.coral },
  gemmaCard: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 8,
    padding: 14,
    gap: 6,
  },
  gemmaLine: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
  gemmaValue: { color: colors.text },
  downloadBtn: {
    marginTop: 6,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: 'rgba(232,213,176,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(232,213,176,0.2)',
    borderRadius: 8,
  },
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
});
