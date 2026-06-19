import * as SecureStore from 'expo-secure-store';

const KEY_ANTHROPIC = 'anthropic_api_key';
const KEY_OPENAI = 'openai_api_key';
const KEY_PROVIDER = 'ai_provider';
const KEY_STRICT_LOCAL = 'strict_local_mode';
const KEY_ROUTE_PREFIX = 'route_';

// "AIProvider" is the cloud-primary picker — which cloud provider to call
// first. The other one becomes the fallback when the primary is down /
// rate-limited. dryrun calls this the "cloud-primary"; loopd keeps the
// historical name for less churn through the existing call sites.
export type AIProvider = 'claude' | 'openai';

// The four chains that have routing settings. Per-chain routes decide
// whether to use on-device (Gemma via llama.rn) or cloud (Anthropic
// primary + OpenAI fallback per AIProvider).
export type ChainName = 'summarize' | 'caption' | 'interpret' | 'classify';

export type RouteChoice = 'on-device' | 'cloud';

// Default routes. Cloud-quality chains (summarize/caption/interpret)
// default to 'cloud' until on-device evals justify flipping. classify
// defaults to 'on-device' — high volume, cheap inference, low quality
// bar (it's just labelling intent).
const DEFAULT_ROUTES: Record<ChainName, RouteChoice> = {
  summarize: 'cloud',
  caption: 'cloud',
  interpret: 'cloud',
  classify: 'on-device',
};

export async function getProvider(): Promise<AIProvider> {
  const p = await SecureStore.getItemAsync(KEY_PROVIDER);
  return p === 'openai' ? 'openai' : 'claude';
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

// Strict local mode. When true, chains must not fall back to any cloud
// provider. The chain returns its existing failure shape instead.
export async function getStrictLocalMode(): Promise<boolean> {
  const v = await SecureStore.getItemAsync(KEY_STRICT_LOCAL);
  return v === 'true';
}

export async function setStrictLocalMode(on: boolean): Promise<void> {
  await SecureStore.setItemAsync(KEY_STRICT_LOCAL, on ? 'true' : 'false');
}

// Per-chain routing — read whenever a chain is invoked, write whenever
// the user toggles the chip in Settings → AI → Routing.
export async function getChainRoute(chain: ChainName): Promise<RouteChoice> {
  const v = await SecureStore.getItemAsync(`${KEY_ROUTE_PREFIX}${chain}`);
  if (v === 'on-device' || v === 'cloud') return v;
  return DEFAULT_ROUTES[chain];
}

export async function setChainRoute(chain: ChainName, route: RouteChoice): Promise<void> {
  await SecureStore.setItemAsync(`${KEY_ROUTE_PREFIX}${chain}`, route);
}

// Whether the user has any AI configured that could serve a chain.
// True if either cloud key exists OR on-device Gemma is ready. Used by
// _layout.tsx to decide whether to auto-summarize yesterday.
export async function isAIConfigured(): Promise<boolean> {
  const [claudeKey, openaiKey] = await Promise.all([
    getAnthropicKey(),
    getOpenAIKey(),
  ]);
  if (claudeKey || openaiKey) return true;
  // No cloud keys — but on-device might be ready.
  const { shouldUseGemmaLocal } = await import('./providers/gemma');
  return shouldUseGemmaLocal();
}
