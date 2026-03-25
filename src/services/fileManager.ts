import { Paths, Directory, File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

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

export async function ensureDirectories(date: string): Promise<void> {
  await ensureDir(new Directory(Paths.document, 'loopd', 'clips', date));
  await ensureDir(new Directory(Paths.document, 'loopd', 'exports', date));
  await ensureDir(new Directory(Paths.document, 'loopd', 'temp'));
}

export async function pickAndCopyClip(
  date: string
): Promise<{ uri: string; durationMs: number } | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    quality: 1,
  });

  if (result.canceled || result.assets.length === 0) return null;

  const asset = result.assets[0];

  // expo-image-picker duration: ms on Android, seconds on iOS — normalize
  const rawDuration = asset.duration ?? 0;
  const durationMs = rawDuration > 0 && rawDuration < 1000
    ? rawDuration * 1000
    : rawDuration;

  await ensureDirectories(date);

  // Use the original filename from the device
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
    console.warn('[loopd] File copy failed, using picker URI directly:', e);
  }

  // Fallback: use the picker URI directly
  return { uri: asset.uri, durationMs };
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
