import { useCallback, useRef, useState } from 'react';
import { runExport } from '../services/exportPipeline';
import type { ClipItem, TextOverlay, FilterOverlay, ExportProgress } from '../types/project';
import type { RenderedText } from '../services/textRenderer';

export function useExport() {
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const cancelledRef = useRef(false);

  const startExport = useCallback(async (
    date: string,
    clips: ClipItem[],
    textOverlays: TextOverlay[],
    filterOverlays: FilterOverlay[],
    renderedTexts?: RenderedText[],
  ): Promise<string | null> => {
    cancelledRef.current = false;
    setIsExporting(true);
    setProgress({ stage: 'preparing', progress: 0, currentTimeMs: 0, totalDurationMs: 0 });
    try {
      const uri = await runExport(date, clips, textOverlays, filterOverlays, setProgress, renderedTexts);
      return uri;
    } catch (e) {
      if (cancelledRef.current) return null;
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[loopd] Export failed:', msg);
      setProgress({ stage: 'error', progress: 0, currentTimeMs: 0, totalDurationMs: 0, error: msg });
      return null;
    } finally {
      setIsExporting(false);
    }
  }, []);

  const cancelExport = useCallback(async () => {
    cancelledRef.current = true;
    const { FFmpegKit } = await import('@wokcito/ffmpeg-kit-react-native');
    FFmpegKit.cancel();
    setIsExporting(false);
    setProgress(null);
  }, []);

  return { progress, isExporting, startExport, cancelExport };
}
