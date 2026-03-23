import { useCallback, useState } from 'react';
import { FFmpegKit } from '@wokcito/ffmpeg-kit-react-native';
import { runExport } from '../services/exportPipeline';
import type { ClipItem, TextOverlay, FilterOverlay, ExportProgress } from '../types/project';

export function useExport() {
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const startExport = useCallback(async (
    date: string,
    clips: ClipItem[],
    textOverlays: TextOverlay[],
    filterOverlays: FilterOverlay[],
  ): Promise<string | null> => {
    setIsExporting(true);
    setProgress({ stage: 'preparing', progress: 0, currentTimeMs: 0, totalDurationMs: 0 });
    try {
      const uri = await runExport(date, clips, textOverlays, filterOverlays, setProgress);
      return uri;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[loopd] Export failed:', msg);
      setProgress({ stage: 'error', progress: 0, currentTimeMs: 0, totalDurationMs: 0, error: msg });
      return null;
    } finally {
      setIsExporting(false);
    }
  }, []);

  const cancelExport = useCallback(() => {
    FFmpegKit.cancel();
    setIsExporting(false);
    setProgress(null);
  }, []);

  return { progress, isExporting, startExport, cancelExport };
}
