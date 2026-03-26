import { useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, PanResponder, StyleSheet, LayoutChangeEvent } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { FILTERS } from '../../constants/filters';
import { Icon } from '../../components/ui/Icon';
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
};

function getEffectiveDuration(clip: ClipItem): number {
  return Math.round((clip.durationMs / 1000) * (clip.trimEndPct - clip.trimStartPct) / 100);
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

function TrimHandle({ side, color, itemId, onTrim, trackWidth }: {
  side: 'left' | 'right';
  color: string;
  itemId: string;
  onTrim: (id: string, side: 'left' | 'right', deltaPct: number) => void;
  trackWidth: number;
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
      },
      onPanResponderMove: (_, gs) => {
        if (trackWidthRef.current <= 0) return;
        const incrementalDx = gs.dx - lastDx.current;
        lastDx.current = gs.dx;
        const deltaPct = (incrementalDx / trackWidthRef.current) * 100;
        onTrimRef.current(itemId, side, deltaPct);
      },
    })
  ).current;

  return (
    <View
      {...panResponder.panHandlers}
      style={[
        styles.trimHandle,
        side === 'left' ? styles.trimHandleLeft : styles.trimHandleRight,
        { backgroundColor: color },
      ]}
    >
      <View style={styles.trimHandleGrip}>
        <View style={styles.trimHandleLine} />
        <View style={styles.trimHandleLine} />
      </View>
    </View>
  );
}

