import { Paths, Directory, File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';

export function uriToPath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

async function ensureDir(dir: Directory): Promise<void> {
  if (!dir.exists) {
    // Parent must exist first
    const parentUri = dir.uri.replace(/\/[^/]+\/?$/, '');
    if (parentUri && parentUri !== dir.uri) {
      const parent = new Directory(parentUri);
      await ensureDir(parent);
    }
    await dir.create();
  }
}

export async function saveToDCIMLoopd(sourceUri: string): Promise<void> {
  const { status } = await MediaLibrary.requestPermissionsAsync();
  if (status !== 'granted') return;

  // Save to gallery — Android places it in DCIM automatically
  await MediaLibrary.createAssetAsync(sourceUri);
  console.log('[loopd] Saved to gallery');
}

export async function ensureDirectories(date: string): Promise<void> {
  await ensureDir(new Directory(Paths.document, 'loopd', 'clips', date));
  await ensureDir(new Directory(Paths.document, 'loopd', 'exports', date));
  await ensureDir(new Directory(Paths.document, 'loopd', 'temp'));
}

export async function recordClip(
  date: string
): Promise<{ uri: string; durationMs: number } | null> {
  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  if (status !== 'granted') return null;

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['videos'],
    quality: 1,
    videoQuality: 1,
  });

  if (result.canceled || result.assets.length === 0) return null;

  // Save to DCIM/loopd
  try {
    await saveToDCIMLoopd(result.assets[0].uri);
  } catch { /* non-critical */ }

  return await copyAssetToLocal(result.assets[0], date);
}

async function copyAssetToLocal(
  asset: ImagePicker.ImagePickerAsset,
  date: string,
): Promise<{ uri: string; durationMs: number }> {
  const rawDuration = asset.duration ?? 0;
  const durationMs = rawDuration > 0 && rawDuration < 1000
    ? rawDuration * 1000
    : rawDuration;

  await ensureDirectories(date);

  const originalName = asset.uri.split('/').pop() ?? `clip-${Date.now()}.mp4`;
  const destDir = new Directory(Paths.document, 'loopd', 'clips', date);
  const destFile = new File(destDir, originalName);

  try {
    const sourceFile = new File(asset.uri);
    await sourceFile.copy(destFile);
    if (destFile.exists) {
      return { uri: destFile.uri, durationMs };
    }
  } catch (e) {
    console.warn('[loopd] File copy failed, using source URI:', e);
  }

  return { uri: asset.uri, durationMs };
}

export async function pickAndCopyClip(
  date: string
): Promise<{ uri: string; durationMs: number } | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    quality: 1,
  });

  if (result.canceled || result.assets.length === 0) return null;
  return await copyAssetToLocal(result.assets[0], date);
}

export function getExportPath(date: string): string {
  return new File(Paths.document, 'loopd', 'exports', date, `vlog-${date}.mp4`).uri;
}

export function getTempDir(): string {
  return new Directory(Paths.document, 'loopd', 'temp').uri;
}

export async function cleanTemp(): Promise<void> {
  const tempDir = new Directory(Paths.document, 'loopd', 'temp');
  if (tempDir.exists) {
    await tempDir.delete();
    await tempDir.create();
  }
}
