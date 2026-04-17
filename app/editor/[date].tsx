import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, PanResponder, StyleSheet, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Sharing from 'expo-sharing';
import { saveToDCIMLoopd } from '../../src/services/fileManager';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';
import { useEntries } from '../../src/hooks/useEntries';
import { useProject } from '../../src/hooks/useProject';
import { useDayTitle } from '../../src/hooks/useDayTitle';
import { generateId } from '../../src/utils/id';
import { formatDuration } from '../../src/utils/time';
import { Image } from 'react-native';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as Haptics from 'expo-haptics';
import { PreviewPlayer } from '../../src/components/editor/PreviewPlayer';
import { TextOverlaySheet } from '../../src/components/editor/TextOverlaySheet';
import { ClipTimeline } from '../../src/components/editor/ClipTimeline';
import { FilterPills } from '../../src/components/editor/FilterPills';
import { ExportModal } from '../../src/components/editor/ExportModal';
import { useExport } from '../../src/hooks/useExport';
import { useTextRenderer } from '../../src/services/textRenderer';
import { FILTERS } from '../../src/constants/filters';
import { isAIConfigured } from '../../src/services/ai/config';
import { summarize } from '../../src/services/ai/summarize';
import { autoCompose, fallbackCompose } from '../../src/services/ai/compose';
import { getAISummary } from '../../src/services/database';
import type { AISummary } from '../../src/types/ai';
import type { ClipItem, TextOverlay, FilterOverlay } from '../../src/types/project';

const CLIP_COLORS = ['#fb7185', '#a78bfa', '#00d9a3', '#fbbf24', '#38bdf8', '#f472b6', '#34d399', '#c084fc'];

const NUNITO_FONT: Record<number, string> = { 300: 'Nunito300', 500: 'Nunito500', 700: 'Nunito700' };
function getNunitoFont(weight: number): string {
  return NUNITO_FONT[weight] ?? 'Nunito700';
}

function getEffective(c: ClipItem): number {
  return (c.durationMs / 1000) * (c.trimEndPct - c.trimStartPct) / 100;
}

