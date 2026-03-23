import { useRef, useState } from 'react';
import { View, Text, Pressable, PanResponder, StyleSheet, LayoutChangeEvent } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { FILTERS } from '../../constants/filters';
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

function TrimHandle({ side, color, itemId, onTrim, trackWidth }: {
  side: 'left' | 'right';
  color: string;
  itemId: string;
  onTrim: (id: string, side: 'left' | 'right', deltaPct: number) => void;
  trackWidth: number;
}) {
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_, gs) => {
        if (trackWidth <= 0) return;
        const deltaPct = (gs.dx / trackWidth) * 100;
        onTrim(itemId, side, deltaPct);
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
  onAddClip, onAddText, onAddFilter, onTimelinePress, onPlayheadDrag, onTrimClip, onTrimText, onTrimFilter,
}: Props) {
  const [trackWidth, setTrackWidth] = useState(0);
  const trackLayoutRef = useRef({ x: 0, width: 0 });
  const playheadStartRef = useRef(0);
  const playheadPosRef = useRef(playheadPos);
  playheadPosRef.current = playheadPos;

  const handleTrackLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setTrackWidth(w);
    trackLayoutRef.current.width = w;
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

  // Timecode markers
  const timeMarkers: { pos: number; label: string }[] = [];
  if (totalDurationSec > 0) {
    const step = totalDurationSec <= 30 ? 5 : totalDurationSec <= 60 ? 10 : 15;
    for (let t = 0; t <= totalDurationSec; t += step) {
      timeMarkers.push({ pos: t / totalDurationSec, label: formatDuration(t) });
    }
  }

  return (
    <View style={styles.container}>
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
            <Pressable
              key={t.id}
              onPress={() => onSelectText(t.id)}
              style={[
                styles.textBlock,
                {
                  left: `${t.startPct}%`,
                  width: `${t.endPct - t.startPct}%`,
                  backgroundColor: isActive ? 'rgba(251,191,36,0.2)' : 'rgba(251,191,36,0.08)',
                  borderColor: isActive ? colors.amber : 'rgba(251,191,36,0.25)',
                },
              ]}
            >
              <Text style={[styles.textBlockLabel, { color: isActive ? colors.amber : 'rgba(251,191,36,0.7)' }]} numberOfLines={1}>
                {t.text}
              </Text>
              {isActive && (
                <>
                  <TrimHandle side="left" color={colors.amber} itemId={t.id} onTrim={onTrimText} trackWidth={trackWidth} />
                  <TrimHandle side="right" color={colors.amber} itemId={t.id} onTrim={onTrimText} trackWidth={trackWidth} />
                </>
              )}
            </Pressable>
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
          const preset = FILTERS.find(x => x.id === f.filterId) ?? FILTERS[0];
          return (
            <Pressable
              key={f.id}
              onPress={() => onSelectFilter(f.id)}
              style={[
                styles.filterBlock,
                {
                  left: `${f.startPct}%`,
                  width: `${f.endPct - f.startPct}%`,
                  backgroundColor: isActive ? `${colors.purple}20` : `${colors.purple}0a`,
                  borderColor: isActive ? colors.purple : `${colors.purple}30`,
                },
              ]}
            >
              <Text style={[styles.filterBlockLabel, { color: isActive ? colors.purple : `${colors.purple}90` }]} numberOfLines={1}>
                B/C/S
              </Text>
              {isActive && (
                <>
                  <TrimHandle side="left" color={colors.purple} itemId={f.id} onTrim={onTrimFilter} trackWidth={trackWidth} />
                  <TrimHandle side="right" color={colors.purple} itemId={f.id} onTrim={onTrimFilter} trackWidth={trackWidth} />
                </>
              )}
            </Pressable>
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
                  <Text style={styles.clipEmoji}>🎥</Text>
                  {w > 15 && (
                    <Text style={[styles.clipLabelText, { color: isActive ? colors.text : colors.textMuted }]} numberOfLines={1}>
                      {clip.caption.slice(0, 20)}
                    </Text>
                  )}
                </View>
              )}
              {/* Duration label */}
              {w > 6 && (
                <Text style={[styles.clipDuration, { color: isActive ? clip.color : colors.textDimmer }]}>
                  {formatDuration(getEffectiveDuration(clip))}
                </Text>
              )}
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
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  ruler: {
    height: 18,
    marginBottom: 2,
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
    color: colors.textDim,
  },
  markerTick: {
    width: 1,
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  textTrack: {
    height: 28,
    marginBottom: 3,
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
    height: 24,
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
    borderWidth: 1.5,
    borderRadius: 4,
    paddingHorizontal: 6,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'visible',
  },
  filterBlockLabel: {
    fontFamily: fonts.mono,
    fontSize: 7.5,
  },
  addTrackBtn: {
    position: 'absolute',
    right: 4,
    top: 4,
    bottom: 4,
    width: 20,
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
    height: 72,
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
    bottom: 2,
    left: 0,
    right: 0,
    fontFamily: fonts.mono,
    fontSize: 7,
    textAlign: 'center',
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
    width: 1.5,
    backgroundColor: 'rgba(255,255,255,0.5)',
    zIndex: 10,
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
