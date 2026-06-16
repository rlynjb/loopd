import * as SecureStore from 'expo-secure-store';

const KEY_ANTHROPIC = 'anthropic_api_key';
const KEY_OPENAI = 'openai_api_key';
const KEY_GEMMA_CLOUD = 'gemma_cloud_api_key';
const KEY_PROVIDER = 'ai_provider';
const KEY_STRICT_LOCAL = 'strict_local_mode';

export type AIProvider = 'claude' | 'openai' | 'gemma';

export async function getProvider(): Promise<AIProvider> {
  const p = await SecureStore.getItemAsync(KEY_PROVIDER);
  if (p === 'openai') return 'openai';
  if (p === 'gemma') return 'gemma';
  return 'claude';
}

export async function setProvider(provider: AIProvider): Promise<void> {
  await SecureStore.setItemAsync(KEY_PROVIDER, provider);
}

export async function getAnthropicKey(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_ANTHROPIC);
}

export async function setAnthropicKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_ANTHROPIC, key);
}

export async function clearAnthropicKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_ANTHROPIC);
}

export async function getOpenAIKey(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_OPENAI);
}

export async function setOpenAIKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_OPENAI, key);
}

export async function clearOpenAIKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_OPENAI);
}

// Gemma cloud key — used by callGemmaCloud (Together.ai) in
// src/services/ai/providers/gemma.ts. Phase C will add on-device
// inference and won't need a key for that path.
export async function getGemmaCloudKey(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_GEMMA_CLOUD);
}

export async function setGemmaCloudKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_GEMMA_CLOUD, key);
}

export async function clearGemmaCloudKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY_GEMMA_CLOUD);
}

// Strict local mode. When true, chains must not fall back to any cloud
// provider — including cloud Gemma. The chain returns its existing
// failure shape instead. Default false; flipped to true by the user in
// Settings → AI when Phase B Commit 3 lands the toggle.
export async function getStrictLocalMode(): Promise<boolean> {
  const v = await SecureStore.getItemAsync(KEY_STRICT_LOCAL);
  return v === 'true';
}

export async function setStrictLocalMode(on: boolean): Promise<void> {
  await SecureStore.setItemAsync(KEY_STRICT_LOCAL, on ? 'true' : 'false');
}

export async function isAIConfigured(): Promise<boolean> {
  const provider = await getProvider();
  if (provider === 'openai') {
    const key = await getOpenAIKey();
    return !!key && key.length > 0;
  }
  if (provider === 'gemma') {
    const key = await getGemmaCloudKey();
    return !!key && key.length > 0;
  }
  const key = await getAnthropicKey();
  return !!key && key.length > 0;
}