export default function EditorScreen() {
  const { date } = useLocalSearchParams<{ date: string }>();
  const router = useRouter();
  const { entries, reload: reloadEntries } = useEntries(date);
  const { title: dayTitle } = useDayTitle(date);
  const { project, save, updateClips, updateTextOverlays, updateFilterOverlays } = useProject(date, entries, dayTitle);

  useFocusEffect(useCallback(() => { reloadEntries(); }, [reloadEntries]));

  const [generating, setGenerating] = useState(false);

  // Auto-compose from AI or fallback on mount
  useEffect(() => {
    if (!project || entries.length === 0) return;
    // Only auto-compose if project has no clips yet (fresh project)
    if (project.clips.length > 0) return;

    let cancelled = false;
    (async () => {
      const aiConfigured = await isAIConfigured();
      const existingSummary = await getAISummary(date);

      if (existingSummary) {
        const summary: AISummary = JSON.parse(existingSummary.summaryJson);
        const composed = autoCompose(summary, entries, date, dayTitle);
        if (!cancelled && composed.clips && composed.clips.length > 0) {
          updateClips(composed.clips);
          if (composed.textOverlays) updateTextOverlays(composed.textOverlays);
          if (composed.filterOverlays) updateFilterOverlays(composed.filterOverlays);
        }
      } else if (aiConfigured) {
        setGenerating(true);
        const result = await summarize(date);
        if (!cancelled && result.summary) {
          const composed = autoCompose(result.summary, entries, date, dayTitle);
          if (composed.clips && composed.clips.length > 0) {
            updateClips(composed.clips);
            if (composed.textOverlays) updateTextOverlays(composed.textOverlays);
            if (composed.filterOverlays) updateFilterOverlays(composed.filterOverlays);
          }
        }
        setGenerating(false);
      }
      // fallbackCompose is handled by useProject's default behavior
    })();
    return () => { cancelled = true; };
  }, [project?.id, entries.length]);

  const handleRegenerate = () => {
    Alert.alert('Regenerate Summary', 'Regenerate the text overlay from AI? Your clip edits will be preserved.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Regenerate',
        onPress: async () => {
          setGenerating(true);
          const result = await summarize(date);
          setGenerating(false);
          if (result.summary) {
            const composed = autoCompose(result.summary, entries, date, dayTitle);
            // Only update text overlay — preserve user's clip trims/splits
            if (composed.textOverlays) updateTextOverlays(composed.textOverlays);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          } else {
            Alert.alert('Failed', result.error ?? 'Could not generate summary');
          }
        },
      },
    ]);
  };

  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [playheadPos, setPlayheadPos] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [thumbnailUri, setThumbnailUri] = useState<string | null>(null);
  const { progress: exportProgress, isExporting, startExport, cancelExport } = useExport();
  const { renderAll: renderTextOverlays, Renderer: TextRenderer } = useTextRenderer();
  const [renderingText, setRenderingText] = useState(false);
  const playRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const [previewHeight, setPreviewHeight] = useState(280);
  const heightAtDragStart = useRef(280);
  const currentHeightRef = useRef(280);
  currentHeightRef.current = previewHeight;

  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { heightAtDragStart.current = currentHeightRef.current; },
      onPanResponderMove: (_, gs) => {
        const newHeight = Math.round(Math.max(100, Math.min(500, heightAtDragStart.current + gs.dy)));
        if (resizeTimer.current) return;
        resizeTimer.current = setTimeout(() => { resizeTimer.current = null; }, 100);
        setPreviewHeight(newHeight);
      },
    })
  ).current;

  const clips = project?.clips ?? [];
  const textOverlays = project?.textOverlays ?? [];
  const filterOverlays = project?.filterOverlays ?? [];
  const totalDurationSec = clips.reduce((sum, c) => sum + getEffective(c), 0);

  // Pre-extract one thumbnail per clip at its trim midpoint
  const [clipThumbs, setClipThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    if (clips.length === 0) return;
    let cancelled = false;
    (async () => {
      const thumbs: Record<string, string> = {};
      for (const c of clips) {
        if (cancelled) return;
        const midPct = (c.trimStartPct + c.trimEndPct) / 2;
        const timeMs = Math.max(100, Math.round((c.durationMs * midPct) / 100));
        try {
          const r = await VideoThumbnails.getThumbnailAsync(c.clipUri, { time: timeMs, quality: 0.4 });
          thumbs[c.id] = r.uri;
        } catch { /* skip */ }
      }
      if (!cancelled) setClipThumbs(thumbs);
    })();
    return () => { cancelled = true; };
  }, [clips.map(c => `${c.id}:${c.trimStartPct}:${c.trimEndPct}`).join(',')]);

  // Find current clip at playhead and set its pre-extracted thumbnail
  const currentClipId = useMemo(() => {
    if (clips.length === 0 || totalDurationSec === 0) return null;
    const playheadTimeSec = playheadPos * totalDurationSec;
    let acc = 0;
    for (const c of clips) {
      const eff = getEffective(c);
      if (playheadTimeSec < acc + eff) return c.id;
      acc += eff;
    }
    return clips[clips.length - 1]?.id ?? null;
  }, [playheadPos, clips, totalDurationSec]);

  useEffect(() => {
    if (currentClipId && clipThumbs[currentClipId]) {
      setThumbnailUri(clipThumbs[currentClipId]);
    }
  }, [currentClipId, clipThumbs]);

  // Single active filter (first one, or none)
  const activeFilter = filterOverlays[0] ?? null;
  const activeFilterId = activeFilter?.filterId ?? 'none';

  // Detect complex project for migration banner
  const hasAdvancedSettings = !bannerDismissed && project && (
    filterOverlays.length > 1 ||
    filterOverlays.some(f => f.startPct !== 0 || f.endPct !== 100)
  );

  // Playhead animation
  useEffect(() => {
    if (isPlaying && totalDurationSec > 0) {
      const start = Date.now();
      const startPos = playheadPos;
      const remaining = 1 - startPos;
      const durationMs = remaining * totalDurationSec * 1000;
      const tick = () => {
        const elapsed = Date.now() - start;
        const progress = startPos + remaining * Math.min(elapsed / durationMs, 1);
        setPlayheadPos(Math.min(progress, 1));
        if (elapsed < durationMs) {
          playRef.current = requestAnimationFrame(tick);
        } else {
          setIsPlaying(false);
        }
      };
      playRef.current = requestAnimationFrame(tick);
      return () => { if (playRef.current) cancelAnimationFrame(playRef.current); };
    }
  }, [isPlaying]);

  const togglePlay = () => {
    if (isPlaying) {
      setIsPlaying(false);
      if (playRef.current) cancelAnimationFrame(playRef.current);
    } else {
      if (playheadPos >= 0.99) setPlayheadPos(0);
      setIsPlaying(true);
    }
  };

  const getClipAtPlayhead = (): { clip: ClipItem | null; seekSec: number } => {
    if (totalDurationSec === 0) return { clip: null, seekSec: 0 };
    const playheadTimeSec = playheadPos * totalDurationSec;
    let acc = 0;
    for (const c of clips) {
      const effectiveSec = getEffective(c);
      if (playheadTimeSec < acc + effectiveSec) {
        const trimStartSec = (c.durationMs / 1000) * c.trimStartPct / 100;
        return { clip: c, seekSec: trimStartSec + (playheadTimeSec - acc) };
      }
      acc += effectiveSec;
    }
    return { clip: clips[clips.length - 1] ?? null, seekSec: 0 };
  };

  const { clip: currentClip, seekSec: currentClipSeekSec } = getClipAtPlayhead();
  const visibleFilter = activeFilter;
  const editingText = textOverlays.find(t => t.id === editingTextId);

  // Clip operations
  const selectClip = (id: string | null) => {
    setSelectedClipId(id === selectedClipId ? null : id);
  };

  const deleteClip = (id: string) => {
    updateClips(prev => prev.filter(c => c.id !== id));
    if (selectedClipId === id) setSelectedClipId(null);
  };

  const splitClip = (id: string) => {
    const clip = clips.find(c => c.id === id);
    if (!clip) return;

    // Find where the playhead is within this clip
    const playheadTimeSec = playheadPos * totalDurationSec;
    let accSec = 0;
    for (const c of clips) {
      if (c.id === id) break;
      accSec += getEffective(c);
    }
    const clipEffectiveSec = getEffective(clip);
    const offsetInClip = Math.max(0, Math.min(clipEffectiveSec, playheadTimeSec - accSec));
    const splitRatio = clipEffectiveSec > 0 ? offsetInClip / clipEffectiveSec : 0.5;
    const trimRange = clip.trimEndPct - clip.trimStartPct;
    const splitPct = clip.trimStartPct + trimRange * splitRatio;

    // Minimum 0.3s on each side
    const minPct = clip.durationMs > 0 ? (300 / clip.durationMs) * 100 : 0.5;
    if (splitPct - clip.trimStartPct < minPct || clip.trimEndPct - splitPct < minPct) return;

    const precise = parseFloat(splitPct.toFixed(2));
    const clipA: ClipItem = { ...clip, id: generateId('clip'), trimEndPct: precise };
    const clipB: ClipItem = {
      ...clip,
      id: generateId('clip'),
      trimStartPct: precise,
      color: CLIP_COLORS[(clips.indexOf(clip) + 1) % CLIP_COLORS.length],
    };
    const idx = clips.findIndex(c => c.id === id);
    const next = [...clips];
    next.splice(idx, 1, clipA, clipB);
    updateClips(next);
    setSelectedClipId(clipA.id);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const moveClip = (id: string, dir: number) => {
    updateClips(prev => {
      const idx = prev.findIndex(c => c.id === id);
      if (idx < 0) return prev;
      const ni = idx + dir;
      if (ni < 0 || ni >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[ni]] = [next[ni], next[idx]];
      return next;
    });
  };

  // Clip strip trim handles
  const trimClip = (id: string, side: 'left' | 'right', deltaPct: number) => {
    updateClips(prev => prev.map(clip => {
      if (clip.id !== id) return clip;
      // Minimum remaining: 0.3s
      const minPct = clip.durationMs > 0 ? (300 / clip.durationMs) * 100 : 0.5;
      if (side === 'left') {
        const newStart = parseFloat(Math.max(0, Math.min(clip.trimEndPct - minPct, clip.trimStartPct + deltaPct)).toFixed(2));
        return { ...clip, trimStartPct: newStart };
      } else {
        const newEnd = parseFloat(Math.min(100, Math.max(clip.trimStartPct + minPct, clip.trimEndPct + deltaPct)).toFixed(2));
        return { ...clip, trimEndPct: newEnd };
      }
    }));
  };

  // Text overlay operations
  const openTextEditor = (id: string) => {
    setSelectedClipId(null);
    setEditingTextId(id);
  };

  const updateText = (id: string, updates: Partial<TextOverlay>) => {
    updateTextOverlays(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
  };

  // Filter operations — single filter spanning 0-100%
  const setFilter = (filterId: string) => {
    const preset = FILTERS.find(f => f.id === filterId);
    if (!preset) return;

    if (filterId === 'none') {
      updateFilterOverlays([]);
      return;
    }

    const filter: FilterOverlay = {
      id: activeFilter?.id ?? generateId('fx'),
      filterId,
      startPct: 0,
      endPct: 100,
      brightness: preset.brightness,
      contrast: preset.contrast,
      saturate: preset.saturate,
    };
    updateFilterOverlays([filter]);
  };

  // Export
  const handleStartExport = useCallback(async () => {
    if (clips.length === 0) return;
    const validTexts = textOverlays.filter(t => t.text.trim());
    let renderedTexts: Awaited<ReturnType<typeof renderTextOverlays>> | undefined;
    if (validTexts.length > 0) {
      try {
        setRenderingText(true);
        await new Promise(r => setTimeout(r, 150));
        renderedTexts = await renderTextOverlays(textOverlays);
      } catch (err) {
        console.warn('[loopd] Text rendering failed:', err);
      } finally {
        setRenderingText(false);
      }
    }

    const exportUri = await startExport(date, clips, textOverlays, filterOverlays, renderedTexts);
    if (!exportUri) return;

    await save({ clips, textOverlays, filterOverlays, status: 'exported', exportUri });

    try { await saveToDCIMLoopd(exportUri); } catch (e) {
      console.warn('[loopd] Could not save to DCIM:', e);
    }

    cancelExport();

    try {
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(exportUri, { mimeType: 'video/mp4', dialogTitle: 'Share your vlog' });
      }
    } catch { /* dismissed */ }
  }, [clips, textOverlays, filterOverlays, date, startExport, save, cancelExport, renderTextOverlays]);

  const selectedClip = clips.find(c => c.id === selectedClipId);

  return (
    <View style={styles.container}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 8 }}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
        <Text style={styles.title}>Vlog Editor</Text>
        <View style={styles.topBarRight}>
          {/* Regenerate with AI */}
          <Pressable
            onPress={handleRegenerate}
            hitSlop={8}
            style={[{ padding: 8 }, generating && { opacity: 0.4 }]}
            disabled={generating}
          >
            <Icon name="zap" size={18} color={colors.amber} />
          </Pressable>
          <Pressable
            onPress={() => clips.length > 0 && !isExporting && handleStartExport()}
            hitSlop={8}
            style={[{ padding: 8 }, clips.length === 0 && { opacity: 0.3 }]}
          >
            <Icon name="download" size={18} color={colors.accent} />
          </Pressable>
        </View>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {/* Preview */}
        <Pressable
          onPress={() => { setSelectedClipId(null); setEditingTextId(null); if (isPlaying) { setIsPlaying(false); if (playRef.current) cancelAnimationFrame(playRef.current); } }}
          style={styles.previewContainer}
        >
          <View style={[styles.previewFrame, { width: Math.round(previewHeight * 9 / 16), height: previewHeight }]}>
            {currentClip ? (
              <PreviewPlayer
                currentClip={currentClip}
                currentClipSeekSec={currentClipSeekSec}
                isPlaying={isPlaying}
                visibleTexts={[]}
                visibleFilter={visibleFilter}
                selectedTextId={null}
                focusTextInput={false}
                onSelectText={() => {}}
                onUpdateText={() => {}}
                previewHeight={previewHeight}
              />
            ) : (
              <Icon name="clapperboard" size={32} color={colors.textDimmer} />
            )}
            {/* Text overlays — rendered on top of video */}
            {(() => {
              const scale = previewHeight / 400;
              const pad = Math.round(12 * scale);
              return textOverlays.map(t => {
                const sz = Math.max(6, Math.round(t.fontSize * scale));
                const isEditing = t.id === editingTextId;
                const font = getNunitoFont(t.fontWeight);
                return isEditing ? (
                  <TextInput
                    key={t.id}
                    autoFocus
                    multiline
                    value={t.text}
                    onChangeText={text => updateText(t.id, { text })}
                    placeholder="Type here..."
                    placeholderTextColor="rgba(255,255,255,0.4)"
                    style={[
                      styles.previewTextInput,
                      { fontSize: sz, fontFamily: font, color: t.color, textAlign: t.textAlign },
                      t.position === 'top' && { top: pad },
                      t.position === 'center' && { top: '40%' },
                      t.position === 'bottom' && { bottom: pad },
                    ]}
                  />
                ) : (
                  <Pressable
                    key={t.id}
                    onPress={() => openTextEditor(t.id)}
                    style={[
                      styles.previewTextWrap,
                      t.position === 'top' && { top: pad },
                      t.position === 'center' && { top: '40%' },
                      t.position === 'bottom' && { bottom: pad },
                    ]}
                  >
                    <Text style={[
                      styles.previewTextStatic,
                      { fontSize: sz, fontFamily: font, color: t.color, textAlign: t.textAlign },
                    ]}>{t.text || 'Tap to edit'}</Text>
                  </Pressable>
                );
              });
            })()}
          </View>
        </Pressable>

        {/* Resize handle */}
        <View {...resizePanResponder.panHandlers} style={styles.resizeHandle}>
          <View style={styles.resizeGrip} />
        </View>

        {/* Transport */}
        {clips.length > 0 && (
          <View style={styles.transport}>
            <Pressable
              onPress={togglePlay}
              style={[styles.playBtn, {
                borderColor: isPlaying ? `${colors.coral}40` : `${colors.teal}40`,
                backgroundColor: isPlaying ? 'rgba(251,113,133,0.15)' : 'rgba(0,217,163,0.15)',
              }]}
            >
              <Text style={{ color: isPlaying ? colors.coral : colors.teal, fontSize: 14, fontWeight: '700' }}>
                {isPlaying ? '■' : '▶'}
              </Text>
            </Pressable>
            <Text style={styles.timeDisplay}>{formatDuration(Math.round(playheadPos * totalDurationSec))}</Text>
            <View style={styles.divider} />
            <Text style={styles.totalTime}>{formatDuration(totalDurationSec)}</Text>
          </View>
        )}

        {/* Migration banner */}
        {hasAdvancedSettings && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>Some advanced settings aren't editable in the new editor. Export to preserve them.</Text>
            <Pressable onPress={() => setBannerDismissed(true)} hitSlop={8}>
              <Icon name="x" size={14} color={colors.textDim} />
            </Pressable>
          </View>
        )}

        {/* Timeline */}
        <ClipTimeline
          clips={clips}
          selectedClipId={selectedClipId}
          playheadPos={playheadPos}
          isPlaying={isPlaying}
          onSelectClip={selectClip}
          onTrimClip={trimClip}
          onMoveClip={moveClip}
          onDeleteClip={deleteClip}
          onSplitClip={splitClip}
          onPlayheadDrag={pos => {
            if (isPlaying) { setIsPlaying(false); if (playRef.current) cancelAnimationFrame(playRef.current); }
            setPlayheadPos(pos);
          }}
        />

        {/* Text overlay editor (inline) */}
        {editingText && (
          <TextOverlaySheet
            overlay={editingText}
            onUpdate={updates => updateText(editingText.id, updates)}
          />
        )}

        {/* Filter pills */}
        <View style={styles.filterSection}>
          <Text style={styles.sectionLabel}>FILTER</Text>
          <FilterPills activeFilterId={activeFilterId} onSelect={setFilter} />
        </View>


        {clips.length === 0 && (
          <Text style={styles.emptyText}>No clips yet. Add clips from the journal page.</Text>
        )}
      </ScrollView>

      {/* Text overlay sheet is rendered inline in the scroll content */}

      {renderingText && <TextRenderer />}

      <ExportModal
        progress={exportProgress}
        clipCount={clips.length}
        textCount={textOverlays.length}
        filterCount={filterOverlays.length}
        onCancel={cancelExport}
      />
    </View>
  );
}


