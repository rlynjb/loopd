import { useRef, useState, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import ViewShot, { captureRef } from 'react-native-view-shot';
import type { TextOverlay } from '../types/project';
import { fonts } from '../constants/theme';

// Render at half resolution to avoid memory crashes, FFmpeg scales up during overlay
const W = 540;
const H = 960;

export type RenderedText = {
  path: string;
  startPct: number;
  endPct: number;
};

/**
 * Hook to render text overlays to PNG images before export.
 *
 * Returns:
 * - `renderAll(overlays)` — renders all overlays, returns image paths
 * - `Renderer` — component to mount in the editor (handles off-screen rendering)
 */
export function useTextRenderer() {
  const [current, setCurrent] = useState<TextOverlay | null>(null);
  const shotRef = useRef<View>(null);
  const resultRef = useRef<RenderedText[]>([]);
  const doneRef = useRef<(() => void) | null>(null);

  const captureOne = useCallback(async (overlay: TextOverlay): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      setCurrent(overlay);
      // Wait for render
      setTimeout(async () => {
        try {
          if (!shotRef.current) { resolve(null); return; }
          const uri = await captureRef(shotRef, {
            format: 'png',
            result: 'tmpfile',
          });
          resolve(uri.startsWith('file://') ? uri.replace('file://', '') : uri);
        } catch (err) {
          console.warn('[loopd] Text capture failed:', err);
          resolve(null);
        }
      }, 150);
    });
  }, []);

  const renderAll = useCallback(async (overlays: TextOverlay[]): Promise<RenderedText[]> => {
    const valid = overlays.filter(t => t.text.trim());
    const results: RenderedText[] = [];

    for (const to of valid) {
      const path = await captureOne(to);
      if (path) {
        results.push({ path, startPct: to.startPct, endPct: to.endPct });
      }
    }

    setCurrent(null);
    return results;
  }, [captureOne]);

  const Renderer = useCallback(() => {
    if (!current) return null;

    const fontSize = Math.round(current.fontSize * (W / 360));
    const align = current.textAlign ?? 'center';
    const pos = current.position ?? 'bottom';
    const bold = current.fontWeight >= 700;

    const justifyContent =
      pos === 'top' ? ('flex-start' as const)
      : pos === 'center' ? ('center' as const)
      : ('flex-end' as const);
    const paddingTop = pos === 'top' ? Math.round(H * 0.08) : 0;
    const paddingBottom = pos === 'bottom' ? Math.round(H * 0.15) : 0;

    return (
      <View style={styles.offscreen} pointerEvents="none">
        <View
          ref={shotRef}
          collapsable={false}
          style={[styles.canvas, { justifyContent, paddingTop, paddingBottom }]}
        >
          <Text
            style={[
              styles.text,
              {
                fontSize,
                color: current.color || '#ffffff',
                fontFamily: bold ? 'TikTokSansBold' : 'TikTokSans',
                textAlign: align,
              },
            ]}
          >
            {current.text}
          </Text>
        </View>
      </View>
    );
  }, [current]);

  return { renderAll, Renderer };
}

const styles = StyleSheet.create({
  offscreen: {
    position: 'absolute',
    left: -W - 10,
    top: 0,
    width: W,
    height: H,
    overflow: 'hidden',
  },
  canvas: {
    width: W,
    height: H,
    backgroundColor: 'transparent',
    paddingHorizontal: Math.round(W * 0.05),
  },
  text: {
    fontFamily: 'TikTokSans',
    letterSpacing: -0.3,
  },
});