export function EditorTimeline({
  clips, textOverlays, filterOverlays,
  selectedClipId, selectedTextId, selectedFilterId,
  playheadPos, totalDurationSec,
  onSelectClip, onSelectText, onSelectFilter,
  onAddClip, onAddText, onAddFilter, onTimelinePress, onPlayheadDrag, onTrimClip, onTrimText, onTrimFilter, onMoveText, onMoveFilter,
}: Props) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const trackLayoutRef = useRef({ x: 0, width: 0 });
  const playheadStartRef = useRef(0);
  const playheadPosRef = useRef(playheadPos);
  playheadPosRef.current = playheadPos;
  const scrollRef = useRef<ScrollView>(null);
  const pinchStartDistance = useRef(0);
  const pinchStartZoom = useRef(1);

  const handleTouchStart = (e: { nativeEvent: { touches: { pageX: number; pageY: number }[] } }) => {
    if (e.nativeEvent.touches.length === 2) {
      const [t1, t2] = e.nativeEvent.touches;
      pinchStartDistance.current = Math.hypot(t2.pageX - t1.pageX, t2.pageY - t1.pageY);
      pinchStartZoom.current = zoom;
    }
  };

  const handleTouchMove = (e: { nativeEvent: { touches: { pageX: number; pageY: number }[] } }) => {
    if (e.nativeEvent.touches.length === 2 && pinchStartDistance.current > 10) {
      const [t1, t2] = e.nativeEvent.touches;
      const currentDistance = Math.hypot(t2.pageX - t1.pageX, t2.pageY - t1.pageY);
      // Ratio-based: spreading fingers 2x = doubles zoom
      const ratio = currentDistance / pinchStartDistance.current;
      // Dampen: square root makes it less aggressive
      const dampened = 1 + (ratio - 1) * 0.6;
      const newZoom = Math.max(0.5, Math.min(4, pinchStartZoom.current * dampened));
      setZoom(newZoom);
    }
  };

  const handleTouchEnd = () => {
    pinchStartDistance.current = 0;
  };

  const handleContainerLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width - 32; // minus container padding
    if (trackWidth === 0) setTrackWidth(w);
    trackLayoutRef.current.width = w;
  };

  const handleTrackLayout = (e: LayoutChangeEvent) => {
    e.target.measureInWindow((x: number) => {
      trackLayoutRef.current.x = x;
    });
  };

  // Draggable playhead
  const playheadPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        playheadStartRef.current = playheadPosRef.current;
      },
      onPanResponderMove: (_, gs) => {
        if (trackLayoutRef.current.width <= 0) return;
        const delta = gs.dx / trackLayoutRef.current.width;
        const newPos = Math.max(0, Math.min(1, playheadStartRef.current + delta));
        onPlayheadDrag(newPos);
      },
    })
  ).current;

  // Tap on ruler to seek
  const handleRulerPress = (e: { nativeEvent: { locationX: number } }) => {
    if (trackWidth <= 0) return;
    const pct = Math.max(0, Math.min(1, e.nativeEvent.locationX / trackWidth));
    onPlayheadDrag(pct);
  };

  // Timecode markers — more detail at higher zoom
  const timeMarkers: { pos: number; label: string }[] = [];
  if (totalDurationSec > 0) {
    const visibleDuration = totalDurationSec / zoom;
    let step: number;
    if (visibleDuration <= 5) step = 0.5;
    else if (visibleDuration <= 15) step = 1;
    else if (visibleDuration <= 30) step = 2;
    else if (visibleDuration <= 60) step = 5;
    else if (visibleDuration <= 120) step = 10;
    else step = 15;

    for (let t = 0; t <= totalDurationSec; t += step) {
      const label = step < 1
        ? `${t.toFixed(1)}s`
        : formatDuration(Math.round(t));
      timeMarkers.push({ pos: t / totalDurationSec, label });
    }
  }

  const zoomIn = () => setZoom(z => Math.min(4, z + 0.5));
  const zoomOut = () => setZoom(z => Math.max(0.5, z - 0.5));

  return (
    <View
      style={styles.container}
      onLayout={handleContainerLayout}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Zoom controls */}
      <View style={styles.zoomRow}>
        <Pressable onPress={zoomOut} style={styles.zoomBtn}>
          <Text style={styles.zoomBtnText}>−</Text>
        </Pressable>
        <Text style={styles.zoomLabel}>{Math.round(zoom * 100)}%</Text>
        <Pressable onPress={zoomIn} style={styles.zoomBtn}>
          <Text style={styles.zoomBtnText}>+</Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.zoomScroll}
      >
      <View style={{ width: trackWidth > 0 ? trackWidth * zoom : '100%' }}>
      {/* Timecode ruler — tap to seek */}
      <Pressable onPress={handleRulerPress} style={styles.ruler}>
        {timeMarkers.map((m, i) => (
          <View key={i} style={[styles.markerWrap, { left: `${m.pos * 100}%` }]}>
            <Text style={styles.markerText}>{m.label}</Text>
            <View style={styles.markerTick} />
          </View>
        ))}
        {/* Playhead marker on ruler */}
        {totalDurationSec > 0 && (
          <View style={[styles.rulerPlayhead, { left: `${playheadPos * 100}%` }]} />
        )}
      </Pressable>

      {/* Text track */}
      <View style={styles.textTrack}>
        <Text style={styles.trackLabel}>T</Text>
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
                  backgroundColor: isActive ? 'rgba(251,191,36,0.2)' : 'rgba(251,191,36,0.05)',
                  borderColor: isActive ? colors.amber : 'rgba(251,191,36,0.15)',
                },
              ]}
            >
              <Text style={[styles.textBlockLabel, { color: isActive ? colors.amber : 'rgba(251,191,36,0.7)' }]} numberOfLines={1}>
                {t.text}
              </Text>
              {isActive && (
                <>
                  <TrimHandle side="left" color={colors.amber} itemId={t.id} onTrim={onTrimText} trackWidth={trackWidth * zoom} />
                  <TrimHandle side="right" color={colors.amber} itemId={t.id} onTrim={onTrimText} trackWidth={trackWidth * zoom} />
                </>
              )}
            </DragBlock>
          );
        })}
        <Pressable onPress={onAddText} style={styles.addTrackBtn}>
          <Text style={styles.addTrackBtnText}>+</Text>
        </Pressable>
        {totalDurationSec > 0 && <View style={[styles.playheadLine, { left: `${playheadPos * 100}%` }]} />}
      </View>

      {/* Filter track */}
      <View style={styles.filterTrack}>
        <Text style={[styles.trackLabel, { fontSize: 6 }]}>FX</Text>
        {filterOverlays.map(f => {
          const isActive = f.id === selectedFilterId;
          return (
            <DragBlock
              key={f.id}
              itemId={f.id}
              onSelect={() => onSelectFilter(f.id)}
              onMove={onMoveFilter}
              trackWidth={trackWidth * zoom}
              style={[
                styles.filterBlock,
                isActive ? styles.filterBlockActive : styles.filterBlockInactive,
                {
                  left: `${f.startPct}%`,
                  width: `${f.endPct - f.startPct}%`,
                },
              ]}
            >
              <Text style={[styles.filterBlockLabel, { color: isActive ? colors.purple : `${colors.purple}90` }]} numberOfLines={1}>
                B/C/S
              </Text>
              {isActive && (
                <>
                  <TrimHandle side="left" color={colors.purple} itemId={f.id} onTrim={onTrimFilter} trackWidth={trackWidth * zoom} />
                  <TrimHandle side="right" color={colors.purple} itemId={f.id} onTrim={onTrimFilter} trackWidth={trackWidth * zoom} />
                </>
              )}
            </DragBlock>
          );
        })}
        <Pressable onPress={onAddFilter} style={[styles.addTrackBtn, { borderColor: 'rgba(167,139,250,0.2)', backgroundColor: 'rgba(167,139,250,0.06)' }]}>
          <Text style={[styles.addTrackBtnText, { color: 'rgba(167,139,250,0.5)' }]}>+</Text>
        </Pressable>
        {totalDurationSec > 0 && <View style={[styles.playheadLine, { left: `${playheadPos * 100}%` }]} />}
      </View>

      {/* Clip track */}
      <View
        onLayout={handleTrackLayout}
        style={styles.clipTrack}
      >
        {clips.map((clip, i) => {
          const w = totalDurationSec > 0 ? (getEffectiveDuration(clip) / totalDurationSec) * 100 : 0;
          const isActive = clip.id === selectedClipId;
          const barCount = Math.max(6, Math.round(w * 0.8));
          const waveform = getWaveform(clip.id, barCount);

          return (
            <Pressable
              key={clip.id}
              onPress={() => onSelectClip(clip.id)}
              style={[
                styles.clipBlock,
                {
                  width: `${w}%`,
                  backgroundColor: isActive ? `${clip.color}18` : `${clip.color}0a`,
                },
              ]}
            >
              <View style={[styles.clipColorBar, { backgroundColor: clip.color, opacity: isActive ? 1 : 0.5 }]} />
              <View style={styles.waveformContainer}>
                {waveform.map((h, j) => (
                  <View
                    key={j}
                    style={[
                      styles.waveBar,
                      {
                        height: `${h * 100}%`,
                        backgroundColor: isActive ? `${clip.color}80` : `${clip.color}30`,
                      },
                    ]}
                  />
                ))}
              </View>
              {w > 8 && (
                <View style={styles.clipLabelRow}>
                  <Icon name="video" size={10} color={isActive ? colors.text : colors.textMuted} />
                  {w > 15 && (
                    <Text style={[styles.clipLabelText, { color: isActive ? colors.text : colors.textMuted }]} numberOfLines={1}>
                      {clip.caption.slice(0, 20)}
                    </Text>
                  )}
                </View>
              )}
              {/* Duration — top left, always visible */}
              <Text style={[styles.clipDuration, { color: isActive ? '#fff' : colors.textMuted }]}>
                {formatDuration(getEffectiveDuration(clip))}
              </Text>
              {isActive && <View style={[styles.clipSelectionBorder, { borderColor: clip.color }]} />}

              {/* Trim handles — only on selected clip */}
              {isActive && (
                <>
                  <TrimHandle side="left" color={clip.color} itemId={clip.id} onTrim={onTrimClip} trackWidth={trackWidth} />
                  <TrimHandle side="right" color={clip.color} itemId={clip.id} onTrim={onTrimClip} trackWidth={trackWidth} />
                </>
              )}
            </Pressable>
          );
        })}

        {/* Add button */}
        <Pressable onPress={onAddClip} style={[styles.addClipBtn, { width: clips.length > 0 ? 32 : '100%' }]}>
          <Text style={styles.addClipBtnText}>+</Text>
        </Pressable>

        {/* Playhead — draggable */}
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
      </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  zoomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 6,
  },
  zoomBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomBtnText: {
    fontFamily: fonts.mono,
    fontSize: 16,
    color: colors.textMuted,
  },
  zoomLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    minWidth: 36,
    textAlign: 'center',
  },
  zoomScroll: {
    flex: 0,
  },
  ruler: {
    height: 18,
    marginBottom: 2,
    marginRight: 32,
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
    height: 32,
    marginBottom: 3,
    marginRight: 32,
    backgroundColor: 'rgba(255,255,255,0.01)',
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
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
    top: 3,
    bottom: 3,
    borderWidth: 1.5,
    borderRadius: 5,
    paddingHorizontal: 6,
    justifyContent: 'center',
    overflow: 'visible',
  },
  textBlockLabel: {
    fontFamily: fonts.mono,
    fontSize: 8,
  },
  filterTrack: {
    height: 32,
    marginBottom: 6,
    marginRight: 32,
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
    top: 3,
    bottom: 3,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'visible',
  },
  filterBlockActive: {
    backgroundColor: 'rgba(196,111,212,0.18)',
    borderColor: '#c46fd4',
    borderWidth: 1.5,
  },
  filterBlockInactive: {
    backgroundColor: 'rgba(196,111,212,0.04)',
    borderColor: 'rgba(196,111,212,0.12)',
    borderWidth: 1,
  },
  filterBlockLabel: {
    fontFamily: fonts.mono,
    fontSize: 7.5,
  },
  addTrackBtn: {
    position: 'absolute',
    right: -28,
    top: 2,
    bottom: 2,
    width: 24,
    borderRadius: 4,
    backgroundColor: 'rgba(251,191,36,0.06)',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(251,191,36,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addTrackBtnText: {
    color: 'rgba(251,191,36,0.5)',
    fontSize: 12,
  },
  clipTrack: {
    height: 40,
    marginRight: 32,
    backgroundColor: 'rgba(255,255,255,0.015)',
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
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
  clipColorBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
  },
  waveformContainer: {
    position: 'absolute',
    bottom: 4,
    left: 3,
    right: 3,
    top: 16,
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
    top: 5,
    left: 5,
    right: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  clipEmoji: {
    fontSize: 9,
  },
  clipLabelText: {
    fontFamily: fonts.mono,
    fontSize: 7.5,
    letterSpacing: 0.2,
  },
  clipDuration: {
    position: 'absolute',
    top: 5,
    left: 16,
    fontFamily: fonts.mono,
    fontSize: 7,
  },
  clipSelectionBorder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 2,
    borderRadius: 2,
  },
  // Trim handles
  trimHandle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 14,
    zIndex: 20,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 3,
  },
  trimHandleLeft: {
    left: -2,
    borderTopLeftRadius: 4,
    borderBottomLeftRadius: 4,
  },
  trimHandleRight: {
    right: -2,
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