const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  topBar: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  topBarRight: {
    flexDirection: 'row',
    gap: 2,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: GLOBAL_NAV_HEIGHT + 40,
  },
  resizeHandle: {
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 40,
  },
  resizeGrip: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  playBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeDisplay: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.text,
    minWidth: 48,
  },
  divider: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  totalTime: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    backgroundColor: 'rgba(251,191,36,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.2)',
    borderRadius: 8,
    gap: 10,
  },
  bannerText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.amber,
    lineHeight: 16,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    letterSpacing: 1,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  filterSection: {
    marginBottom: 16,
  },
  previewContainer: {
    alignItems: 'center',
    backgroundColor: colors.bg,
  },
  previewFrame: {
    backgroundColor: '#0a0a0a',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  emptyPreviewText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDimmer,
  },
  previewTextWrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    zIndex: 10,
  },
  previewTextStatic: {
    fontFamily: 'Nunito500',
  },
  previewText: {
    position: 'absolute',
    left: 12,
    right: 12,
    fontFamily: 'Nunito500',
    zIndex: 10,
  },
  previewTextInput: {
    position: 'absolute',
    left: 12,
    right: 12,
    fontFamily: 'Nunito500',
    padding: 0,
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.4)',
    borderStyle: 'dashed',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
    zIndex: 10,
  },
  emptyText: {
    textAlign: 'center',
    paddingVertical: 28,
    paddingHorizontal: 16,
    color: colors.textDim,
    fontFamily: fonts.body,
    fontSize: 13,
  },
});
