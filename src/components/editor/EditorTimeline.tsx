import { useRef, useState, useCallback, useMemo } from 'react';
import { View, Text, Pressable, PanResponder, StyleSheet, LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, useAnimatedRef, runOnJS, withTiming, scrollTo } from 'react-native-reanimated';
import { colors, fonts } from '../../constants/theme';
import { FILTERS } from '../../constants/filters';
import { CATEGORIES } from '../../constants/categories';
import { Icon, type IconName } from '../../components/ui/Icon';
import type { ClipItem, TextOverlay, FilterOverlay } from '../../types/project';
import { formatDuration } from '../../utils/time';

type Props = {
  clips: ClipItem[];
  textOverlays: TextOverlay[];
  filterOverlays: FilterOverlay[];
  selectedClipId: string | null;
  selectedTextId: string | null;
  selectedFilterId: string | null;
  playheadPos: number;
  totalDurationSec: number;
  onSelectClip: (id: string) => void;
  onSelectText: (id: string) => void;
  onSelectFilter: (id: string) => void;
  onAddClip: () => void;
  onAddText: () => void;
  onAddFilter: () => void;
  onTimelinePress: (pct: number) => void;
  onPlayheadDrag: (pos: number) => void;
  onTrimClip: (id: string, side: 'left' | 'right', deltaPct: number) => void;
  onTrimText: (id: string, side: 'left' | 'right', deltaPct: number) => void;
  onTrimFilter: (id: string, side: 'left' | 'right', deltaPct: number) => void;
  onMoveText: (id: string, deltaPct: number) => void;
  onMoveFilter: (id: string, deltaPct: number) => void;
  onZoomChange?: (zoom: number) => void;
};

function getEffectiveDuration(clip: ClipItem): number {
  return (clip.durationMs / 1000) * (clip.trimEndPct - clip.trimStartPct) / 100;
}

function getWaveform(clipId: string, bars: number): number[] {
  const seed = clipId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return Array.from({ length: bars }).map((_, i) => {
    const v = Math.sin(i * 0.7 + seed * 0.1) * 0.4 + Math.cos(i * 1.3 + seed * 0.3) * 0.3 + 0.5;
    return Math.max(0.15, Math.min(1, v));
  });
}

function DragBlock({ children, itemId, onSelect, onMove, trackWidth, style }: {
  children: React.ReactNode;
  itemId: string;
  onSelect: () => void;
  onMove: (id: string, deltaPct: number) => void;
  trackWidth: number;
  style: unknown;
}) {
  const didDrag = useRef(false);
  const lastDx = useRef(0);
  const onMoveRef = useRef(onMove);
  const onSelectRef = useRef(onSelect);
  const trackWidthRef = useRef(trackWidth);
  onMoveRef.current = onMove;
  onSelectRef.current = onSelect;
  trackWidthRef.current = trackWidth;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 5,
      onPanResponderTerminationRequest: () => true,
      onPanResponderGrant: () => {
        didDrag.current = false;
        lastDx.current = 0;
      },
      onPanResponderMove: (_, gs) => {
        if (Math.abs(gs.dx) > 5 && trackWidthRef.current > 0) {
          didDrag.current = true;
          const incrementalDx = gs.dx - lastDx.current;
          lastDx.current = gs.dx;
          const deltaPct = (incrementalDx / trackWidthRef.current) * 100;
          onMoveRef.current(itemId, deltaPct);
        }
      },
      onPanResponderRelease: () => {
        if (!didDrag.current) {
          onSelectRef.current();
        }
      },
    })
  ).current;

  return (
    <View {...panResponder.panHandlers} style={style as object}>
      {children}
    </View>
  );
}

