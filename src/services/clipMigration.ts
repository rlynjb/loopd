import { File as FSFile } from 'expo-file-system';
import { getAllEntries, getDatabase } from './database';
import { transcodeToProxy, normalizeClipUriForStorage } from './fileManager';

// Clips imported before the transcode-on-capture change live at the old
// per-date path (`buffr/clips/{date}/…`) at original (usually 4K) resolution.
// The editor's double-buffer preview stutters on those because two
// concurrent 4K decoders exceed Android MediaCodec limits. This service
// walks the DB, re-transcodes each old clip into the flat `buffr/media/`
// proxy layout, and rewrites all entries that reference the old URI.
//
// Safe to re-run: any URI already containing `/buffr/media/` is skipped,
// so re-running only picks up whatever failed last time.

const PROXY_PATH_MARKER = '/buffr/media/';

function needsMigration(uri: string | null | undefined): boolean {
  if (!uri) return false;
  // Keep system gallery URIs untouched — they're managed by MediaLibrary.
  if (uri.startsWith('content://')) return false;
  // Already a proxy.
  if (uri.includes(PROXY_PATH_MARKER)) return false;
  // Bare filenames (no path separator) can't be transcoded — would break.
  if (!uri.includes('/')) return false;
  return true;
}

export type MigrationStatus = {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  currentUri: string | null;
};

type Listener = (s: MigrationStatus) => void;

let status: MigrationStatus = {
  running: false,
  total: 0,
  done: 0,
  failed: 0,
  currentUri: null,
};
const listeners = new Set<Listener>();

function emit(next: Partial<MigrationStatus>) {
  status = { ...status, ...next };
  for (const l of listeners) l(status);
}

export function getMigrationStatus(): MigrationStatus {
  return status;
}

export function subscribeToMigration(listener: Listener): () => void {
  listeners.add(listener);
  listener(status);
  return () => { listeners.delete(listener); };
}

async function fileExists(uri: string): Promise<boolean> {
  try {
    const path = uri.startsWith('file://') ? uri : `file://${uri}`;
    const file = new FSFile(path);
    return file.exists;
  } catch {
    return false;
  }
}

// Update both clips_json and the legacy clip_uri/clip_duration_ms columns so
// anything reading the legacy fields also sees the new proxy URIs.
async function rewriteEntryClips(
  id: string,
  newClips: { uri: string; durationMs: number }[],
  newClipUri: string | null,
  newClipDurationMs: number | null,
): Promise<void> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const normalizedClips = newClips.map(c => ({ ...c, uri: normalizeClipUriForStorage(c.uri) ?? c.uri }));
  const normalizedClipUri = normalizeClipUriForStorage(newClipUri);
  await db.runAsync(
    `UPDATE entries SET clip_uri = ?, clip_duration_ms = ?, clips_json = ?, updated_at = ? WHERE id = ?`,
    [normalizedClipUri, newClipDurationMs, JSON.stringify(normalizedClips), now, id],
  );
}

export async function countPendingMigrations(): Promise<number> {
  const entries = await getAllEntries();
  const uris = new Set<string>();
  for (const e of entries) {
    for (const c of e.clips) if (needsMigration(c.uri)) uris.add(c.uri);
    if (e.clipUri && needsMigration(e.clipUri)) uris.add(e.clipUri);
  }
  return uris.size;
}

export async function migrateOldClips(): Promise<void> {
  if (status.running) return;
  emit({ running: true, total: 0, done: 0, failed: 0, currentUri: null });

  try {
    const entries = await getAllEntries();

    // Collect unique old URIs. A single original file can be referenced by
    // multiple entries (rare, but Notion sync can duplicate). Transcode
    // once, then rewrite every referencing entry.
    const oldUris = new Set<string>();
    for (const e of entries) {
      for (const c of e.clips) if (needsMigration(c.uri)) oldUris.add(c.uri);
      if (e.clipUri && needsMigration(e.clipUri)) oldUris.add(e.clipUri);
    }

    emit({ total: oldUris.size });
    if (oldUris.size === 0) {
      console.log('[clipMigration] no clips need migration');
      return;
    }
    console.log(`[clipMigration] ${oldUris.size} clip URI(s) to migrate`);

    // oldUri -> newUri (null if transcode failed or source missing)
    const uriMap = new Map<string, string | null>();

    for (const oldUri of oldUris) {
      emit({ currentUri: oldUri });
      try {
        const exists = await fileExists(oldUri);
        if (!exists) {
          console.warn('[clipMigration] source missing, skipping:', oldUri);
          uriMap.set(oldUri, null);
          emit({ failed: status.failed + 1 });
          continue;
        }
        const newUri = await transcodeToProxy(oldUri);
        uriMap.set(oldUri, newUri);
        emit({ done: status.done + 1 });
        console.log(`[clipMigration] ${oldUri} -> ${newUri}`);
      } catch (err) {
        console.error('[clipMigration] transcode failed:', oldUri, err);
        uriMap.set(oldUri, null);
        emit({ failed: status.failed + 1 });
      }
    }

    // Rewrite entries. For each entry, replace clips[i].uri and legacy
    // clipUri/clipDurationMs if they were successfully migrated.
    for (const entry of entries) {
      let mutated = false;
      const newClips = entry.clips.map(c => {
        const mapped = uriMap.get(c.uri);
        if (mapped) {
          mutated = true;
          return { ...c, uri: mapped };
        }
        return c;
      });
      let newClipUri = entry.clipUri;
      let newClipDurationMs = entry.clipDurationMs;
      if (entry.clipUri && uriMap.get(entry.clipUri)) {
        newClipUri = uriMap.get(entry.clipUri)!;
        // durationMs stays the same — source content unchanged, just re-encoded.
        mutated = true;
      }
      if (mutated) {
        await rewriteEntryClips(entry.id, newClips, newClipUri, newClipDurationMs);
      }
    }

    console.log(`[clipMigration] done: ${status.done} migrated, ${status.failed} failed`);
  } finally {
    emit({ running: false, currentUri: null });
  }
}
