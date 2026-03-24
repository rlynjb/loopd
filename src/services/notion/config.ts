import * as SecureStore from 'expo-secure-store';

const KEYS = {
  token: 'notion_token',
  dailyLogDbId: 'notion_daily_log_db_id',
  entriesDbId: 'notion_entries_db_id',
  lastSync: 'notion_last_sync',
  autoSync: 'notion_auto_sync',
};

export async function getNotionToken(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.token);
}

export async function setNotionToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.token, token);
}

export async function getDailyLogDbId(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.dailyLogDbId);
}

export async function setDailyLogDbId(id: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.dailyLogDbId, id);
}

export async function getEntriesDbId(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.entriesDbId);
}

export async function setEntriesDbId(id: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.entriesDbId, id);
}

export async function getLastSyncTimestamp(): Promise<string | null> {
  const val = await SecureStore.getItemAsync(KEYS.lastSync);
  return val || null;
}

export async function setLastSyncTimestamp(ts: string): Promise<void> {
  if (ts) {
    await SecureStore.setItemAsync(KEYS.lastSync, ts);
  } else {
    await SecureStore.deleteItemAsync(KEYS.lastSync);
  }
}

export async function isAutoSyncEnabled(): Promise<boolean> {
  const val = await SecureStore.getItemAsync(KEYS.autoSync);
  return val === 'true';
}

export async function setAutoSync(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(KEYS.autoSync, enabled ? 'true' : 'false');
}

export async function isNotionConfigured(): Promise<boolean> {
  const token = await getNotionToken();
  const entriesDb = await getEntriesDbId();
  return !!(token && entriesDb);
}

export async function clearNotionConfig(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.token);
  await SecureStore.deleteItemAsync(KEYS.dailyLogDbId);
  await SecureStore.deleteItemAsync(KEYS.entriesDbId);
  await SecureStore.deleteItemAsync(KEYS.lastSync);
  await SecureStore.deleteItemAsync(KEYS.autoSync);
}
