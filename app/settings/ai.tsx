import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useState, useEffect } from 'react';
import { colors, fonts } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';
import {
  getAnthropicKey, setAnthropicKey, clearAnthropicKey,
  getOpenAIKey, setOpenAIKey, clearOpenAIKey,
  getProvider, setProvider, type AIProvider,
} from '../../src/services/ai/config';
import { testConnection } from '../../src/services/ai/summarize';

export default function AISettingsScreen() {
  const router = useRouter();
  const [provider, setProviderState] = useState<AIProvider>('claude');
  const [claudeKey, setClaudeKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<'none' | 'ok' | 'error'>('none');

  useEffect(() => {
    (async () => {
      const p = await getProvider();
      setProviderState(p);
      const ck = await getAnthropicKey();
      if (ck) setClaudeKey(ck);
      const ok = await getOpenAIKey();
      if (ok) setOpenaiKey(ok);
      if ((p === 'claude' && ck) || (p === 'openai' && ok)) setStatus('ok');
    })();
  }, []);

  const handleProviderChange = async (p: AIProvider) => {
    setProviderState(p);
    await setProvider(p);
    const key = p === 'openai' ? openaiKey : claudeKey;
    setStatus(key ? 'ok' : 'none');
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

  const currentKey = provider === 'claude' ? claudeKey : openaiKey;
  const setCurrentKey = provider === 'claude' ? setClaudeKey : setOpenaiKey;
  const placeholder = provider === 'claude' ? 'sk-ant-...' : 'sk-...';
  const hasSavedKey = currentKey.length > 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 8 }}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.title}>AI Settings</Text>
        <Text style={styles.subtitle}>Connect to Claude or OpenAI for AI-powered vlog summaries and auto-composition.</Text>

        {/* Provider toggle */}
        <Text style={styles.label}>PROVIDER</Text>
        <View style={styles.providerRow}>
          <Pressable
            onPress={() => handleProviderChange('claude')}
            style={[styles.providerBtn, provider === 'claude' && styles.providerBtnActive]}
          >
            <Text style={[styles.providerText, provider === 'claude' && styles.providerTextActive]}>Claude</Text>
          </Pressable>
          <Pressable
            onPress={() => handleProviderChange('openai')}
            style={[styles.providerBtn, provider === 'openai' && styles.providerBtnActive]}
          >
            <Text style={[styles.providerText, provider === 'openai' && styles.providerTextActive]}>OpenAI</Text>
          </Pressable>
        </View>

        {/* API key */}
        <Text style={styles.label}>{provider === 'claude' ? 'ANTHROPIC' : 'OPENAI'} API KEY</Text>
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
});
