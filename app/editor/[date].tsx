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
import { PreviewPlayer } from '../../src/components/editor/PreviewPlayer';
import { TextOverlaySheet } from '../../src/components/editor/TextOverlaySheet';
import { ClipTimeline } from '../../src/components/editor/ClipTimeline';
import { FilterPills } from '../../src/components/editor/FilterPills';
import { ExportModal } from '../../src/components/editor/ExportModal';
import { useExport } from '../../src/hooks/useExport';
import { useTextRenderer } from '../../src/services/textRenderer';
import { FILTERS } from '../../src/constants/filters';
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

  // Generate thumbnail from first clip
  useEffect(() => {
    const firstClip = clips[0];
    if (!firstClip?.clipUri) { setThumbnailUri(null); return; }
    VideoThumbnails.getThumbnailAsync(firstClip.clipUri, { time: 1000 })
      .then(r => setThumbnailUri(r.uri))
      .catch(() => setThumbnailUri(null));
  }, [clips[0]?.clipUri]);

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
  const selectClip = (id: string) => {
    setSelectedClipId(id === selectedClipId ? null : id);
  };

  const deleteClip = (id: string) => {
    updateClips(prev => prev.filter(c => c.id !== id));
    if (selectedClipId === id) setSelectedClipId(null);
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
      const minPct = clip.durationMs > 0 ? Math.max(0.5, (500 / clip.durationMs) * 100) : 0.5;
      if (side === 'left') {
        const newStart = Math.max(0, Math.min(clip.trimEndPct - minPct, clip.trimStartPct + deltaPct));
        return { ...clip, trimStartPct: newStart };
      } else {
        const newEnd = Math.min(100, Math.max(clip.trimStartPct + minPct, clip.trimEndPct + deltaPct));
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
          {/* Regenerate button slot — wired in Phase 3 */}
          <View style={{ width: 34 }} />
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
          {isPlaying && currentClip ? (
            <View style={[styles.previewFrame, { width: Math.round(previewHeight * 9 / 16), height: previewHeight }]}>
              <PreviewPlayer
                currentClip={currentClip}
                currentClipSeekSec={currentClipSeekSec}
                isPlaying={isPlaying}
                visibleTexts={textOverlays}
                visibleFilter={visibleFilter}
                selectedTextId={null}
                focusTextInput={false}
                onSelectText={() => {}}
                onUpdateText={() => {}}
                previewHeight={previewHeight}
              />
            </View>
          ) : (
            <View style={[styles.previewFrame, { width: Math.round(previewHeight * 9 / 16), height: previewHeight }]}>
              {thumbnailUri ? (
                <Image source={{ uri: thumbnailUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              ) : null}
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
              {!thumbnailUri && clips.length === 0 && (
                <Icon name="clapperboard" size={32} color={colors.textDimmer} />
              )}
            </View>
          )}
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
          onSelectClip={selectClip}
          onTrimClip={trimClip}
          onMoveClip={moveClip}
          onDeleteClip={deleteClip}
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
