import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, Pressable, Image, PanResponder, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue, useAnimatedRef,
  runOnJS, scrollTo,
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

const PX_PER_SEC = 60;
const MIN_CLIP_WIDTH = 40;
const TRACK_HEIGHT = 64;

type Props = {
  clips: ClipItem[];
  selectedClipId: string | null;
  playheadPos: number;
  isPlaying: boolean;
  onSelectClip: (id: string | null) => void;
  onTrimClip: (id: string, side: 'left' | 'right', deltaPct: number) => void;
  onMoveClip: (id: string, dir: number) => void;
  onDeleteClip: (id: string) => void;
  onSplitClip: (id: string) => void;
  onPlayheadDrag: (pos: number) => void;
};

// Multi-frame thumbnails spread across the full clip duration
function useFrameThumbs(clipUri: string | undefined, durationMs: number, count: number) {
  const [thumbs, setThumbs] = useState<string[]>([]);

  useEffect(() => {
    if (!clipUri || count <= 0) { setThumbs([]); return; }
    let cancelled = false;
    (async () => {
      const results: string[] = [];
      const dur = Math.max(1000, durationMs);
      for (let i = 0; i < count; i++) {
        if (cancelled) return;
        try {
          const timeMs = Math.max(100, Math.round(((i + 0.5) / count) * dur));
          const { uri } = await VideoThumbnails.getThumbnailAsync(clipUri, { time: timeMs, quality: 0.3 });
          results.push(uri);
        } catch { /* skip */ }
      }
      if (!cancelled) setThumbs(results);
    })();
    return () => { cancelled = true; };
  }, [clipUri, durationMs, count]);

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
  const clipWidth = Math.max(MIN_CLIP_WIDTH, Math.round(effectiveSec * pxPerSec));
  const thumbCount = Math.max(2, Math.min(10, Math.round(clipWidth / 35)));
  const thumbs = useFrameThumbs(clip.clipUri, clip.durationMs, thumbCount);
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

function PlayheadMarker({ playheadPos, totalDurationSec, pxPerSec, onDrag }: {
  playheadPos: number;
  totalDurationSec: number;
  pxPerSec: number;
  onDrag: (pos: number) => void;
}) {
  const totalPx = totalDurationSec * pxPerSec;
  const pos = Math.round(playheadPos * totalPx);
  const grabPos = useRef(0);
  const dragging = useRef(false);
  const onDragRef = useRef(onDrag);
  const totalPxRef = useRef(totalPx);
  const playheadRef = useRef(playheadPos);
  onDragRef.current = onDrag;
  totalPxRef.current = totalPx;
  if (!dragging.current) playheadRef.current = playheadPos;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        dragging.current = true;
        grabPos.current = playheadRef.current;
      },
      onPanResponderMove: (_, gs) => {
        if (totalPxRef.current <= 0) return;
        const delta = gs.dx / totalPxRef.current;
        const newPos = Math.max(0, Math.min(1, grabPos.current + delta));
        onDragRef.current(newPos);
      },
      onPanResponderRelease: () => { dragging.current = false; },
      onPanResponderTerminate: () => { dragging.current = false; },
    })
  ).current;

  return (
    <View
      {...panResponder.panHandlers}
      style={[styles.playhead, { left: pos }]}
    >
      <View style={styles.playheadHead} />
      <View style={styles.playheadLine} />
      <View style={styles.playheadHitArea} />
    </View>
  );
}

export function ClipTimeline({ clips, selectedClipId, playheadPos, isPlaying, onSelectClip, onTrimClip, onMoveClip, onDeleteClip, onSplitClip, onPlayheadDrag }: Props) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [zoom, setZoom] = useState(0.2);

  const zoomSV = useSharedValue(0.2);
  const pinchBaseZoom = useSharedValue(1);
  const pinchFocalX = useSharedValue(0);
  const pinchStartScroll = useSharedValue(0);
  const scrollOffset = useSharedValue(0);
  const scrollRef = useAnimatedRef<Animated.ScrollView>();

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
  const selectedClip = clips.find(c => c.id === selectedClipId);

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
        <Text style={styles.sectionLabel}>TIMELINE</Text>
        <Text style={styles.durationLabel}>{formatDuration(totalDurationSec)} · {Math.round(zoom * 100)}%</Text>
      </View>

      <GestureDetector gesture={allGestures}>
        <Animated.ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={true}
          style={styles.trackScroll}
          contentContainerStyle={styles.trackContent}
          onLayout={e => { if (!trackWidth) setTrackWidth(e.nativeEvent.layout.width); }}
          onScroll={(e: any) => { scrollOffset.value = e.nativeEvent.contentOffset.x; }}
          scrollEventThrottle={16}
        >
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
          {/* Playhead — draggable */}
          {totalDurationSec > 0 && (
            <PlayheadMarker
              playheadPos={playheadPos}
              totalDurationSec={totalDurationSec}
              pxPerSec={scaledPxPerSec}
              onDrag={onPlayheadDrag}
            />
          )}
        </Animated.ScrollView>
      </GestureDetector>

      {/* Selected clip actions */}
      {selectedClip && (
        <View style={styles.actions}>
          <Pressable onPress={() => onMoveClip(selectedClip.id, -1)} style={styles.actionBtn}>
            <Icon name="arrowLeft" size={14} color={colors.textMuted} />
          </Pressable>
          <Pressable onPress={() => onMoveClip(selectedClip.id, 1)} style={styles.actionBtn}>
            <Icon name="arrowRight" size={14} color={colors.textMuted} />
          </Pressable>
          <Pressable onPress={() => onSplitClip(selectedClip.id)} style={styles.actionBtn}>
            <Icon name="scissors" size={14} color={colors.amber} />
          </Pressable>
          <Text style={[styles.trimInfo, { color: selectedClip.color }]}>
            {formatDuration(getEffective(selectedClip))}
          </Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={() => onDeleteClip(selectedClip.id)} style={styles.deleteBtn}>
            <Icon name="trash" size={14} color={colors.coral} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 1,
  },
  durationLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textMuted,
  },
  trackScroll: {
    marginHorizontal: 16,
  },
  trackContent: {
    flexDirection: 'row',
    height: TRACK_HEIGHT,
    gap: 2,
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
  playhead: {
    position: 'absolute',
    top: -8,
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
