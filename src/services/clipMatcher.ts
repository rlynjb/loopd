import * as MediaLibrary from 'expo-media-library';
import { File as FSFile, Paths, Directory } from 'expo-file-system';
import type { Entry, ClipRef } from '../types/entry';

async function ensureClipDir(date: string): Promise<void> {
  const dir = new Directory(Paths.document, 'loopd', 'clips', date);
  if (!dir.exists) await dir.create();
}

/**
 * For video entries with missing local clip files, try to find matching
 * videos in the device's camera roll by creation date and duration.
 */
export async function reimportMissingClips(entries: Entry[]): Promise<number> {
  const { status } = await MediaLibrary.requestPermissionsAsync();
  if (status !== 'granted') {
    console.log('[loopd matcher] No media library permission');
    return 0;
  }

  let reimported = 0;

  for (const entry of entries) {
    if (entry.clips.length === 0 && !entry.clipUri) continue;

    const clips = entry.clips.length > 0
      ? entry.clips
      : entry.clipUri ? [{ uri: entry.clipUri, durationMs: entry.clipDurationMs ?? 0 }] : [];

    if (clips.length === 0) continue;

    // Check if ANY clips are missing
    let hasMissing = false;
    for (const clip of clips) {
      try {
        const file = new FSFile(clip.uri);
        if (!file.exists) { hasMissing = true; break; }
      } catch {
        hasMissing = true; break;
      }
    }
    if (!hasMissing) continue;

    const updatedClips: ClipRef[] = [];
    let changed = false;

    for (const clip of clips) {
      // Check if local file exists
      let exists = false;
      try {
        const file = new FSFile(clip.uri);
        exists = file.exists;
      } catch { /* missing */ }

      if (exists) {
        updatedClips.push(clip);
        continue;
      }

      // File is missing — try to find it in camera roll
      console.log('[loopd matcher] Missing clip:', clip.uri.split('/').pop(), 'duration:', clip.durationMs, 'entry date:', entry.date, 'created:', entry.createdAt);

      const matched = await findInCameraRoll(clip.durationMs, entry.createdAt, entry.date);

      if (matched) {
        // Copy to local storage
        await ensureClipDir(entry.date);
        const destFilename = matched.filename ?? `clip-${Date.now()}.mp4`;
        const destDir = new Directory(Paths.document, 'loopd', 'clips', entry.date);
        const destFile = new FSFile(destDir, destFilename);

        try {
          const assetInfo = await MediaLibrary.getAssetInfoAsync(matched);
          const sourceUri = assetInfo.localUri ?? matched.uri;
          const srcFile = new FSFile(sourceUri);
          await srcFile.copy(destFile);
          updatedClips.push({ uri: destFile.uri, durationMs: matched.duration * 1000 });
          changed = true;
          reimported++;
          console.log('[loopd matcher] Auto-reimported:', matched.filename, '→', destFilename);
        } catch (err) {
          // Fallback: use the media library URI directly
          const assetInfo = await MediaLibrary.getAssetInfoAsync(matched);
          const uri = assetInfo.localUri ?? matched.uri;
          updatedClips.push({ uri, durationMs: matched.duration * 1000 });
          changed = true;
          reimported++;
          console.log('[loopd matcher] Linked from camera roll:', matched.filename);
        }
      } else {
        console.log('[loopd matcher] No match found for clip');
        updatedClips.push(clip);
      }
    }

    if (changed) {
      const { upsertEntryFromNotion } = await import('./database');
      await upsertEntryFromNotion({
        ...entry,
        clips: updatedClips,
        clipUri: updatedClips[0]?.uri ?? null,
        clipDurationMs: updatedClips[0]?.durationMs ?? null,
      });
    }
  }

  return reimported;
}

async function findInCameraRoll(
  durationMs: number,
  createdAt: string,
  entryDate: string,
): Promise<MediaLibrary.Asset | null> {
  // Strategy 1: Search by the entire day of the entry (wide window)
  const dayStart = new Date(entryDate + 'T00:00:00');
  const dayEnd = new Date(entryDate + 'T23:59:59');

  try {
    const { assets } = await MediaLibrary.getAssetsAsync({
      mediaType: 'video',
      createdAfter: dayStart.getTime(),
      createdBefore: dayEnd.getTime(),
      first: 50,
      sortBy: [MediaLibrary.SortBy.creationTime],
    });

    console.log(`[loopd matcher] Found ${assets.length} videos on ${entryDate}`);

    if (assets.length === 0) {
      // Try wider: ±1 day
      const wideStart = new Date(dayStart.getTime() - 86400000);
      const wideEnd = new Date(dayEnd.getTime() + 86400000);
      const { assets: wideAssets } = await MediaLibrary.getAssetsAsync({
        mediaType: 'video',
        createdAfter: wideStart.getTime(),
        createdBefore: wideEnd.getTime(),
        first: 50,
        sortBy: [MediaLibrary.SortBy.creationTime],
      });
      console.log(`[loopd matcher] Wide search: ${wideAssets.length} videos ±1 day`);
      if (wideAssets.length === 0) return null;
      return matchByDurationAndTime(wideAssets, durationMs, createdAt);
    }

    return matchByDurationAndTime(assets, durationMs, createdAt);
  } catch (err) {
    console.warn('[loopd matcher] Camera roll search failed:', err);
  }

  return null;
}

function matchByDurationAndTime(
  assets: MediaLibrary.Asset[],
  durationMs: number,
  createdAt: string,
): MediaLibrary.Asset | null {
  const durationSec = durationMs / 1000;
  const entryTime = new Date(createdAt).getTime();

  // Best match: duration within 2 seconds AND closest to entry creation time
  if (durationSec > 0) {
    const durationMatches = assets.filter(a => Math.abs(a.duration - durationSec) < 2);
    if (durationMatches.length === 1) return durationMatches[0];
    if (durationMatches.length > 1) {
      // Multiple duration matches — pick closest to entry time
      return durationMatches.sort((a, b) =>
        Math.abs(a.creationTime - entryTime) - Math.abs(b.creationTime - entryTime)
      )[0];
    }
  }

  // Fallback: closest in time to entry creation (within 10 minutes)
  const timeMatches = assets
    .map(a => ({ asset: a, diff: Math.abs(a.creationTime - entryTime) }))
    .filter(m => m.diff < 600000) // 10 minutes
    .sort((a, b) => a.diff - b.diff);

  if (timeMatches.length > 0) return timeMatches[0].asset;

  // Last resort: if only one video that day, use it
  if (assets.length === 1) return assets[0];

  return null;
}
