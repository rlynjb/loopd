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

export async function saveToDCIMBuffr(sourceUri: string): Promise<void> {
  const { status } = await MediaLibrary.requestPermissionsAsync();
  if (status !== 'granted') return;

  // Save to gallery — Android places it in DCIM automatically
  await MediaLibrary.createAssetAsync(sourceUri);
  console.log('[buffr] Saved to gallery');
}

export async function ensureDirectories(date: string): Promise<void> {
  // `media/` is a flat folder of transcoded proxies shared across all dates.
  // Backup = copy this folder; restore = drop it into the new install.
  await ensureDir(new Directory(Paths.document, 'buffr', 'media'));
  await ensureDir(new Directory(Paths.document, 'buffr', 'exports', date));
  await ensureDir(new Directory(Paths.document, 'buffr', 'temp'));
}

export function getMediaPath(clipId: string): string {
  return new File(Paths.document, 'buffr', 'media', `${clipId}.mp4`).uri;
}

function getBuffrRootPath(): string {
  return uriToPath(new Directory(Paths.document, 'buffr').uri);
}

// Convert an absolute clip URI inside our sandbox to a path relative to
// `{docs}/buffr/` so the DB survives a sandbox-path change (reinstall,
// different Android user profile). External URIs (content://, other
// filesystem locations) pass through unchanged.
export function normalizeClipUriForStorage(uri: string | null | undefined): string | null {
  if (!uri) return null;
  if (uri.startsWith('content://')) return uri;
  const root = getBuffrRootPath();
  const path = uriToPath(uri);
  if (path.startsWith(root + '/')) return path.slice(root.length + 1);
  return uri;
}

// Inverse of normalizeClipUriForStorage — resolve any stored URI to one a
// media component (Video, VideoThumbnails) can load directly.
export function resolveClipUri(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (stored.startsWith('content://') || stored.startsWith('file://')) return stored;
  if (stored.startsWith('/')) return `file://${stored}`;
  // Treat as relative to buffr root.
  const rootUri = new Directory(Paths.document, 'buffr').uri;
  return `${rootUri}/${stored}`;
}

/**
 * Transcode a source video (camera recording or library pick) into a
 * 1080p-max H.264 proxy stored in `buffr/media/{clipId}.mp4`. The original
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

export class TranscodeCancelledError extends Error {
  constructor() {
    super('Transcode cancelled');
    this.name = 'TranscodeCancelledError';
  }
}

export class DiskFullError extends Error {
  constructor() {
    super('Not enough free storage to transcode this clip.');
    this.name = 'DiskFullError';
  }
}

// Cap concurrent FFmpeg sessions. Two run fine; beyond that, MediaCodec and
// memory pressure stacks up. Extra imports wait in FIFO order.
const MAX_CONCURRENT_TRANSCODES = 2;
let activeTranscodes = 0;
const transcodeQueue: Array<() => void> = [];

async function acquireTranscodeSlot(): Promise<void> {
  if (activeTranscodes < MAX_CONCURRENT_TRANSCODES) {
    activeTranscodes++;
    return;
  }
  await new Promise<void>(resolve => transcodeQueue.push(resolve));
  activeTranscodes++;
}

function releaseTranscodeSlot(): void {
  activeTranscodes--;
  const next = transcodeQueue.shift();
  if (next) next();
}

function isDiskFullError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('no space left') || lower.includes('enospc') || lower.includes('disk full');
}

export async function transcodeToProxy(
  sourceUri: string,
  onHandle?: (handle: TranscodeHandle) => void,
): Promise<string> {
  await acquireTranscodeSlot();
  try {
    const { FFmpegKit, ReturnCode } = await getFFmpeg();
    const clipId = generateId('m');
    await ensureDir(new Directory(Paths.document, 'buffr', 'media'));
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

    console.log('[buffr] transcode:', cmd);

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
      const msg = last || 'unknown error';
      // Clean up any partial output so a later retry has a fresh target.
      try {
        const partial = new File(outputPath);
        if (partial.exists) partial.delete();
      } catch { /* ignore */ }
      if (isDiskFullError(msg)) throw new DiskFullError();
      throw new Error(`Transcode failed: ${msg}`);
    }
    return outputUri;
  } finally {
    releaseTranscodeSlot();
  }
}

export async function captureToProxy(
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
    if (e instanceof DiskFullError) throw e;
    console.warn('[buffr] Transcode failed, falling back to source URI:', e);
    // Fallback: caller keeps referencing the original (content:// or file://).
    // Editor/export will still work, just without the proxy benefits.
    return { uri: asset.uri, durationMs };
  }
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

// Multi-select variant: returns the raw picked assets so the caller can spawn
// N parallel transcodes, each with its own cancel handle and pending placeholder.
// The transcode queue in this file caps concurrent FFmpeg sessions at 2; the
// rest wait FIFO.
export async function pickVideoAssets(
  multi = true,
): Promise<ImagePicker.ImagePickerAsset[] | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    quality: 1,
    allowsMultipleSelection: multi,
  });
  if (result.canceled || result.assets.length === 0) return null;
  return result.assets;
}

export function getExportPath(date: string): string {
  return new File(Paths.document, 'buffr', 'exports', date, `vlog-${date}.mp4`).uri;
}

export function getTempDir(): string {
  return new Directory(Paths.document, 'buffr', 'temp').uri;
}

export async function cleanTemp(): Promise<void> {
  const tempDir = new Directory(Paths.document, 'buffr', 'temp');
  if (tempDir.exists) {
    await tempDir.delete();
    await tempDir.create();
  }
}
