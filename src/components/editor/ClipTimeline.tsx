import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, Pressable, Image, PanResponder, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, useAnimatedRef, runOnJS, scrollTo } from 'react-native-reanimated';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { formatDuration } from '../../utils/time';
import type { ClipItem } from '../../types/project';

function getEffective(c: ClipItem): number {
  return (c.durationMs / 1000) * (c.trimEndPct - c.trimStartPct) / 100;
}

type Props = {
  clips: ClipItem[];
  selectedClipId: string | null;
  onSelectClip: (id: string) => void;
  onTrimClip: (id: string, side: 'left' | 'right', deltaPct: number) => void;
  onMoveClip: (id: string, dir: number) => void;
  onDeleteClip: (id: string) => void;
};

function useThumb(clipUri: string | undefined) {
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    if (!clipUri) { setThumb(null); return; }
    let cancelled = false;
    VideoThumbnails.getThumbnailAsync(clipUri, { time: 500, quality: 0.4 })
      .then(r => { if (!cancelled) setThumb(r.uri); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [clipUri]);

  return thumb;
}

const PX_PER_SEC = 60;
const MIN_CLIP_WIDTH = 40;

function ClipBlock({ clip, isSelected, onSelect, onTrim, trackWidth, pxPerSec }: {
  clip: ClipItem;
  isSelected: boolean;
  onSelect: () => void;
  onTrim: (side: 'left' | 'right', deltaPct: number) => void;
  trackWidth: number;
  pxPerSec: number;
}) {
  const thumb = useThumb(clip.clipUri);
  const effectiveSec = getEffective(clip);
  const clipWidth = Math.max(MIN_CLIP_WIDTH, Math.round(effectiveSec * pxPerSec));

  return (
    <Pressable
      onPress={onSelect}
      style={[
        styles.clipBlock,
        { width: clipWidth },
        isSelected && { borderColor: clip.color, borderWidth: 2 },
      ]}
    >
      {/* Thumbnail background */}
      {thumb ? (
        <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: `${clip.color}18` }]} />
      )}

      {/* Darkened overlay for readability */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: isSelected ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.35)' }]} />

      {/* Color accent bar */}
      <View style={[styles.accentBar, { backgroundColor: clip.color }]} />

      {/* Duration badge */}
      {clipWidth > 50 && (
        <View style={styles.badgeWrap}>
          <Text style={[styles.badgeText, { color: isSelected ? '#fff' : `${clip.color}cc` }]}>
            {formatDuration(effectiveSec)}
          </Text>
        </View>
      )}

      {/* Trim handles on selected */}
      {isSelected && (
        <>
          <TrimPill side="left" color={clip.color} onTrim={onTrim} trackWidth={trackWidth} />
          <TrimPill side="right" color={clip.color} onTrim={onTrim} trackWidth={trackWidth} />
        </>
      )}
    </Pressable>
  );
}

function TrimPill({ side, color, onTrim, trackWidth }: {
  side: 'left' | 'right';
  color: string;
  onTrim: (side: 'left' | 'right', deltaPct: number) => void;
  trackWidth: number;
}) {
  const lastDx = useRef(0);
  const onTrimRef = useRef(onTrim);
  const widthRef = useRef(trackWidth);
  onTrimRef.current = onTrim;
  widthRef.current = trackWidth;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => { lastDx.current = 0; },
      onPanResponderMove: (_, gs) => {
        if (widthRef.current <= 0) return;
        const inc = gs.dx - lastDx.current;
        lastDx.current = gs.dx;
        const deltaPct = (inc / widthRef.current) * 100;
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

export function ClipTimeline({ clips, selectedClipId, onSelectClip, onTrimClip, onMoveClip, onDeleteClip }: Props) {
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

        // Keep focal point stationary
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

  if (clips.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.sectionLabel}>TIMELINE</Text>
        <Text style={styles.durationLabel}>{formatDuration(totalDurationSec)} · {Math.round(zoom * 100)}%</Text>
      </View>

      {/* Horizontal NLE track with pinch-to-zoom */}
      <GestureDetector gesture={composed}>
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
              trackWidth={trackWidth}
              pxPerSec={scaledPxPerSec}
            />
          ))}
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
    height: 64,
    gap: 2,
  },
  clipBlock: {
    height: '100%',
    borderRadius: 4,
    overflow: 'visible',
    position: 'relative',
    borderWidth: 1,
    borderColor: 'transparent',
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
    width: 28,
    zIndex: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  trimHitLeft: {
    left: -6,
  },
  trimHitRight: {
    right: -6,
  },
  trimPill: {
    width: 14,
    height: '60%',
    maxHeight: 40,
    borderRadius: 7,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 2,
  },
  trimGrip: {
    width: 6,
    height: 1.5,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 1,
  },
});
