import { Paths, Directory, File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

function getBaseDir(): Directory {
  return new Directory(Paths.document, 'loopd');
}

export async function ensureDirectories(date: string): Promise<void> {
  const clipsDir = new Directory(Paths.document, 'loopd', 'clips', date);
  const exportsDir = new Directory(Paths.document, 'loopd', 'exports', date);
  const tempDir = new Directory(Paths.document, 'loopd', 'temp');

  if (!clipsDir.exists) await clipsDir.create();
  if (!exportsDir.exists) await exportsDir.create();
  if (!tempDir.exists) await tempDir.create();
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
  await ensureDirectories(date);

  const filename = `clip-${Date.now()}.mp4`;
  const destDir = new Directory(Paths.document, 'loopd', 'clips', date);
  const destFile = new File(destDir, filename);

  const sourceFile = new File(asset.uri);
  await sourceFile.copy(destFile);

  return {
    uri: destFile.uri,
    durationMs: (asset.duration ?? 0) * 1000,
  };
}

export function getExportPath(date: string): string {
  const file = new File(Paths.document, 'loopd', 'exports', date, `vlog-${date}.mp4`);
  return file.uri;
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