function TrimHandle({ side, color, itemId, onTrim, trackWidth, trimActiveRef }: {
  side: 'left' | 'right';
  color: string;
  itemId: string;
  onTrim: (id: string, side: 'left' | 'right', deltaPct: number) => void;
  trackWidth: number;
  trimActiveRef?: React.MutableRefObject<boolean>;
}) {
  const lastDx = useRef(0);
  const onTrimRef = useRef(onTrim);
  const trackWidthRef = useRef(trackWidth);
  onTrimRef.current = onTrim;
  trackWidthRef.current = trackWidth;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        lastDx.current = 0;
        if (trimActiveRef) trimActiveRef.current = true;
      },
      onPanResponderMove: (_, gs) => {
        if (trackWidthRef.current <= 0) return;
        const incrementalDx = gs.dx - lastDx.current;
        lastDx.current = gs.dx;
        const deltaPct = (incrementalDx / trackWidthRef.current) * 100;
        onTrimRef.current(itemId, side, deltaPct);
      },
      onPanResponderRelease: () => {
        if (trimActiveRef) trimActiveRef.current = false;
      },
      onPanResponderTerminate: () => {
        if (trimActiveRef) trimActiveRef.current = false;
      },
    })
  ).current;

  return (
    <View
      {...panResponder.panHandlers}
      style={[
        styles.trimHitArea,
        side === 'left' ? styles.trimHitLeft : styles.trimHitRight,
      ]}
    >
      <View style={[
        styles.trimHandle,
        side === 'left' ? styles.trimHandleLeft : styles.trimHandleRight,
        { backgroundColor: color },
      ]}>
        <View style={styles.trimHandleGrip}>
          <View style={styles.trimHandleLine} />
          <View style={styles.trimHandleLine} />
        </View>
      </View>
    </View>
  );
}

