import { Paths, Directory, File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { generateId } from '../utils/id';
import { getFFmpeg, quoteFFmpegPath } from './ffmpeg';

// Proxy transcode target. 1080p long-edge keeps file sizes small (~3-5 MB
// for a short vlog clip) and keeps the Android MediaCodec happy — two
// concurrent 4K decoders stutter on the double-buffer preview, two 1080p
// decoders do not. See docs/media-pipeline.md for the full rationale.
const PROXY_MAX_LONG_EDGE = 1920;
const PROXY_MAX_SHORT_EDGE = 1080;
const PROXY_CRF = 23;

export function uriToPath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

async function ensureDir(dir: Directory): Promise<void> {
  if (!dir.exists) {
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
  // `media/` is a flat folder of transcoded proxies shared across all dates.
  // Backup = copy this folder; restore = drop it into the new install.
  await ensureDir(new Directory(Paths.document, 'loopd', 'media'));
  await ensureDir(new Directory(Paths.document, 'loopd', 'exports', date));
  await ensureDir(new Directory(Paths.document, 'loopd', 'temp'));
}

export function getMediaPath(clipId: string): string {
  return new File(Paths.document, 'loopd', 'media', `${clipId}.mp4`).uri;
}

/**
 * Transcode a source video (camera recording or library pick) into a
 * 1080p-max H.264 proxy stored in `loopd/media/{clipId}.mp4`. The original
 * is never copied or moved; only the proxy lives inside app storage.
 *
 * All editor operations (preview, trim, double-buffered playback, export)
 * run against the proxy. This keeps two simultaneous decoders within
 * Android codec limits and makes per-clip storage predictable (~3-5 MB
 * vs. 50-200 MB for a 4K HDR original).
 */
export type TranscodeHandle = {
  cancel: () => Promise<void>;
};

export async function transcodeToProxy(
  sourceUri: string,
  onHandle?: (handle: TranscodeHandle) => void,
): Promise<string> {
  const { FFmpegKit, ReturnCode } = await getFFmpeg();
  const clipId = generateId('m');
  await ensureDir(new Directory(Paths.document, 'loopd', 'media'));
  const outputUri = getMediaPath(clipId);
  const outputPath = uriToPath(outputUri);

  const inQuoted = quoteFFmpegPath(sourceUri);
  const outQuoted = quoteFFmpegPath(outputPath);

  // Scale so the longer side fits within PROXY_MAX_LONG_EDGE and the shorter
  // within PROXY_MAX_SHORT_EDGE. Preserves aspect ratio and orientation.
  // Never upscales (decrease only).
  const scaleFilter = `scale='if(gt(iw,ih),min(${PROXY_MAX_LONG_EDGE},iw),min(${PROXY_MAX_SHORT_EDGE},iw))':'if(gt(iw,ih),min(${PROXY_MAX_SHORT_EDGE},ih),min(${PROXY_MAX_LONG_EDGE},ih))':force_original_aspect_ratio=decrease:flags=bicubic,pad=ceil(iw/2)*2:ceil(ih/2)*2`;

  const cmd = `-y -i ${inQuoted} ` +
    `-vf "${scaleFilter}" ` +
    `-c:v libx264 -preset fast -crf ${PROXY_CRF} -pix_fmt yuv420p ` +
    `-c:a aac -b:a 128k -ar 44100 -ac 2 ` +
    `-movflags +faststart ` +
    `${outQuoted}`;

  console.log('[loopd] transcode:', cmd);

  // Run asynchronously so we can hand back a cancel() before awaiting completion.
  let cancelled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const session = await FFmpegKit.executeAsync(cmd, () => resolveDone());

  if (onHandle) {
    onHandle({
      cancel: async () => {
        cancelled = true;
        try { await session.cancel(); } catch { /* best-effort */ }
      },
    });
  }

  await done;

  if (cancelled) {
    // Best-effort cleanup of the partial output file.
    try {
      const partial = new File(outputPath);
      if (partial.exists) partial.delete();
    } catch { /* ignore */ }
    throw new TranscodeCancelledError();
  }

  const returnCode = await session.getReturnCode();
  if (!ReturnCode.isSuccess(returnCode)) {
    const logs = await session.getAllLogs();
    const last = logs.slice(-5).map(l => l.getMessage()).join('\n');
    throw new Error(`Transcode failed: ${last || 'unknown error'}`);
  }
  return outputUri;
}

export class TranscodeCancelledError extends Error {
  constructor() {
    super('Transcode cancelled');
    this.name = 'TranscodeCancelledError';
  }
}

async function captureToProxy(
  asset: ImagePicker.ImagePickerAsset,
  onHandle?: (handle: TranscodeHandle) => void,
): Promise<{ uri: string; durationMs: number }> {
  const rawDuration = asset.duration ?? 0;
  const durationMs = rawDuration > 0 && rawDuration < 1000
    ? rawDuration * 1000
    : rawDuration;

  try {
    const proxyUri = await transcodeToProxy(asset.uri, onHandle);
    return { uri: proxyUri, durationMs };
  } catch (e) {
    if (e instanceof TranscodeCancelledError) throw e;
    console.warn('[loopd] Transcode failed, falling back to source URI:', e);
    // Fallback: caller keeps referencing the original (content:// or file://).
    // Editor/export will still work, just without the proxy benefits.
    return { uri: asset.uri, durationMs };
  }
}

export async function recordClip(
  _date: string,
  onProcessing?: () => void,
  onHandle?: (handle: TranscodeHandle) => void,
): Promise<{ uri: string; durationMs: number } | null> {
  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  if (status !== 'granted') return null;

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['videos'],
    quality: 1,
    videoQuality: 1,
  });

  if (result.canceled || result.assets.length === 0) return null;

  onProcessing?.();

  // Preserve the untouched original in the system gallery (DCIM) as the
  // user's master. Non-critical — if it fails we still have the proxy.
  try {
    await saveToDCIMLoopd(result.assets[0].uri);
  } catch { /* non-critical */ }

  return await captureToProxy(result.assets[0], onHandle);
}

export async function pickAndCopyClip(
  _date: string,
  onProcessing?: () => void,
  onHandle?: (handle: TranscodeHandle) => void,
): Promise<{ uri: string; durationMs: number } | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    quality: 1,
  });

  if (result.canceled || result.assets.length === 0) return null;
  onProcessing?.();
  // Library picks already live in the user's gallery — no DCIM copy needed.
  return await captureToProxy(result.assets[0], onHandle);
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
