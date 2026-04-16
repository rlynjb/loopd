import * as SecureStore from 'expo-secure-store';

const KEY_ANTHROPIC = 'anthropic_api_key';
const KEY_OPENAI = 'openai_api_key';
const KEY_PROVIDER = 'ai_provider';

export type AIProvider = 'claude' | 'openai';

export async function getProvider(): Promise<AIProvider> {
  const p = await SecureStore.getItemAsync(KEY_PROVIDER);
  return (p === 'openai' ? 'openai' : 'claude') as AIProvider;
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

export async function isAIConfigured(): Promise<boolean> {
  const provider = await getProvider();
  if (provider === 'openai') {
    const key = await getOpenAIKey();
    return !!key && key.length > 0;
  }
  const key = await getAnthropicKey();
  return !!key && key.length > 0;
}