export function EditorTimeline({
  clips, textOverlays, filterOverlays,
  selectedClipId, selectedTextId, selectedFilterId,
  playheadPos, totalDurationSec,
  onSelectClip, onSelectText, onSelectFilter,
  onAddClip, onAddText, onAddFilter, onTimelinePress, onPlayheadDrag, onTrimClip, onTrimText, onTrimFilter, onMoveText, onMoveFilter, onZoomChange,
}: Props) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const trackLayoutRef = useRef({ x: 0, width: 0 });
  const playheadStartRef = useRef(0);
  const playheadPosRef = useRef(playheadPos);
  playheadPosRef.current = playheadPos;
  const trimActive = useRef(false);

  // Reanimated shared values for UI-thread zoom
  const zoomSV = useSharedValue(1);
  const pinchBaseZoom = useSharedValue(1);
  const scrollOffsetSV = useSharedValue(0);
  const pinchFocalXSV = useSharedValue(0);
  const pinchStartScrollSV = useSharedValue(0);
  const animatedScrollRef = useAnimatedRef<Animated.ScrollView>();
  const trackWidthSV = useSharedValue(0);

  const updateZoomJS = useCallback((z: number) => {
    const rounded = +(z.toFixed(1));
    setZoom(rounded);
    onZoomChange?.(rounded);
  }, [onZoomChange]);

  // Pinch gesture — runs entirely on UI thread
  const pinchGesture = useMemo(() =>
    Gesture.Pinch()
      .onStart((e) => {
        'worklet';
        pinchBaseZoom.value = zoomSV.value;
        pinchFocalXSV.value = e.focalX;
        pinchStartScrollSV.value = scrollOffsetSV.value;
      })
      .onUpdate((e) => {
        'worklet';
        const oldZoom = pinchBaseZoom.value;
        const newZoom = Math.max(0.5, Math.min(10, oldZoom * e.scale));
        zoomSV.value = newZoom;

        // Keep focal point stationary — all on UI thread
        if (trackWidthSV.value > 0) {
          const contentX = pinchStartScrollSV.value + pinchFocalXSV.value;
          const newContentX = contentX * (newZoom / oldZoom);
          const newScrollX = Math.max(0, newContentX - pinchFocalXSV.value);
          scrollTo(animatedScrollRef, newScrollX, 0, false);
        }

        runOnJS(updateZoomJS)(newZoom);
      })
      .onEnd(() => {
        'worklet';
      }),
  []);

  // Animated style for the timeline content width
  const animatedContentStyle = useAnimatedStyle(() => ({
    width: trackWidth > 0 ? trackWidth * zoomSV.value : '100%' as any,
  }));


  const handleContainerLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width - 32; // minus padding
    if (trackWidth === 0) {
      setTrackWidth(w);
      trackWidthSV.value = w;
    }
    trackLayoutRef.current.width = w;
  };

  const handleTrackLayout = (e: LayoutChangeEvent) => {
    e.target.measureInWindow((x: number) => {
      trackLayoutRef.current.x = x;
    });
  };

  // Draggable playhead
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const playheadPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        playheadStartRef.current = playheadPosRef.current;
      },
      onPanResponderMove: (_, gs) => {
        if (trackLayoutRef.current.width <= 0) return;
        const delta = gs.dx / (trackLayoutRef.current.width * zoomRef.current);
        const newPos = Math.max(0, Math.min(1, playheadStartRef.current + delta));
        onPlayheadDrag(newPos);
      },
    })
  ).current;

  const handleRulerPress = (e: { nativeEvent: { locationX: number } }) => {
    if (trackWidth <= 0) return;
    const pct = Math.max(0, Math.min(1, e.nativeEvent.locationX / trackWidth));
    onPlayheadDrag(pct);
  };

  // Timecode markers
  const timeMarkers: { pos: number; label: string }[] = [];
  if (totalDurationSec > 0) {
    const pxPerSec = (trackWidth * zoom) / totalDurationSec;
    const minPx = 20;
    const steps = [1, 2, 5, 10, 15, 30, 60];
    let step = steps.find(s => s * pxPerSec >= minPx) ?? 60;

    for (let t = 0; t <= totalDurationSec; t += step) {
      const label = step < 1
        ? `${t.toFixed(1)}s`
        : formatDuration(Math.round(t));
      timeMarkers.push({ pos: t / totalDurationSec, label });
    }
  }


  const clipWaveforms = useMemo(() => {
    const totalEffective = clips.reduce((sum, c) => sum + getEffectiveDuration(c), 0);
    return clips.map(clip => {
      const fullDurationSec = clip.durationMs / 1000;
      const effectiveSec = getEffectiveDuration(clip);
      const w = totalEffective > 0 ? (effectiveSec / totalEffective) * 100 : 0;
      const fullW = totalEffective > 0 ? (fullDurationSec / totalEffective) * 100 : 0;
      const leftTrimPct = clip.trimStartPct;
      const rightTrimPct = 100 - clip.trimEndPct;
      const barCount = Math.max(6, Math.round(w * 0.8));
      return { clip, w, fullW, leftTrimPct, rightTrimPct, waveform: getWaveform(clip.id, barCount) };
    });
  }, [clips, totalDurationSec]);

  // Combined gesture: pinch + native scroll
  const nativeGesture = useMemo(() => Gesture.Native(), []);
  const composed = useMemo(() => Gesture.Simultaneous(pinchGesture, nativeGesture), [pinchGesture, nativeGesture]);

  return (
    <View
      style={styles.container}
      onLayout={handleContainerLayout}
    >
      <GestureDetector gesture={composed}>
      <Animated.ScrollView
        ref={animatedScrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.zoomScroll}
        onScroll={(e: any) => {
          scrollOffsetSV.value = e.nativeEvent.contentOffset.x;
        }}
        scrollEventThrottle={16}
      >
      <View style={{ flexDirection: 'row' }}>
      <Animated.View style={[animatedContentStyle, { flex: 0 }]}>
      {/* Timecode ruler — tap to seek */}
      <Pressable onPress={handleRulerPress} style={styles.ruler}>
        {timeMarkers.map((m, i) => (
          <View key={i} style={[styles.markerWrap, { left: `${m.pos * 100}%` }]}>
            <Text style={styles.markerText}>{m.label}</Text>
            <View style={styles.markerTick} />
          </View>
        ))}
        {totalDurationSec > 0 && (
          <View style={[styles.rulerPlayhead, { left: `${playheadPos * 100}%` }]} />
        )}
      </Pressable>

      {/* Text track */}
      <View style={styles.textTrack}>
        {textOverlays.map(t => {
          const isActive = t.id === selectedTextId;
          return (
            <DragBlock
              key={t.id}
              itemId={t.id}
              onSelect={() => onSelectText(t.id)}
              onMove={onMoveText}
              trackWidth={trackWidth * zoom}
              style={[
                styles.textBlock,
                {
                  left: `${t.startPct}%`,
                  width: `${t.endPct - t.startPct}%`,
                  backgroundColor: isActive ? 'rgba(251,191,36,0.15)' : 'rgba(251,191,36,0.06)',
                  borderColor: isActive ? colors.amber : 'rgba(251,191,36,0.2)',
                },
              ]}
            >
              <View style={styles.textBlockRow}>
                <Text style={[styles.textBlockPrefix, { color: isActive ? colors.amber : 'rgba(251,191,36,0.5)' }]}>T</Text>
                <Text style={[styles.textBlockLabel, { color: isActive ? colors.amber : 'rgba(251,191,36,0.7)' }]} numberOfLines={1}>
                  {t.text || 'Text'}
                </Text>
              </View>
              {isActive && (
                <>
                  <TrimHandle side="left" color={colors.amber} itemId={t.id} onTrim={onTrimText} trackWidth={trackWidth * zoom} trimActiveRef={trimActive} />
                  <TrimHandle side="right" color={colors.amber} itemId={t.id} onTrim={onTrimText} trackWidth={trackWidth * zoom} trimActiveRef={trimActive} />
                </>
              )}
            </DragBlock>
          );
        })}
        {totalDurationSec > 0 && <View style={[styles.playheadLine, { left: `${playheadPos * 100}%` }]} />}
      </View>

      {/* Filter track */}
      <View style={styles.filterTrack}>
        {filterOverlays.map(f => {
          const isActive = f.id === selectedFilterId;
          const filterPreset = FILTERS.find(p => p.id === f.filterId);
          const filterColor = filterPreset?.color ?? colors.purple;
          const filterLabel = filterPreset?.label ?? 'Filter';
          return (
            <DragBlock
              key={f.id}
              itemId={f.id}
              onSelect={() => onSelectFilter(f.id)}
              onMove={onMoveFilter}
              trackWidth={trackWidth * zoom}
              style={[
                styles.filterBlock,
                {
                  left: `${f.startPct}%`,
                  width: `${f.endPct - f.startPct}%`,
                  backgroundColor: isActive ? `${filterColor}25` : `${filterColor}10`,
                  borderColor: isActive ? filterColor : `${filterColor}40`,
                },
              ]}
            >
              <View style={styles.filterBlockRow}>
                <View style={[styles.filterSwatch, { backgroundColor: filterColor }]} />
                <Text style={[styles.filterBlockLabel, { color: isActive ? filterColor : `${filterColor}cc` }]} numberOfLines={1}>
                  {filterLabel}
                </Text>
              </View>
              {isActive && (
                <>
                  <TrimHandle side="left" color={filterColor} itemId={f.id} onTrim={onTrimFilter} trackWidth={trackWidth * zoom} trimActiveRef={trimActive} />
                  <TrimHandle side="right" color={filterColor} itemId={f.id} onTrim={onTrimFilter} trackWidth={trackWidth * zoom} trimActiveRef={trimActive} />
                </>
              )}
            </DragBlock>
          );
        })}
        {totalDurationSec > 0 && <View style={[styles.playheadLine, { left: `${playheadPos * 100}%` }]} />}
      </View>

      {/* Clip track */}
      <View
        onLayout={handleTrackLayout}
        style={styles.clipTrack}
      >
        {clipWaveforms.map(({ clip, w, fullW, leftTrimPct, rightTrimPct, waveform }) => {
          const isActive = clip.id === selectedClipId;
          const captionLower = clip.caption.toLowerCase();
          const cat = CATEGORIES.find(c => captionLower.includes(c.label.toLowerCase()));
          const clipIcon: IconName = cat?.icon ?? 'video';
          const isTrimmed = leftTrimPct > 0 || rightTrimPct > 0;

          return (
            <Pressable
              key={clip.id}
              onPress={() => onSelectClip(clip.id)}
              style={[
                styles.clipBlock,
                { width: `${w}%` },
              ]}
            >
              {/* Gradient background */}
              <View style={[styles.clipBg, { backgroundColor: `${clip.color}${isActive ? '30' : '18'}` }]} />
              <View style={[styles.clipBgGradient, { backgroundColor: `${clip.color}${isActive ? '15' : '08'}` }]} />

              {/* Icon + caption at top */}
              {w > 6 && (
                <View style={styles.clipLabelRow}>
                  <Icon name={clipIcon} size={12} color={isActive ? `${clip.color}ee` : `${clip.color}88`} />
                  {w > 12 && (
                    <Text style={[styles.clipLabelText, { color: isActive ? colors.text : `${clip.color}cc` }]} numberOfLines={1}>
                      {clip.caption.slice(0, 25)}
                    </Text>
                  )}
                </View>
              )}

              {/* Waveform */}
              <View style={styles.waveformContainer}>
                {waveform.map((h, j) => (
                  <View
                    key={j}
                    style={[
                      styles.waveBar,
                      {
                        height: `${h * 100}%`,
                        backgroundColor: isActive ? `${clip.color}60` : `${clip.color}25`,
                      },
                    ]}
                  />
                ))}
              </View>

              {/* Duration badge — bottom left */}
              <View style={[styles.clipDurationBadge, { backgroundColor: `${clip.color}${isActive ? 'cc' : '66'}` }]}>
                <Text style={styles.clipDurationText}>
                  {formatDuration(getEffectiveDuration(clip))}/{formatDuration(clip.durationMs / 1000)}
                </Text>
              </View>

              {/* Left color bar */}
              <View style={[styles.clipColorBar, { backgroundColor: clip.color, opacity: isActive ? 0.8 : 0.4 }]} />

              {isActive && <View style={[styles.clipSelectionBorder, { borderColor: clip.color }]} />}

              {isActive && (
                <>
                  <TrimHandle side="left" color={clip.color} itemId={clip.id} onTrim={onTrimClip} trackWidth={trackWidth * zoom} trimActiveRef={trimActive} />
                  <TrimHandle side="right" color={clip.color} itemId={clip.id} onTrim={onTrimClip} trackWidth={trackWidth * zoom} trimActiveRef={trimActive} />
                </>
              )}
            </Pressable>
          );
        })}

        {totalDurationSec > 0 && (
          <View
            {...playheadPanResponder.panHandlers}
            style={[styles.playhead, { left: `${playheadPos * 100}%` }]}
          >
            <View style={styles.playheadTop} />
            <View style={styles.playheadHitArea} />
          </View>
        )}
      </View>
      </Animated.View>
      {/* Add buttons — column at end of timeline, aligned to tracks */}
      <View style={styles.addBtnColumn}>
        <View style={{ height: 20 }} />
        <Pressable onPress={onAddText} style={[styles.addTrackBtn, { height: 40, marginBottom: 3 }]}>
          <Text style={styles.addTrackBtnText}>+</Text>
        </Pressable>
        <Pressable onPress={onAddFilter} style={[styles.addTrackBtn, { height: 40, marginBottom: 6, backgroundColor: 'rgba(167,139,250,0.06)' }]}>
          <Text style={[styles.addTrackBtnText, { color: 'rgba(167,139,250,0.5)' }]}>+</Text>
        </Pressable>
        <Pressable onPress={onAddClip} style={[styles.addTrackBtn, { height: 64, backgroundColor: 'rgba(255,255,255,0.03)' }]}>
          <Text style={[styles.addTrackBtnText, { color: colors.textDim }]}>+</Text>
        </Pressable>
      </View>
      </View>
      </Animated.ScrollView>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  zoomScroll: {
    flex: 0,
  },
  ruler: {
    height: 18,
    marginBottom: 2,
    marginRight: 0,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    position: 'relative',
  },
  markerWrap: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    alignItems: 'center',
    transform: [{ translateX: -12 }],
  },
  markerText: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: '#ffffff',
  },
  markerTick: {
    width: 1,
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  textTrack: {
    height: 40,
    marginBottom: 3,
    marginRight: 0,
    backgroundColor: 'rgba(255,255,255,0.01)',
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: 'rgba(255,255,255,0.04)',
    position: 'relative',
    overflow: 'visible',
  },
  trackLabel: {
    position: 'absolute',
    left: 4,
    top: 3,
    zIndex: 2,
    fontFamily: fonts.mono,
    fontSize: 7,
    color: colors.textDim,
    letterSpacing: 0.8,
    opacity: 0.6,
  },
  textBlock: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    borderWidth: 1.5,
    borderRadius: 0,
    paddingHorizontal: 8,
    justifyContent: 'center',
    overflow: 'visible',
  },
  textBlockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  textBlockPrefix: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: '700',
  },
  textBlockLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    flex: 1,
  },
  filterTrack: {
    height: 40,
    marginBottom: 6,
    marginRight: 0,
    backgroundColor: 'rgba(255,255,255,0.01)',
    borderWidth: 1,
    borderTopWidth: 0,
    borderBottomWidth: 0,
    borderColor: 'rgba(255,255,255,0.04)',
    position: 'relative',
    overflow: 'visible',
  },
  filterBlock: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    borderWidth: 1.5,
    borderRadius: 0,
    paddingHorizontal: 8,
    justifyContent: 'center',
    overflow: 'visible',
  },
  filterBlockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  filterSwatch: {
    width: 10,
    height: 10,
    borderRadius: 2,
  },
  filterBlockLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
  },
  addBtnColumn: {
    width: 28,
    marginLeft: 4,
  },
  addTrackBtn: {
    width: 28,
    backgroundColor: 'rgba(251,191,36,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addTrackBtnText: {
    color: 'rgba(251,191,36,0.5)',
    fontSize: 18,
  },
  clipTrack: {
    height: 64,
    marginRight: 0,
    backgroundColor: 'rgba(255,255,255,0.015)',
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: 'rgba(255,255,255,0.06)',
    flexDirection: 'row',
    overflow: 'visible',
    position: 'relative',
  },
  clipBlock: {
    height: '100%',
    position: 'relative',
    overflow: 'visible',
  },
  clipBg: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  clipBgGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: '50%',
  },
  clipColorBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: 3,
    borderTopLeftRadius: 2,
    borderBottomLeftRadius: 2,
  },
  waveformContainer: {
    position: 'absolute',
    bottom: 22,
    left: 6,
    right: 4,
    top: 24,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
  },
  waveBar: {
    flex: 1,
    borderRadius: 0.5,
  },
  clipLabelRow: {
    position: 'absolute',
    top: 6,
    left: 8,
    right: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  clipLabelText: {
    fontFamily: fonts.mono,
    fontSize: 8,
    letterSpacing: 0.2,
    flex: 1,
  },
  clipDurationBadge: {
    position: 'absolute',
    bottom: 4,
    left: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  clipDurationText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: '700',
    color: '#fff',
  },
  clipSelectionBorder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 2,
    borderRadius: 3,
  },
  trimHitArea: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    width: 28,
    zIndex: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  trimHitLeft: {
    left: -10,
  },
  trimHitRight: {
    right: -10,
  },
  trimHandle: {
    width: 8,
    height: '60%',
    maxHeight: 28,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 2,
  },
  trimHandleLeft: {
    borderTopLeftRadius: 4,
    borderBottomLeftRadius: 4,
  },
  trimHandleRight: {
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
  },
  trimHandleGrip: {
    gap: 2,
    alignItems: 'center',
  },
  trimHandleLine: {
    width: 3,
    height: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 0.5,
  },
  addClipBtn: {
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  addClipBtnText: {
    color: colors.textDim,
    fontSize: 16,
  },
  playheadLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.25)',
    zIndex: 1,
  },
  playhead: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: '#ffffff',
    zIndex: 10,
  },
  playheadTop: {
    position: 'absolute',
    top: -6,
    left: -6,
    width: 14,
    height: 8,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    backgroundColor: '#ffffff',
  },
  playheadHitArea: {
    position: 'absolute',
    top: -10,
    bottom: 0,
    left: -16,
    right: -16,
    zIndex: 20,
  },
  rulerPlayhead: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1.5,
    backgroundColor: 'rgba(255,255,255,0.4)',
  },
});
