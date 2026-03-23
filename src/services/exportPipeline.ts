import { FFmpegKit, ReturnCode, FFmpegKitConfig } from '@wokcito/ffmpeg-kit-react-native';
import { File as FSFile } from 'expo-file-system';
import { getExportPath, getTempDir, cleanTemp, ensureDirectories, uriToPath } from './fileManager';
import type { ClipItem, TextOverlay, FilterOverlay, ExportProgress } from '../types/project';

function writeFileList(path: string, files: string[]): void {
  const content = files.map(f => `file '${f}'`).join('\n');
  const file = new FSFile(`file://${path}`);
  file.write(content);
}

function getEffectiveSec(clip: ClipItem): number {
  return (clip.durationMs / 1000) * (clip.trimEndPct - clip.trimStartPct) / 100;
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")
    .replace(/:/g, '\\:')
    .replace(/%/g, '%%');
}

async function runCommand(cmd: string, label: string): Promise<void> {
  console.log(`[loopd] FFmpeg ${label}:`, cmd);
  const session = await FFmpegKit.execute(cmd);
  const returnCode = await session.getReturnCode();
  if (!ReturnCode.isSuccess(returnCode)) {
    const output = await session.getOutput();
    const logs = await session.getAllLogs();
    const lastLogs = logs.slice(-5).map(l => l.getMessage()).join('\n');
    throw new Error(`${label}: ${lastLogs || output?.slice(-300) || 'Unknown error'}`);
  }
}

export async function runExport(
  date: string,
  clips: ClipItem[],
  textOverlays: TextOverlay[],
  filterOverlays: FilterOverlay[],
  onProgress: (progress: ExportProgress) => void,
): Promise<string> {
  const outputPath = getExportPath(date);
  await ensureDirectories(date);
  await cleanTemp();

  const validClips = clips.filter(c => c.clipUri && c.clipUri.length > 0);
  if (validClips.length === 0) {
    throw new Error('No video clips with files to export');
  }

  const tempDir = uriToPath(getTempDir());
  const totalDurationSec = validClips.reduce((sum, c) => sum + getEffectiveSec(c), 0);
  const totalDurationMs = Math.round(totalDurationSec * 1000);
  const totalSteps = validClips.length + 2; // trim each + concat + final
  let currentStep = 0;

  const reportProgress = (stage: string, stepOffset = 0) => {
    const pct = Math.min(95, Math.round(((currentStep + stepOffset) / totalSteps) * 100));
    const s = pct < 20 ? 'preparing' : pct < 85 ? 'encoding' : 'finalizing';
    onProgress({ stage: s as 'preparing' | 'encoding' | 'finalizing', progress: pct, currentTimeMs: 0, totalDurationMs });
  };

  // Step 1: Trim and scale each clip
  onProgress({ stage: 'preparing', progress: 0, currentTimeMs: 0, totalDurationMs });
  const trimmedFiles: string[] = [];

  for (let i = 0; i < validClips.length; i++) {
    const clip = validClips[i];
    const startSec = (clip.durationMs / 1000) * clip.trimStartPct / 100;
    const endSec = (clip.durationMs / 1000) * clip.trimEndPct / 100;
    const outFile = `${tempDir}/trimmed-${i}.mp4`;
    const inputPath = uriToPath(clip.clipUri);

    await runCommand(
      `-y -i ${inputPath} -ss ${startSec.toFixed(3)} -to ${endSec.toFixed(3)} ` +
      `-vf scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p ` +
      `-c:v libx264 -preset fast -crf 23 -profile:v baseline -level 3.1 ` +
      `-c:a aac -b:a 128k -ar 44100 -ac 2 ` +
      outFile,
      `Trim clip ${i + 1}`
    );

    trimmedFiles.push(outFile);
    currentStep++;
    reportProgress('trimming');
  }

  // Step 2: Concatenate
  reportProgress('concatenating');
  const concatFile = `${tempDir}/concat.mp4`;

  if (trimmedFiles.length === 1) {
    await runCommand(`-y -i ${trimmedFiles[0]} -c copy ${concatFile}`, 'Copy single clip');
  } else {
    // Write file list for concat demuxer
    const listPath = `${tempDir}/filelist.txt`;
    await writeFileList(listPath, trimmedFiles);

    // Concat demuxer — no re-encoding needed since all clips are normalized
    await runCommand(
      `-y -f concat -safe 0 -i ${listPath} -c copy ${concatFile}`,
      'Concatenate'
    );
  }
  currentStep++;
  reportProgress('encoding');

  // Step 3: Apply color adjustments
  // Note: text overlays (drawtext) require freetype which isn't in the min FFmpeg build.
  // Text overlays are visible in the preview but not burned into the final export.
  let currentInput = concatFile;
  const finalOutput = uriToPath(outputPath);

  const hasFilters = filterOverlays.length > 0;

  if (hasFilters) {
    const vfParts: string[] = [];

    for (const fo of filterOverlays) {
      const startSec = (totalDurationSec * fo.startPct / 100).toFixed(3);
      const endSec = (totalDurationSec * fo.endPct / 100).toFixed(3);
      const brightness = ((fo.brightness - 100) / 100).toFixed(2);
      const contrast = (fo.contrast / 100).toFixed(2);
      const saturation = (fo.saturate / 100).toFixed(2);
      vfParts.push(
        `eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}:enable='between(t\\,${startSec}\\,${endSec})'`
      );
    }

    const vfString = vfParts.join(',');

    await runCommand(
      `-y -i ${currentInput} -vf "${vfString}" ` +
      `-c:v libx264 -preset fast -crf 23 -c:a copy -movflags +faststart ` +
      finalOutput,
      'Apply filters and text'
    );
  } else {
    // No filters — just copy with faststart
    await runCommand(
      `-y -i ${currentInput} -c copy -movflags +faststart ${finalOutput}`,
      'Finalize'
    );
  }

  currentStep++;
  onProgress({ stage: 'done', progress: 100, currentTimeMs: totalDurationMs, totalDurationMs });

  // Clean up temp files
  try { await cleanTemp(); } catch { /* ignore */ }

  return outputPath;
}
