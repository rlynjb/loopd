import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { FILTERS } from '../../constants/filters';
import type { ClipItem, TextOverlay, FilterOverlay } from '../../types/project';
import { CATEGORIES } from '../../constants/categories';
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

export function EditorTimeline({
  clips, textOverlays, filterOverlays,
  selectedClipId, selectedTextId, selectedFilterId,
  playheadPos, totalDurationSec,
  onSelectClip, onSelectText, onSelectFilter,
  onAddClip, onAddText, onAddFilter, onTimelinePress,
}: Props) {
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
      {/* Timecode ruler */}
      <View style={styles.ruler}>
        {timeMarkers.map((m, i) => (
          <View key={i} style={[styles.markerWrap, { left: `${m.pos * 100}%` }]}>
            <Text style={styles.markerText}>{m.label}</Text>
            <View style={styles.markerTick} />
          </View>
        ))}
      </View>

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
                  backgroundColor: isActive ? `${preset.color}20` : `${preset.color}0a`,
                  borderColor: isActive ? preset.color : `${preset.color}30`,
                },
              ]}
            >
              <Text style={[styles.filterBlockLabel, { color: isActive ? preset.color : `${preset.color}90` }]} numberOfLines={1}>
                {preset.label}
              </Text>
            </Pressable>
          );
        })}
        <Pressable onPress={onAddFilter} style={[styles.addTrackBtn, { borderColor: 'rgba(167,139,250,0.2)', backgroundColor: 'rgba(167,139,250,0.06)' }]}>
          <Text style={[styles.addTrackBtnText, { color: 'rgba(167,139,250,0.5)' }]}>+</Text>
        </Pressable>
        {totalDurationSec > 0 && <View style={[styles.playheadLine, { left: `${playheadPos * 100}%` }]} />}
      </View>

      {/* Clip track */}
      <Pressable
        onPress={(e) => {
          const { locationX, target } = e.nativeEvent as unknown as { locationX: number; target: number };
          // We'll use a simpler approach - just use the nativeEvent
        }}
        style={styles.clipTrack}
      >
        {clips.map((clip, i) => {
          const w = totalDurationSec > 0 ? (getEffectiveDuration(clip) / totalDurationSec) * 100 : 0;
          const isActive = clip.id === selectedClipId;
          const cat = CATEGORIES.find(c => c.id === clip.caption);
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
              {isActive && <View style={[styles.clipSelectionBorder, { borderColor: clip.color }]} />}
            </Pressable>
          );
        })}
        <Pressable onPress={onAddClip} style={[styles.addClipBtn, { width: clips.length > 0 ? 32 : '100%' }]}>
          <Text style={styles.addClipBtnText}>+</Text>
        </Pressable>
        {totalDurationSec > 0 && (
          <View style={[styles.playhead, { left: `${playheadPos * 100}%` }]}>
            <View style={styles.playheadTop} />
          </View>
        )}
      </Pressable>
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
    overflow: 'hidden',
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
    overflow: 'hidden',
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
    height: 64,
    backgroundColor: 'rgba(255,255,255,0.015)',
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: 'rgba(255,255,255,0.06)',
    flexDirection: 'row',
    overflow: 'hidden',
    position: 'relative',
  },
  clipBlock: {
    height: '100%',
    position: 'relative',
    overflow: 'hidden',
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
  clipSelectionBorder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 2,
    borderRadius: 2,
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
    top: -3,
    left: -4,
    width: 10,
    height: 6,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
    backgroundColor: '#ffffff',
  },
});
