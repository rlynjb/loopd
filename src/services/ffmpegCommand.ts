import type { ClipItem, TextOverlay, FilterOverlay } from '../types/project';
import { uriToPath } from './fileManager';

export type FFmpegBuildResult = {
  command: string;
  totalDurationMs: number;
};

function getEffectiveDurationSec(clip: ClipItem): number {
  return (clip.durationMs / 1000) * (clip.trimEndPct - clip.trimStartPct) / 100;
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/'/g, "'\\\\\\''")
    .replace(/:/g, '\\\\:')
    .replace(/\[/g, '\\\\[')
    .replace(/\]/g, '\\\\]')
    .replace(/%/g, '%%');
}

function hexToFFmpegColor(hex: string): string {
  // FFmpeg uses 0xRRGGBB format
  const clean = hex.replace('#', '');
  return `0x${clean}`;
}

export function buildExportCommand(
  clips: ClipItem[],
  textOverlays: TextOverlay[],
  filterOverlays: FilterOverlay[],
  outputPath: string,
): FFmpegBuildResult {
  const validClips = clips.filter(c => c.clipUri && c.clipUri.length > 0);
  if (validClips.length === 0) {
    throw new Error('No video clips to export');
  }

  // Calculate total duration
  const totalDurationSec = validClips.reduce((sum, c) => sum + getEffectiveDurationSec(c), 0);
  const totalDurationMs = Math.round(totalDurationSec * 1000);

  // Build inputs
  const inputs = validClips.map(c => `-i "${uriToPath(c.clipUri)}"`).join(' ');

  // Build filter complex
  const filterParts: string[] = [];
  const n = validClips.length;

  // Per-clip: trim, scale, pad to 1080x1920
  for (let i = 0; i < n; i++) {
    const clip = validClips[i];
    const startSec = (clip.durationMs / 1000) * clip.trimStartPct / 100;
    const endSec = (clip.durationMs / 1000) * clip.trimEndPct / 100;

    // Video: trim, reset timestamps, scale to 9:16
    filterParts.push(
      `[${i}:v]trim=${startSec.toFixed(3)}:${endSec.toFixed(3)},setpts=PTS-STARTPTS,` +
      `scale=1080:1920:force_original_aspect_ratio=decrease,` +
      `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,` +
      `setsar=1[v${i}]`
    );

    // Audio: trim, reset timestamps
    filterParts.push(
      `[${i}:a]atrim=${startSec.toFixed(3)}:${endSec.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
    );
  }

  // Concat
  let videoLabel: string;
  let audioLabel: string;

  if (n === 1) {
    videoLabel = 'v0';
    audioLabel = 'a0';
  } else {
    const concatInputs = Array.from({ length: n }, (_, i) => `[v${i}][a${i}]`).join('');
    filterParts.push(`${concatInputs}concat=n=${n}:v=1:a=1[vcat][acat]`);
    videoLabel = 'vcat';
    audioLabel = 'acat';
  }

  // Apply filter overlays (brightness/contrast/saturation with time ranges)
  let filterIdx = 0;
  for (const fo of filterOverlays) {
    const startSec = (totalDurationSec * fo.startPct / 100).toFixed(3);
    const endSec = (totalDurationSec * fo.endPct / 100).toFixed(3);
    // FFmpeg eq filter: brightness is -1 to 1 (0 = normal), contrast is 0+ (1 = normal), saturation is 0+ (1 = normal)
    const brightness = ((fo.brightness - 100) / 100).toFixed(2);
    const contrast = (fo.contrast / 100).toFixed(2);
    const saturation = (fo.saturate / 100).toFixed(2);
    const outLabel = `vf${filterIdx}`;
    filterParts.push(
      `[${videoLabel}]eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}:enable='between(t,${startSec},${endSec})'[${outLabel}]`
    );
    videoLabel = outLabel;
    filterIdx++;
  }

  // Apply text overlays using drawtext
  let textIdx = 0;
  for (const to of textOverlays) {
    const startSec = (totalDurationSec * to.startPct / 100).toFixed(3);
    const endSec = (totalDurationSec * to.endPct / 100).toFixed(3);
    const escapedText = escapeDrawtext(to.text);
    const color = hexToFFmpegColor(to.color);
    // Position text centered horizontally, near bottom (80% down)
    const outLabel = `vt${textIdx}`;
    filterParts.push(
      `[${videoLabel}]drawtext=text='${escapedText}':fontsize=${to.fontSize * 3}:fontcolor=${color}:` +
      `x=(w-text_w)/2:y=h*0.8-text_h:` +
      `enable='between(t,${startSec},${endSec})'[${outLabel}]`
    );
    videoLabel = outLabel;
    textIdx++;
  }

  // Build the full filter_complex string
  const filterComplex = filterParts.join(';');

  // Build the full command
  const command = [
    inputs,
    `-filter_complex "${filterComplex}"`,
    `-map "[${videoLabel}]"`,
    `-map "[${audioLabel}]"`,
    `-c:v libx264 -preset fast -crf 23`,
    `-c:a aac -b:a 128k`,
    `-movflags +faststart`,
    `-y "${uriToPath(outputPath)}"`,
  ].join(' ');

  return { command, totalDurationMs };
}

// Fallback: multi-pass export for when single filtergraph is too complex
export function buildMultiPassCommands(
  clips: ClipItem[],
  textOverlays: TextOverlay[],
  filterOverlays: FilterOverlay[],
  tempDir: string,
  outputPath: string,
): { commands: string[]; totalDurationMs: number } {
  const validClips = clips.filter(c => c.clipUri && c.clipUri.length > 0);
  if (validClips.length === 0) throw new Error('No video clips to export');

  const totalDurationSec = validClips.reduce((sum, c) => sum + getEffectiveDurationSec(c), 0);
  const totalDurationMs = Math.round(totalDurationSec * 1000);
  const commands: string[] = [];
  const tempPath = uriToPath(tempDir);

  // Pass 1: Trim and scale each clip
  const trimmedFiles: string[] = [];
  for (let i = 0; i < validClips.length; i++) {
    const clip = validClips[i];
    const startSec = (clip.durationMs / 1000) * clip.trimStartPct / 100;
    const endSec = (clip.durationMs / 1000) * clip.trimEndPct / 100;
    const outFile = `${tempPath}/trimmed-${i}.mp4`;
    trimmedFiles.push(outFile);

    commands.push(
      `-i "${uriToPath(clip.clipUri)}" ` +
      `-filter_complex "[0:v]trim=${startSec.toFixed(3)}:${endSec.toFixed(3)},setpts=PTS-STARTPTS,` +
      `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v];` +
      `[0:a]atrim=${startSec.toFixed(3)}:${endSec.toFixed(3)},asetpts=PTS-STARTPTS[a]" ` +
      `-map "[v]" -map "[a]" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -y "${outFile}"`
    );
  }

  // Pass 2: Concatenate
  const concatFile = `${tempPath}/concat.mp4`;
  if (trimmedFiles.length === 1) {
    // Just rename/copy
    commands.push(`-i "${trimmedFiles[0]}" -c copy -y "${concatFile}"`);
  } else {
    const concatInputs = trimmedFiles.map(f => `-i "${f}"`).join(' ');
    const concatFilter = Array.from({ length: trimmedFiles.length }, (_, i) => `[${i}:v][${i}:a]`).join('');
    commands.push(
      `${concatInputs} -filter_complex "${concatFilter}concat=n=${trimmedFiles.length}:v=1:a=1[v][a]" ` +
      `-map "[v]" -map "[a]" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -y "${concatFile}"`
    );
  }

  // Pass 3: Apply filters + text
  const filterParts: string[] = [];
  let videoLabel = '0:v';

  let idx = 0;
  for (const fo of filterOverlays) {
    const startSec = (totalDurationSec * fo.startPct / 100).toFixed(3);
    const endSec = (totalDurationSec * fo.endPct / 100).toFixed(3);
    const brightness = ((fo.brightness - 100) / 100).toFixed(2);
    const contrast = (fo.contrast / 100).toFixed(2);
    const saturation = (fo.saturate / 100).toFixed(2);
    const outLabel = `vf${idx}`;
    filterParts.push(
      `[${videoLabel}]eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}:enable='between(t,${startSec},${endSec})'[${outLabel}]`
    );
    videoLabel = outLabel;
    idx++;
  }

  for (const to of textOverlays) {
    const startSec = (totalDurationSec * to.startPct / 100).toFixed(3);
    const endSec = (totalDurationSec * to.endPct / 100).toFixed(3);
    const escapedText = escapeDrawtext(to.text);
    const color = hexToFFmpegColor(to.color);
    const outLabel = `vt${idx}`;
    filterParts.push(
      `[${videoLabel}]drawtext=text='${escapedText}':fontsize=${to.fontSize * 3}:fontcolor=${color}:` +
      `x=(w-text_w)/2:y=h*0.8-text_h:enable='between(t,${startSec},${endSec})'[${outLabel}]`
    );
    videoLabel = outLabel;
    idx++;
  }

  if (filterParts.length > 0) {
    commands.push(
      `-i "${concatFile}" -filter_complex "${filterParts.join(';')}" ` +
      `-map "[${videoLabel}]" -map "0:a" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k ` +
      `-movflags +faststart -y "${uriToPath(outputPath)}"`
    );
  } else {
    // No filters/text — just copy concat result
    commands.push(`-i "${concatFile}" -c copy -movflags +faststart -y "${uriToPath(outputPath)}"`);
  }

  return { commands, totalDurationMs };
}
