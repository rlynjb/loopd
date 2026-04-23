import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, Pressable, Image, PanResponder, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue, useAnimatedRef, useFrameCallback,
  useAnimatedScrollHandler, useAnimatedReaction,
  runOnJS, scrollTo,
  type SharedValue,
} from 'react-native-reanimated';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as Haptics from 'expo-haptics';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { formatDuration } from '../../utils/time';
import type { ClipItem } from '../../types/project';

function getEffective(c: ClipItem): number {
  return (c.durationMs / 1000) * (c.trimEndPct - c.trimStartPct) / 100;
}

const THUMB_COUNT = 6;
const thumbnailCache = new Map<string, string[]>();

const PX_PER_SEC = 60;
// A minimum rendered width would desync visual clip widths from the playhead's
// proportional position (which is based on totalDurationSec * pxPerSec). Keep
// clips purely proportional so the playhead lines up with clip boundaries.
const MIN_CLIP_WIDTH = 0;
const TRACK_HEIGHT = 64;

type Props = {
  clips: ClipItem[];
  selectedClipId: string | null;
  playheadPos: number;
  playheadPosAnim: SharedValue<number>;
  playheadRefPos: SharedValue<number>;
  playheadRefTimeMs: SharedValue<number>;
  isPlayingSV: SharedValue<boolean>;
  totalDurationMsSV: SharedValue<number>;
  canExtrapolateSV: SharedValue<boolean>;
  isPlaying: boolean;
  onSelectClip: (id: string | null) => void;
  onTrimClip: (id: string, side: 'left' | 'right', deltaPct: number) => void;
  onMoveClip: (id: string, dir: number) => void;
  onDeleteClip: (id: string) => void;
  onSplitClip: (id: string) => void;
  onPlayheadDrag: (pos: number) => void;
};

// Multi-frame thumbnails spread across the full clip duration
function useFrameThumbs(clipUri: string | undefined, durationMs: number) {
  const [thumbs, setThumbs] = useState<string[]>([]);

  useEffect(() => {
    if (!clipUri) { setThumbs([]); return; }
    const cacheKey = `${clipUri}|${THUMB_COUNT}`;
    const cached = thumbnailCache.get(cacheKey);
    if (cached) {
      setThumbs(cached);
      return;
    }

    let cancelled = false;
    (async () => {
      const results: string[] = [];
      const dur = Math.max(1000, durationMs);
      for (let i = 0; i < THUMB_COUNT; i++) {
        if (cancelled) return;
        try {
          const timeMs = Math.max(100, Math.round(((i + 0.5) / THUMB_COUNT) * dur));
          const { uri } = await VideoThumbnails.getThumbnailAsync(clipUri, { time: timeMs, quality: 0.3 });
          results.push(uri);
        } catch { /* skip */ }
      }
      if (!cancelled) {
        thumbnailCache.set(cacheKey, results);
        setThumbs(results);
      }
    })();
    return () => { cancelled = true; };
  }, [clipUri, durationMs]);

  return thumbs;
}

