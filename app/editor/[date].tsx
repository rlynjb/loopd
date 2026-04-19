import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSharedValue } from 'react-native-reanimated';
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
const TRANSITION_SETTLE_TOLERANCE_SEC = 0.12;
const TRANSITION_EARLY_TOLERANCE_SEC = 0.05;
const ZERO_START_ACCEPT_WINDOW_SEC = 2;

const NUNITO_FONT: Record<number, string> = { 300: 'Nunito300', 500: 'Nunito500', 700: 'Nunito700' };
function logPlaybackDebug(message: string, details?: Record<string, unknown>) {
  if (!__DEV__) return;
  if (details) {
    console.log(`[editor playback] ${message}`, details);
    return;
  }
  console.log(`[editor playback] ${message}`);
}

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
  const { project, save, updateClips, removeClip, updateTextOverlays, updateFilterOverlays } = useProject(date, entries, dayTitle);

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
  const playheadPosAnim = useSharedValue(0);
  const playheadRefPos = useSharedValue(0);
  const playheadRefTimeMs = useSharedValue(0);
  const isPlayingSV = useSharedValue(false);
  const totalDurationMsSV = useSharedValue(0);
  const canExtrapolateSV = useSharedValue(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const { progress: exportProgress, isExporting, startExport, cancelExport } = useExport();
  const { renderAll: renderTextOverlays, Renderer: TextRenderer } = useTextRenderer();
  const [renderingText, setRenderingText] = useState(false);
  const [previewHeight, setPreviewHeight] = useState(280);
  const pendingTransitionRef = useRef<{ clipId: string; expectedStartSec: number } | null>(null);
  const advancedFromClipRef = useRef<string | null>(null);
  const lastProgressRef = useRef<{ wallMs: number; videoSec: number; clipId: string } | null>(null);
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
  useEffect(() => { isPlayingSV.value = isPlaying; }, [isPlaying, isPlayingSV]);
  const filterOverlays = project?.filterOverlays ?? [];
  const totalDurationSec = clips.reduce((sum, c) => sum + getEffective(c), 0);
  useEffect(() => { totalDurationMsSV.value = totalDurationSec * 1000; }, [totalDurationSec, totalDurationMsSV]);

  // Single active filter (first one, or none)
  const activeFilter = filterOverlays[0] ?? null;
  const activeFilterId = activeFilter?.filterId ?? 'none';

  // Detect complex project for migration banner
  const hasAdvancedSettings = !bannerDismissed && project && (
    filterOverlays.length > 1 ||
    filterOverlays.some(f => f.startPct !== 0 || f.endPct !== 100)
  );

  const togglePlay = () => {
    if (isPlaying) {
      setIsPlaying(false);
    } else {
      advancedFromClipRef.current = null;
      if (playheadPos >= 0.99) { setPlayheadPos(0); playheadPosAnim.value = 0; }
      playheadRefPos.value = playheadPos >= 0.99 ? 0 : playheadPos;
      playheadRefTimeMs.value = performance.now();
      canExtrapolateSV.value = false;
      setIsPlaying(true);
    }
  };

  const clipStartOffsetsSec = useMemo(() => {
    const offsets = new Map<string, number>();
    let acc = 0;
    for (const clip of clips) {
      offsets.set(clip.id, acc);
      acc += getEffective(clip);
    }
    return offsets;
  }, [clips]);

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
  // Next clip is preloaded into the PreviewPlayer's second video slot so the
  // transition is a visual swap rather than a source change + reload.
  const nextClip = useMemo(() => {
    if (!currentClip) return null;
    const idx = clips.findIndex(c => c.id === currentClip.id);
    if (idx < 0 || idx >= clips.length - 1) return null;
    return clips[idx + 1];
  }, [clips, currentClip?.id]);
  const visibleFilter = activeFilter;
  const editingText = textOverlays.find(t => t.id === editingTextId);

  const advanceFromClipEnd = useCallback((clip: ClipItem, reason: 'trim-end' | 'on-end' = 'trim-end') => {
    if (advancedFromClipRef.current === clip.id) return;
    advancedFromClipRef.current = clip.id;
    const clipIndex = clips.findIndex(c => c.id === clip.id);
    if (clipIndex < 0) return;
    const trimEndSec = (clip.durationMs / 1000) * clip.trimEndPct / 100;
    const lastProgress = lastProgressRef.current?.clipId === clip.id ? lastProgressRef.current.videoSec : null;
    logPlaybackDebug('advance cause', {
      reason,
      clipId: clip.id,
      trimEndSec: Number(trimEndSec.toFixed(3)),
      lastProgressVideoSec: lastProgress != null ? Number(lastProgress.toFixed(3)) : null,
      earlyBy: lastProgress != null ? Number((trimEndSec - lastProgress).toFixed(3)) : null,
    });

    const isLastClip = clipIndex === clips.length - 1;
    if (isLastClip) {
      pendingTransitionRef.current = null;
      playheadPosAnim.value = 1;
      setPlayheadPos(1);
      setIsPlaying(false);
      return;
    }

    const nextClip = clips[clipIndex + 1];
    const nextClipStartSec = clipStartOffsetsSec.get(nextClip.id) ?? 0;
    const nextTrimStartSec = (nextClip.durationMs / 1000) * nextClip.trimStartPct / 100;
    pendingTransitionRef.current = {
      clipId: nextClip.id,
      expectedStartSec: nextTrimStartSec,
    };
    logPlaybackDebug('advance from clip end', {
      fromClipId: clip.id,
      toClipId: nextClip.id,
      nextClipStartSec: Number(nextClipStartSec.toFixed(3)),
      nextTrimStartSec: Number(nextTrimStartSec.toFixed(3)),
    });
    const nextGlobalTimeSec = Math.min(totalDurationSec, nextClipStartSec);
    const nextPos = totalDurationSec > 0 ? nextGlobalTimeSec / totalDurationSec : 0;
    playheadPosAnim.value = nextPos;
    playheadRefPos.value = nextPos;
    playheadRefTimeMs.value = performance.now();
    canExtrapolateSV.value = false;
    setPlayheadPos(nextPos);
  }, [clips, clipStartOffsetsSec, totalDurationSec]);

  const handlePlaybackProgress = useCallback((clipId: string, currentTimeSec: number) => {
    if (!currentClip || totalDurationSec <= 0) return;
    if (clipId !== currentClip.id) return;
    // If we already triggered advance from this clip (e.g., the last clip's onEnd fired),
    // ignore any further progress events — the video may have looped or restarted.
    if (advancedFromClipRef.current === clipId) {
      logPlaybackDebug('ignored post-advance progress', { clipId, currentTimeSec: Number(currentTimeSec.toFixed(3)) });
      return;
    }

    const pendingTransition = pendingTransitionRef.current;
    if (pendingTransition) {
      if (clipId !== pendingTransition.clipId) return;
      const expectsZeroStart = pendingTransition.expectedStartSec <= TRANSITION_EARLY_TOLERANCE_SEC;
      if (expectsZeroStart) {
        if (currentTimeSec > ZERO_START_ACCEPT_WINDOW_SEC) {
          logPlaybackDebug('ignored late zero-start progress during transition', {
            clipId,
            expectedStartSec: Number(pendingTransition.expectedStartSec.toFixed(3)),
            currentTimeSec: Number(currentTimeSec.toFixed(3)),
          });
          return;
        }
        logPlaybackDebug('accepted zero-start progress during transition', {
          clipId,
          currentTimeSec: Number(currentTimeSec.toFixed(3)),
          expectedStartSec: Number(pendingTransition.expectedStartSec.toFixed(3)),
        });
        pendingTransitionRef.current = null;
      } else {
        if (currentTimeSec < pendingTransition.expectedStartSec - TRANSITION_EARLY_TOLERANCE_SEC) {
          logPlaybackDebug('ignored early progress during transition', {
            clipId,
            currentTimeSec: Number(currentTimeSec.toFixed(3)),
            expectedStartSec: Number(pendingTransition.expectedStartSec.toFixed(3)),
          });
          return;
        }
        if (currentTimeSec > pendingTransition.expectedStartSec + TRANSITION_SETTLE_TOLERANCE_SEC) {
          logPlaybackDebug('ignored late progress during transition', {
            clipId,
            expectedStartSec: Number(pendingTransition.expectedStartSec.toFixed(3)),
            currentTimeSec: Number(currentTimeSec.toFixed(3)),
          });
          return;
        }
        logPlaybackDebug('accepted first progress during transition', {
          clipId,
          currentTimeSec: Number(currentTimeSec.toFixed(3)),
          expectedStartSec: Number(pendingTransition.expectedStartSec.toFixed(3)),
        });
        pendingTransitionRef.current = null;
      }
    }

    const clipStartSec = clipStartOffsetsSec.get(currentClip.id) ?? 0;
    const trimStartSec = (currentClip.durationMs / 1000) * currentClip.trimStartPct / 100;
    const trimEndSec = (currentClip.durationMs / 1000) * currentClip.trimEndPct / 100;
    if (currentTimeSec >= trimEndSec - 0.03) {
      advanceFromClipEnd(currentClip);
      return;
    }

    const boundedTimeSec = Math.max(trimStartSec, Math.min(trimEndSec, currentTimeSec));
    const globalTimeSec = Math.min(totalDurationSec, clipStartSec + Math.max(0, boundedTimeSec - trimStartSec));
    const nextPlayheadPos = totalDurationSec > 0 ? globalTimeSec / totalDurationSec : 0;
    const nowMs = performance.now();
    const last = lastProgressRef.current;
    let wallDeltaMs: number | null = null;
    let videoDeltaMs: number | null = null;
    let rate: number | null = null;
    if (last && last.clipId === clipId) {
      wallDeltaMs = Math.round(nowMs - last.wallMs);
      videoDeltaMs = Math.round((currentTimeSec - last.videoSec) * 1000);
      rate = wallDeltaMs > 0 ? Number((videoDeltaMs / wallDeltaMs).toFixed(2)) : null;
    }
    lastProgressRef.current = { wallMs: nowMs, videoSec: currentTimeSec, clipId };
    const stutter = wallDeltaMs != null && wallDeltaMs > 120;
    const offRate = rate != null && (rate < 0.7 || rate > 1.3);
    logPlaybackDebug('progress applied', {
      clipId,
      currentTimeSec: Number(currentTimeSec.toFixed(3)),
      nextPlayheadPos: Number(nextPlayheadPos.toFixed(4)),
      wallDeltaMs,
      videoDeltaMs,
      rate,
      flag: stutter ? 'STUTTER' : offRate ? 'OFF_RATE' : undefined,
    });

    playheadPosAnim.value = nextPlayheadPos;
    playheadRefPos.value = nextPlayheadPos;
    playheadRefTimeMs.value = performance.now();
    canExtrapolateSV.value = true;
    setPlayheadPos(prev => Math.abs(prev - nextPlayheadPos) > 0.0005 ? nextPlayheadPos : prev);
  }, [advanceFromClipEnd, clipStartOffsetsSec, currentClip, totalDurationSec]);

  const handlePlaybackEnd = useCallback((clipId: string) => {
    if (!currentClip || clipId !== currentClip.id) return;
    advanceFromClipEnd(currentClip, 'on-end');
  }, [advanceFromClipEnd, currentClip]);

  // Clip operations
  const selectClip = (id: string | null) => {
    setSelectedClipId(id === selectedClipId ? null : id);
  };

  const deleteClip = (id: string) => {
    removeClip(id);
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
          onPress={() => { setSelectedClipId(null); setEditingTextId(null); if (isPlaying) { setIsPlaying(false); } }}
          style={styles.previewContainer}
        >
          <View style={[styles.previewFrame, { width: Math.round(previewHeight * 9 / 16), height: previewHeight }]}>
            {currentClip ? (
              <PreviewPlayer
                currentClip={currentClip}
                currentClipSeekSec={currentClipSeekSec}
                nextClip={nextClip}
                isPlaying={isPlaying}
                visibleTexts={[]}
                visibleFilter={visibleFilter}
                selectedTextId={null}
                focusTextInput={false}
                onSelectText={() => {}}
                onUpdateText={() => {}}
                previewHeight={previewHeight}
                onPlaybackProgress={handlePlaybackProgress}
                onPlaybackEnd={handlePlaybackEnd}
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
          playheadPosAnim={playheadPosAnim}
          playheadRefPos={playheadRefPos}
          playheadRefTimeMs={playheadRefTimeMs}
          isPlayingSV={isPlayingSV}
          totalDurationMsSV={totalDurationMsSV}
          canExtrapolateSV={canExtrapolateSV}
          isPlaying={isPlaying}
          onSelectClip={selectClip}
          onTrimClip={trimClip}
          onMoveClip={moveClip}
          onDeleteClip={deleteClip}
          onSplitClip={splitClip}
          onPlayheadDrag={pos => {
            playheadPosAnim.value = pos;
            playheadRefPos.value = pos;
            playheadRefTimeMs.value = performance.now();
            if (isPlaying) { setIsPlaying(false); }
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
          <FilterPills
            activeFilterId={activeFilterId}
            onSelect={setFilter}
            previewClipUri={clips[0]?.clipUri}
            previewClipTrimStartMs={clips[0] ? clips[0].durationMs * clips[0].trimStartPct / 100 : 0}
          />
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
