import * as SecureStore from 'expo-secure-store';

const KEYS = {
  token: 'notion_token',
  entriesDbId: 'notion_entries_db_id',
  todosDbId: 'notion_todos_db_id',
  lastSync: 'notion_last_sync',
  todosLastSync: 'notion_todos_last_sync',
  autoSync: 'notion_auto_sync',
};

export async function getNotionToken(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.token);
}

export async function setNotionToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.token, token);
}

export async function getEntriesDbId(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.entriesDbId);
}

export async function setEntriesDbId(id: string): Promise<void> {
  await SecureStore.setItemAsync(KEYS.entriesDbId, id);
}

export async function getTodosDbId(): Promise<string | null> {
  return SecureStore.getItemAsync(KEYS.todosDbId);
}

export async function setTodosDbId(id: string): Promise<void> {
  if (id) {
    await SecureStore.setItemAsync(KEYS.todosDbId, id);
  } else {
    await SecureStore.deleteItemAsync(KEYS.todosDbId);
  }
}

export async function getTodosLastSyncTimestamp(): Promise<string | null> {
  const val = await SecureStore.getItemAsync(KEYS.todosLastSync);
  return val || null;
}

export async function setTodosLastSyncTimestamp(ts: string): Promise<void> {
  if (ts) {
    await SecureStore.setItemAsync(KEYS.todosLastSync, ts);
  } else {
    await SecureStore.deleteItemAsync(KEYS.todosLastSync);
  }
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
  await SecureStore.deleteItemAsync(KEYS.entriesDbId);
  await SecureStore.deleteItemAsync(KEYS.todosDbId);
  await SecureStore.deleteItemAsync(KEYS.lastSync);
  await SecureStore.deleteItemAsync(KEYS.todosLastSync);
  await SecureStore.deleteItemAsync(KEYS.autoSync);
}