function ClipBlock({ clip, isSelected, onSelect, onTrim, onSplit, trackWidth, pxPerSec }: {
  clip: ClipItem;
  isSelected: boolean;
  onSelect: () => void;
  onTrim: (side: 'left' | 'right', deltaPct: number) => void;
  onSplit: () => void;
  trackWidth: number;
  pxPerSec: number;
}) {
  const effectiveSec = getEffective(clip);
  // Don't round or clamp — the playhead is positioned on a totalDurationSec * pxPerSec
  // coordinate space, so any drift here desyncs visuals from the playhead.
  const clipWidth = Math.max(MIN_CLIP_WIDTH, effectiveSec * pxPerSec);
  const thumbs = useFrameThumbs(clip.clipUri, clip.durationMs);
  const lastTrimBoundary = useRef(0);

  const handleTrimWithHaptic = useCallback((side: 'left' | 'right', deltaPct: number) => {
    onTrim(side, deltaPct);
    const now = Date.now();
    if (now - lastTrimBoundary.current > 80) {
      lastTrimBoundary.current = now;
      Haptics.selectionAsync();
    }
  }, [onTrim]);

  const doubleTap = useMemo(() =>
    Gesture.Tap()
      .numberOfTaps(2)
      .onEnd(() => { runOnJS(onSplit)(); }),
  [onSplit]);

  const content = (
    <Pressable
      onPress={onSelect}
      style={[
        styles.clipBlock,
        { width: clipWidth },
        isSelected && { borderColor: clip.color, borderWidth: 2 },
      ]}
    >
      {/* Frame thumbnails */}
      <View style={styles.thumbStrip}>
        {thumbs.length > 0 ? thumbs.map((uri, i) => (
          <Image key={i} source={{ uri }} style={styles.thumb} resizeMode="cover" />
        )) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: `${clip.color}18` }]} />
        )}
      </View>

      {/* Darkened overlay */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: isSelected ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.3)' }]} />

      {/* Color accent bar */}
      <View style={[styles.accentBar, { backgroundColor: clip.color }]} />

      {/* Duration badge */}
      {clipWidth > 45 && (
        <View style={styles.badgeWrap}>
          <Text style={[styles.badgeText, { color: isSelected ? '#fff' : `${clip.color}cc` }]}>
            {formatDuration(effectiveSec)}
          </Text>
        </View>
      )}

      {/* Trim handles on selected. Each pixel of drag = 100/clipWidth % of trimmed range */}
      {isSelected && (() => {
        const trimRangePct = clip.trimEndPct - clip.trimStartPct;
        // 1 pixel of drag = how many clip-duration %
        const pctPerPx = clipWidth > 0 ? trimRangePct / clipWidth : 0;
        return (
          <>
            <TrimPill side="left" color={clip.color} onTrim={handleTrimWithHaptic} pctPerPx={pctPerPx} />
            <TrimPill side="right" color={clip.color} onTrim={handleTrimWithHaptic} pctPerPx={pctPerPx} />
          </>
        );
      })()}
    </Pressable>
  );

  // Double-tap only on selected
  if (isSelected) {
    return (
      <GestureDetector gesture={doubleTap}>
        <Animated.View>{content}</Animated.View>
      </GestureDetector>
    );
  }

  return content;
}

function TrimPill({ side, color, onTrim, pctPerPx }: {
  side: 'left' | 'right';
  color: string;
  onTrim: (side: 'left' | 'right', deltaPct: number) => void;
  pctPerPx: number;
}) {
  const lastDx = useRef(0);
  const onTrimRef = useRef(onTrim);
  const ratioRef = useRef(pctPerPx);
  onTrimRef.current = onTrim;
  ratioRef.current = pctPerPx;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => { lastDx.current = 0; },
      onPanResponderMove: (_, gs) => {
        if (ratioRef.current <= 0) return;
        const inc = gs.dx - lastDx.current;
        lastDx.current = gs.dx;
        const deltaPct = inc * ratioRef.current;
        onTrimRef.current(side, deltaPct);
      },
    })
  ).current;

  return (
    <View
      {...panResponder.panHandlers}
      style={[styles.trimHit, side === 'left' ? styles.trimHitLeft : styles.trimHitRight]}
    >
      <View style={[styles.trimPill, { backgroundColor: color }]}>
        <View style={styles.trimGrip} />
        <View style={styles.trimGrip} />
        <View style={styles.trimGrip} />
      </View>
    </View>
  );
}

function TimeRuler({ totalDurationSec, pxPerSec }: { totalDurationSec: number; pxPerSec: number }) {
  if (totalDurationSec <= 0) return null;
  // Aim for ~50px between labels regardless of zoom
  const rawIntervalSec = 50 / pxPerSec;
  // Snap to a "nice" interval: 0.5, 1, 2, 5, 10, 15, 30, 60
  const niceSteps = [0.5, 1, 2, 5, 10, 15, 30, 60];
  const labelIntervalSec = niceSteps.find(s => s >= rawIntervalSec) ?? 60;
  const totalPx = totalDurationSec * pxPerSec;
  const numLabels = Math.floor(totalDurationSec / labelIntervalSec) + 1;

  return (
    <View style={[styles.ruler, { width: totalPx }]}>
      {Array.from({ length: numLabels }, (_, i) => {
        const t = i * labelIntervalSec;
        const left = t * pxPerSec;
        return (
          <View key={i} style={[styles.rulerTick, { left }]}>
            <View style={styles.rulerTickLine} />
            <Text style={styles.rulerTickLabel}>{formatDuration(t)}</Text>
          </View>
        );
      })}
    </View>
  );
}

// Runs the UI-thread playhead extrapolation. No visual output — the playhead itself
// is a fixed-center overlay and the timeline scrolls under it.
function usePlayheadExtrapolator({
  playheadPosAnim,
  playheadRefPos,
  playheadRefTimeMs,
  isPlayingSV,
  totalDurationMsSV,
  canExtrapolateSV,
}: {
  playheadPosAnim: SharedValue<number>;
  playheadRefPos: SharedValue<number>;
  playheadRefTimeMs: SharedValue<number>;
  isPlayingSV: SharedValue<boolean>;
  totalDurationMsSV: SharedValue<number>;
  canExtrapolateSV: SharedValue<boolean>;
}) {
  useFrameCallback((frameInfo) => {
    'worklet';
    if (!isPlayingSV || !canExtrapolateSV || !totalDurationMsSV || !playheadRefTimeMs || !playheadRefPos || !playheadPosAnim) return;
    if (!isPlayingSV.value || !canExtrapolateSV.value || totalDurationMsSV.value <= 0) return;
    if (playheadRefTimeMs.value <= 0) return;
    const elapsed = frameInfo.timestamp - playheadRefTimeMs.value;
    if (elapsed < 0) return;
    const capped = elapsed > 80 ? 80 : elapsed;
    const extrapolated = playheadRefPos.value + capped / totalDurationMsSV.value;
    playheadPosAnim.value = extrapolated > 1 ? 1 : extrapolated;
  });
}

export function ClipTimeline({ clips, selectedClipId, playheadPos, playheadPosAnim, playheadRefPos, playheadRefTimeMs, isPlayingSV, totalDurationMsSV, canExtrapolateSV, isPlaying, onSelectClip, onTrimClip, onMoveClip, onDeleteClip, onSplitClip, onPlayheadDrag }: Props) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [zoom, setZoom] = useState(0.75);

  const zoomSV = useSharedValue(0.2);
  const pinchBaseZoom = useSharedValue(1);
  const pinchFocalX = useSharedValue(0);
  const pinchStartScroll = useSharedValue(0);
  const scrollOffset = useSharedValue(0);
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const totalPxSV = useSharedValue(0);
  const userScrollingSV = useSharedValue(false);
  const lastScrollMsSV = useSharedValue(0);
  const lastPlayheadMsSV = useSharedValue(0);


  usePlayheadExtrapolator({
    playheadPosAnim,
    playheadRefPos,
    playheadRefTimeMs,
    isPlayingSV,
    totalDurationMsSV,
    canExtrapolateSV,
  });

  const updateZoomJS = useCallback((z: number) => {
    setZoom(+(z.toFixed(2)));
  }, []);

  const pinchGesture = useMemo(() =>
    Gesture.Pinch()
      .onStart((e) => {
        'worklet';
        pinchBaseZoom.value = zoomSV.value;
        pinchFocalX.value = e.focalX;
        pinchStartScroll.value = scrollOffset.value;
      })
      .onUpdate((e) => {
        'worklet';
        const oldZoom = pinchBaseZoom.value;
        const newZoom = Math.max(0.1, Math.min(6, oldZoom * e.scale));
        zoomSV.value = newZoom;
        const contentX = pinchStartScroll.value + pinchFocalX.value;
        const newContentX = contentX * (newZoom / oldZoom);
        const newScrollX = Math.max(0, newContentX - pinchFocalX.value);
        scrollTo(scrollRef, newScrollX, 0, false);
        runOnJS(updateZoomJS)(newZoom);
      }),
  []);

  const nativeGesture = useMemo(() => Gesture.Native(), []);
  const composed = useMemo(() => Gesture.Simultaneous(pinchGesture, nativeGesture), [pinchGesture, nativeGesture]);

  const totalDurationSec = useMemo(
    () => clips.reduce((sum, c) => sum + getEffective(c), 0),
    [clips]
  );

  const scaledPxPerSec = PX_PER_SEC * zoom;

  useEffect(() => {
    totalPxSV.value = totalDurationSec * scaledPxPerSec;
  }, [totalDurationSec, scaledPxPerSec, totalPxSV]);

  // Reset stuck scrolling flag when playback resumes — guarantees pressing play
  // unblocks auto-scroll even if a drag event was dropped.
  useEffect(() => {
    if (isPlaying) userScrollingSV.value = false;
  }, [isPlaying, userScrollingSV]);

  const scrollHandler = useAnimatedScrollHandler({
    onBeginDrag: () => {
      'worklet';
      userScrollingSV.value = true;
      lastScrollMsSV.value = performance.now();
    },
    onScroll: (e) => {
      'worklet';
      scrollOffset.value = e.contentOffset.x;
      lastScrollMsSV.value = performance.now();

      // Fallback drag detection: onBeginDrag occasionally misses on Android. If
      // we're playing and the scroll offset has diverged from where auto-scroll
      // would place it, the user must be dragging — engage scrubbing mode.
      if (isPlayingSV.value && !userScrollingSV.value && totalPxSV.value > 0) {
        const expected = playheadPosAnim.value * totalPxSV.value;
        if (Math.abs(e.contentOffset.x - expected) > 5) {
          userScrollingSV.value = true;
        }
      }

      if (userScrollingSV.value && totalPxSV.value > 0) {
        const pos = Math.max(0, Math.min(1, e.contentOffset.x / totalPxSV.value));
        playheadPosAnim.value = pos;
        runOnJS(onPlayheadDrag)(pos);
      }
    },
    onEndDrag: () => {
      'worklet';
      userScrollingSV.value = false;
    },
    onMomentumBegin: () => {
      'worklet';
      userScrollingSV.value = true;
    },
    onMomentumEnd: () => {
      'worklet';
      userScrollingSV.value = false;
    },
  }, [onPlayheadDrag]);

  // Playhead → scroll during playback. Safety: if userScrollingSV gets stuck true
  // (dropped onEndDrag on Android) but no scroll events have fired for a while,
  // force-clear it so auto-scroll can resume.
  useAnimatedReaction(
    () => ({ pos: playheadPosAnim.value, total: totalPxSV.value, user: userScrollingSV.value, playing: isPlayingSV.value }),
    ({ pos, total, user, playing }) => {
      'worklet';
      lastPlayheadMsSV.value = performance.now();
      if (user && performance.now() - lastScrollMsSV.value > 300) {
        userScrollingSV.value = false;
      }
      if (userScrollingSV.value || !playing || total <= 0) return;
      scrollTo(scrollRef, pos * total, 0, false);
    },
  );

  // Hang recovery: if playback is on but playheadPosAnim hasn't changed for a while,
  // the handler pipeline is stuck. Force-reset the gates so the next progress event
  // is accepted and playback resumes.
  useFrameCallback(() => {
    'worklet';
    if (!isPlayingSV.value) return;
    if (performance.now() - lastPlayheadMsSV.value < 800) return;
    userScrollingSV.value = false;
    playheadRefTimeMs.value = performance.now();
    canExtrapolateSV.value = true;
    lastPlayheadMsSV.value = performance.now();
  });

  // Swipe between clips
  const selectedIdx = clips.findIndex(c => c.id === selectedClipId);
  const swipeLeft = useMemo(() =>
    Gesture.Fling()
      .direction(1)
      .onEnd(() => {
        if (selectedIdx >= 0 && selectedIdx < clips.length - 1) {
          runOnJS(onSelectClip)(clips[selectedIdx + 1].id);
        }
      }),
  [selectedIdx, clips, onSelectClip]);

  const swipeRight = useMemo(() =>
    Gesture.Fling()
      .direction(2)
      .onEnd(() => {
        if (selectedIdx > 0) {
          runOnJS(onSelectClip)(clips[selectedIdx - 1].id);
        }
      }),
  [selectedIdx, clips, onSelectClip]);

  const allGestures = useMemo(() =>
    selectedClipId
      ? Gesture.Simultaneous(composed, Gesture.Exclusive(swipeLeft, swipeRight))
      : composed,
  [selectedClipId, composed, swipeLeft, swipeRight]);

  if (clips.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.durationLabel}>{formatDuration(totalDurationSec)} · {Math.round(zoom * 100)}%</Text>
      </View>

      <View
        style={styles.viewport}
        onLayout={e => {
          const w = e.nativeEvent.layout.width;
          if (w !== viewportWidth) setViewportWidth(w);
          if (!trackWidth) setTrackWidth(w);
        }}
      >
        <GestureDetector gesture={allGestures}>
          <Animated.ScrollView
            ref={scrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.trackScroll}
            contentContainerStyle={[styles.trackContent, { paddingLeft: viewportWidth / 2, paddingRight: viewportWidth / 2 }]}
            onScroll={scrollHandler}
            scrollEventThrottle={16}
            decelerationRate="fast"
          >
            <TimeRuler totalDurationSec={totalDurationSec} pxPerSec={scaledPxPerSec} />
            <View style={styles.trackRow}>
              {clips.map(clip => (
                <ClipBlock
                  key={clip.id}
                  clip={clip}
                  isSelected={clip.id === selectedClipId}
                  onSelect={() => onSelectClip(clip.id)}
                  onTrim={(side, delta) => onTrimClip(clip.id, side, delta)}
                  onSplit={() => onSplitClip(clip.id)}
                  trackWidth={trackWidth}
                  pxPerSec={scaledPxPerSec}
                />
              ))}
            </View>
          </Animated.ScrollView>
        </GestureDetector>

        {/* Fixed centered playhead — the timeline scrolls underneath it */}
        {totalDurationSec > 0 && viewportWidth > 0 && (
          <View pointerEvents="none" style={[styles.centerPlayhead, { left: viewportWidth / 2 - 1 }]}>
            <View style={styles.centerPlayheadHead} />
            <View style={styles.centerPlayheadLine} />
          </View>
        )}
      </View>

      {/* Per-clip edit actions moved to the CLIP tab in the editor screen. */}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  durationLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textMuted,
  },
  viewport: {
    position: 'relative',
  },
  centerPlayhead: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    alignItems: 'center',
    zIndex: 50,
  },
  centerPlayheadHead: {
    width: 12,
    height: 8,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    backgroundColor: '#fff',
    marginLeft: -5,
  },
  centerPlayheadLine: {
    flex: 1,
    width: 2,
    backgroundColor: '#fff',
  },
  trackScroll: {},
  trackContent: {
    // No gap: the playhead is positioned on totalDurationSec * pxPerSec, so any
    // spacing between clips would desync visual boundaries from playhead position.
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  trackRow: {
    flexDirection: 'row',
    height: TRACK_HEIGHT,
    alignItems: 'center',
  },
  clipBlock: {
    height: '100%',
    borderRadius: 4,
    overflow: 'visible',
    position: 'relative',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  thumbStrip: {
    flex: 1,
    flexDirection: 'row',
    borderRadius: 4,
    overflow: 'hidden',
  },
  thumb: {
    flex: 1,
    height: '100%',
  },
  accentBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: 3,
    borderTopLeftRadius: 4,
    borderBottomLeftRadius: 4,
  },
  badgeWrap: {
    position: 'absolute',
    bottom: 4,
    left: 8,
  },
  badgeText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  actionBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: 'rgba(251,113,133,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(251,113,133,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trimInfo: {
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  trimHit: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    width: 30,
    zIndex: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  trimHitLeft: {
    left: -8,
  },
  trimHitRight: {
    right: -8,
  },
  trimPill: {
    width: 16,
    height: '55%',
    maxHeight: 44,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 2,
  },
  trimGrip: {
    width: 7,
    height: 1.5,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 1,
  },
  ruler: {
    height: 20,
    position: 'relative',
    marginBottom: 2,
  },
  rulerTick: {
    position: 'absolute',
    top: 0,
    alignItems: 'flex-start',
  },
  rulerTickLine: {
    width: 1,
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  rulerTickLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: 'rgba(255,255,255,0.45)',
    marginTop: 2,
    marginLeft: -8,
  },
  playhead: {
    position: 'absolute',
    top: 0,
    bottom: -8,
    width: 36,
    marginLeft: -18,
    zIndex: 50,
    alignItems: 'center',
  },
  playheadHead: {
    width: 12,
    height: 8,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    backgroundColor: '#fff',
  },
  playheadLine: {
    flex: 1,
    width: 2,
    backgroundColor: '#fff',
  },
  playheadHitArea: {
    ...StyleSheet.absoluteFillObject,
  },
});
