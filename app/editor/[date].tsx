import { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, Pressable, TextInput, ScrollView, PanResponder, StyleSheet, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Sharing from 'expo-sharing';
import { saveToDCIMLoopd } from '../../src/services/fileManager';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { colors, fonts } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';
import { SpinningIcon } from '../../src/components/ui/SpinningIcon';
import { useNotionSync } from '../../src/hooks/useNotionSync';
import { useEntries } from '../../src/hooks/useEntries';
import { useHabits } from '../../src/hooks/useHabits';
import { useProject } from '../../src/hooks/useProject';
import { useDayTitle } from '../../src/hooks/useDayTitle';
import { generateId } from '../../src/utils/id';
import { formatDuration } from '../../src/utils/time';
import { EditorTimeline } from '../../src/components/editor/EditorTimeline';
import { PreviewPlayer } from '../../src/components/editor/PreviewPlayer';
import { ClipEditor } from '../../src/components/editor/ClipEditor';
import { TextEditor } from '../../src/components/editor/TextEditor';
import { FilterEditor } from '../../src/components/editor/FilterEditor';
import { ExportModal } from '../../src/components/editor/ExportModal';
import { useExport } from '../../src/hooks/useExport';
import { useTextRenderer } from '../../src/services/textRenderer';
import type { ClipItem, TextOverlay, FilterOverlay } from '../../src/types/project';

const CLIP_COLORS = ['#fb7185', '#a78bfa', '#00d9a3', '#fbbf24', '#38bdf8', '#f472b6', '#34d399', '#c084fc'];

function getEffective(c: ClipItem): number {
  return (c.durationMs / 1000) * (c.trimEndPct - c.trimStartPct) / 100;
}

export default function EditorScreen() {
  const { date } = useLocalSearchParams<{ date: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { status: syncStatus, configured: syncConfigured, syncNow } = useNotionSync();
  const { entries } = useEntries(date);
  const habits = useHabits();
  const { title: dayTitle } = useDayTitle(date);
  const { project, save, updateClips, updateTextOverlays, updateFilterOverlays } = useProject(date, entries, dayTitle);

  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [selectedFilterId, setSelectedFilterId] = useState<string | null>(null);
  const [shouldFocusText, setShouldFocusText] = useState(false);
  const [playheadPos, setPlayheadPos] = useState(0);
  const [timelineZoom, setTimelineZoom] = useState(100);
  const [isPlaying, setIsPlaying] = useState(false);
  const [addingClip, setAddingClip] = useState(false);
  const [addingText, setAddingText] = useState(false);
  const [newCaption, setNewCaption] = useState('');
  const [newTextContent, setNewTextContent] = useState('');
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
      onPanResponderGrant: () => {
        heightAtDragStart.current = currentHeightRef.current;
      },
      onPanResponderMove: (_, gs) => {
        const newHeight = Math.round(Math.max(100, Math.min(500, heightAtDragStart.current + gs.dy)));
        // Throttle more aggressively to avoid overwhelming react-native-video
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

  const clearSelections = () => {
    setSelectedClipId(null);
    setSelectedTextId(null);
    setSelectedFilterId(null);
    setShouldFocusText(false);
  };

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
      return () => {
        if (playRef.current) cancelAnimationFrame(playRef.current);
      };
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

  // Find current clip at playhead + compute seek position within clip
  const getClipAtPlayhead = (): { clip: ClipItem | null; seekSec: number } => {
    if (totalDurationSec === 0) return { clip: null, seekSec: 0 };
    const playheadTimeSec = playheadPos * totalDurationSec;
    let acc = 0;
    for (const c of clips) {
      const effectiveSec = getEffective(c);
      if (playheadTimeSec < acc + effectiveSec) {
        const offsetInClip = playheadTimeSec - acc;
        const trimStartSec = (c.durationMs / 1000) * c.trimStartPct / 100;
        return { clip: c, seekSec: trimStartSec + offsetInClip };
      }
      acc += effectiveSec;
    }
    const last = clips[clips.length - 1];
    return { clip: last ?? null, seekSec: 0 };
  };

  const playheadPct = playheadPos * 100;
  const visibleTexts = textOverlays.filter(t =>
    (playheadPct >= t.startPct && playheadPct <= t.endPct) || t.id === selectedTextId
  );
  const visibleFilter = filterOverlays.find(f => playheadPct >= f.startPct && playheadPct <= f.endPct) ?? null;
  const { clip: currentClip, seekSec: currentClipSeekSec } = getClipAtPlayhead();

  // Clip operations
  const selectClip = (id: string) => {
    const newId = id === selectedClipId ? null : id;
    clearSelections();
    setSelectedClipId(newId);
    if (newId && totalDurationSec > 0) {
      let offset = 0;
      for (const c of clips) {
        if (c.id === newId) break;
        offset += getEffective(c);
      }
      setPlayheadPos(offset / totalDurationSec);
    }
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

  const deleteClip = (id: string) => {
    updateClips(prev => prev.filter(c => c.id !== id));
    if (selectedClipId === id) setSelectedClipId(null);
  };

  const updateClip = (id: string, updates: Partial<ClipItem>) => {
    updateClips(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
  };

  const addClip = () => {
    if (!newCaption.trim()) return;
    const newClip: ClipItem = {
      id: generateId('clip'),
      entryId: '',
      clipUri: '',
      caption: newCaption.trim(),
      durationMs: (Math.floor(Math.random() * 20 + 5)) * 1000,
      trimStartPct: 0,
      trimEndPct: 100,
      order: clips.length,
      color: CLIP_COLORS[clips.length % CLIP_COLORS.length],
    };
    updateClips([...clips, newClip]);
    setNewCaption('');
    setAddingClip(false);
    clearSelections();
    setSelectedClipId(newClip.id);
  };

  // Split clip at playhead
  const splitClip = (id: string) => {
    const clip = clips.find(c => c.id === id);
    if (!clip) return;

    // Figure out where the playhead is within this clip (0-100%)
    let accSec = 0;
    for (const c of clips) {
      if (c.id === id) break;
      accSec += getEffective(c);
    }
    const clipEffective = getEffective(clip);
    const playheadTimeSec = playheadPos * totalDurationSec;
    const offsetInClip = playheadTimeSec - accSec;
    const splitRatio = clipEffective > 0 ? offsetInClip / clipEffective : 0.5;

    // Convert split point to percentage of full clip duration
    const trimRange = clip.trimEndPct - clip.trimStartPct;
    const splitPct = clip.trimStartPct + trimRange * splitRatio;

    if (splitPct - clip.trimStartPct < 3 || clip.trimEndPct - splitPct < 3) return;

    const clipA: ClipItem = {
      ...clip,
      id: generateId('clip'),
      trimEndPct: Math.round(splitPct),
    };
    const clipB: ClipItem = {
      ...clip,
      id: generateId('clip'),
      trimStartPct: Math.round(splitPct),
      caption: clip.caption,
      color: CLIP_COLORS[(clips.indexOf(clip) + 1) % CLIP_COLORS.length],
    };

    const idx = clips.findIndex(c => c.id === id);
    const next = [...clips];
    next.splice(idx, 1, clipA, clipB);
    updateClips(next);
    setSelectedClipId(clipA.id);
  };

  // Trim clip via drag handle
  const trimClip = (id: string, side: 'left' | 'right', deltaPct: number) => {
    updateClips(prev => prev.map(clip => {
      if (clip.id !== id) return clip;
      const clipWidthPct = totalDurationSec > 0
        ? (getEffective(clip) / totalDurationSec) * 100
        : 100;
      const clipDeltaPct = clipWidthPct > 0
        ? (deltaPct / clipWidthPct) * (clip.trimEndPct - clip.trimStartPct)
        : 0;

      // Minimum remaining clip: 0.5s worth of the original duration
      const minPct = clip.durationMs > 0 ? Math.max(0.5, (500 / clip.durationMs) * 100) : 0.5;

      if (side === 'left') {
        const newStart = Math.max(0, Math.min(clip.trimEndPct - minPct, clip.trimStartPct + clipDeltaPct));
        return { ...clip, trimStartPct: newStart };
      } else {
        const newEnd = Math.min(100, Math.max(clip.trimStartPct + minPct, clip.trimEndPct + clipDeltaPct));
        return { ...clip, trimEndPct: newEnd };
      }
    }));
  };

  // Playhead position within selected clip (0-100)
  const getPlayheadPctInClip = (): number => {
    if (!selectedClipId || totalDurationSec === 0) return 0;
    let accSec = 0;
    for (const c of clips) {
      if (c.id === selectedClipId) {
        const eff = getEffective(c);
        const playheadSec = playheadPos * totalDurationSec;
        const offsetInClip = playheadSec - accSec;
        return eff > 0 ? Math.max(0, Math.min(100, (offsetInClip / eff) * 100)) : 0;
      }
      accSec += getEffective(c);
    }
    return 0;
  };

  // Trim text overlay via drag handle — no overlap
  const trimText = (id: string, side: 'left' | 'right', deltaPct: number) => {
    updateTextOverlays(prev => prev.map(t => {
      if (t.id !== id) return t;
      const neighbors = prev.filter(o => o.id !== id);
      if (side === 'left') {
        let newStart = Math.max(0, Math.min(t.endPct - 5, t.startPct + deltaPct));
        // Don't extend into left neighbor
        for (const n of neighbors) {
          if (n.endPct <= t.startPct + 1 && n.endPct > newStart) {
            newStart = n.endPct;
          }
        }
        return { ...t, startPct: newStart };
      } else {
        let newEnd = Math.min(100, Math.max(t.startPct + 5, t.endPct + deltaPct));
        // Don't extend into right neighbor
        for (const n of neighbors) {
          if (n.startPct >= t.endPct - 1 && n.startPct < newEnd) {
            newEnd = n.startPct;
          }
        }
        return { ...t, endPct: newEnd };
      }
    }));
  };

  // Trim filter overlay via drag handle — no overlap
  const trimFilter = (id: string, side: 'left' | 'right', deltaPct: number) => {
    updateFilterOverlays(prev => prev.map(f => {
      if (f.id !== id) return f;
      const neighbors = prev.filter(o => o.id !== id);
      if (side === 'left') {
        let newStart = Math.max(0, Math.min(f.endPct - 5, f.startPct + deltaPct));
        for (const n of neighbors) {
          if (n.endPct <= f.startPct + 1 && n.endPct > newStart) {
            newStart = n.endPct;
          }
        }
        return { ...f, startPct: newStart };
      } else {
        let newEnd = Math.min(100, Math.max(f.startPct + 5, f.endPct + deltaPct));
        for (const n of neighbors) {
          if (n.startPct >= f.endPct - 1 && n.startPct < newEnd) {
            newEnd = n.startPct;
          }
        }
        return { ...f, endPct: newEnd };
      }
    }));
  };

  // Clamp position to avoid overlapping neighbors
  function clampToNeighbors(
    id: string,
    newStart: number,
    width: number,
    all: { id: string; startPct: number; endPct: number }[],
  ): number {
    let clamped = Math.max(0, Math.min(100 - width, newStart));
    const newEnd = clamped + width;
    for (const other of all) {
      if (other.id === id) continue;
      // Moving right — hit left edge of neighbor
      if (clamped < other.endPct && newEnd > other.startPct) {
        if (clamped + width / 2 < other.startPct + (other.endPct - other.startPct) / 2) {
          // Snap to left of neighbor
          clamped = Math.min(clamped, other.startPct - width);
        } else {
          // Snap to right of neighbor
          clamped = Math.max(clamped, other.endPct);
        }
      }
    }
    return Math.max(0, Math.min(100 - width, clamped));
  }

  // Move text overlay by dragging — no overlap
  const moveText = (id: string, deltaPct: number) => {
    updateTextOverlays(prev => prev.map(t => {
      if (t.id !== id) return t;
      const width = t.endPct - t.startPct;
      const desired = t.startPct + deltaPct;
      const newStart = clampToNeighbors(id, desired, width, prev);
      return { ...t, startPct: newStart, endPct: newStart + width };
    }));
  };

  // Move filter overlay by dragging — no overlap
  const moveFilter = (id: string, deltaPct: number) => {
    updateFilterOverlays(prev => prev.map(f => {
      if (f.id !== id) return f;
      const width = f.endPct - f.startPct;
      const desired = f.startPct + deltaPct;
      const newStart = clampToNeighbors(id, desired, width, prev);
      return { ...f, startPct: newStart, endPct: newStart + width };
    }));
  };

  // Text overlay operations
  // Find available position that doesn't overlap existing overlays
  function findAvailableStart(
    desired: number,
    width: number,
    existing: { startPct: number; endPct: number }[],
  ): number {
    let start = desired;
    const sorted = [...existing].sort((a, b) => a.startPct - b.startPct);

    // Check if desired position overlaps anything
    let hasOverlap = true;
    while (hasOverlap && start + width <= 100) {
      hasOverlap = false;
      for (const o of sorted) {
        if (start < o.endPct && start + width > o.startPct) {
          // Overlap — move to after this block
          start = o.endPct;
          hasOverlap = true;
          break;
        }
      }
    }

    // If no room after, try from the beginning
    if (start + width > 100) {
      start = 0;
      hasOverlap = true;
      while (hasOverlap && start + width <= 100) {
        hasOverlap = false;
        for (const o of sorted) {
          if (start < o.endPct && start + width > o.startPct) {
            start = o.endPct;
            hasOverlap = true;
            break;
          }
        }
      }
    }

    return Math.min(start, 100 - width);
  }

  const addTextOverlay = () => {
    const width = 25;
    const desired = Math.round(playheadPos * 100);
    const start = findAvailableStart(desired, width, textOverlays);
    const newT: TextOverlay = {
      id: generateId('txt'),
      text: '',
      startPct: start,
      endPct: start + width,
      fontSize: 20,
      fontWeight: 400,
      color: '#ffffff',
      position: 'bottom',
    };
    updateTextOverlays(prev => [...prev, newT]);
    clearSelections();
    setSelectedTextId(newT.id);
    setShouldFocusText(true);
  };

  const updateText = (id: string, updates: Partial<TextOverlay>) => {
    updateTextOverlays(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
  };

  const deleteText = (id: string) => {
    updateTextOverlays(prev => prev.filter(t => t.id !== id));
    if (selectedTextId === id) setSelectedTextId(null);
  };

  // Filter overlay operations
  const addFilterOverlay = () => {
    const width = 30;
    const desired = Math.round(playheadPos * 100);
    const start = findAvailableStart(desired, width, filterOverlays);
    const newF: FilterOverlay = {
      id: generateId('fx'),
      filterId: 'none',
      startPct: start,
      endPct: start + width,
      brightness: 100,
      contrast: 100,
      saturate: 100,
    };
    updateFilterOverlays(prev => [...prev, newF]);
    clearSelections();
    setSelectedFilterId(newF.id);
  };

  const updateFilter = (id: string, updates: Partial<FilterOverlay>) => {
    updateFilterOverlays(prev => prev.map(f => f.id === id ? { ...f, ...updates } : f));
  };

  const deleteFilter = (id: string) => {
    updateFilterOverlays(prev => prev.filter(f => f.id !== id));
    if (selectedFilterId === id) setSelectedFilterId(null);
  };

  const handleSaveDraft = async () => {
    await save({ clips, textOverlays, filterOverlays });
    router.back();
  };

  const handleStartExport = useCallback(async () => {
    if (clips.length === 0) return;

    // Pre-render text overlays to PNG images
    const validTexts = textOverlays.filter(t => t.text.trim());
    let renderedTexts: Awaited<ReturnType<typeof renderTextOverlays>> | undefined;
    if (validTexts.length > 0) {
      try {
        setRenderingText(true);
        await new Promise(r => setTimeout(r, 150));
        renderedTexts = await renderTextOverlays(textOverlays);
      } catch (err) {
        console.warn('[loopd] Text rendering failed, exporting without text:', err);
      } finally {
        setRenderingText(false);
      }
    }

    const exportUri = await startExport(date, clips, textOverlays, filterOverlays, renderedTexts);
    if (!exportUri) return; // failed or cancelled

    await save({ clips, textOverlays, filterOverlays, status: 'exported', exportUri });

    // Save to DCIM/loopd
    try {
      await saveToDCIMLoopd(exportUri);
    } catch (e) {
      console.warn('[loopd] Could not save to DCIM:', e);
    }

    // Dismiss export modal, then open share sheet
    cancelExport();

    try {
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(exportUri, {
          mimeType: 'video/mp4',
          dialogTitle: 'Share your vlog',
        });
      }
    } catch {
      // User dismissed share sheet
    }
  }, [clips, textOverlays, filterOverlays, date, startExport, save, cancelExport, renderTextOverlays]);

  const selectedClip = clips.find(c => c.id === selectedClipId);
  const selectedText = textOverlays.find(t => t.id === selectedTextId);
  const selectedFilter = filterOverlays.find(f => f.id === selectedFilterId);

  return (
    <View style={styles.container}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={{ padding: 8 }}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
        <Text style={styles.title}>Vlog Editor</Text>
        <View style={styles.topBarRight}>
          <Pressable
            onPress={() => clips.length > 0 && !isExporting && handleStartExport()}
            hitSlop={8}
            style={[{ padding: 8 }, clips.length === 0 && { opacity: 0.3 }]}
          >
            <Icon name="download" size={18} color={colors.accent} />
          </Pressable>
          {syncConfigured && (
            <Pressable onPress={syncStatus !== 'syncing' ? syncNow : undefined} hitSlop={8} style={{ padding: 8 }}>
              <SpinningIcon name="refresh" size={18} color={syncStatus === 'syncing' ? colors.accent2 : colors.textDim} spinning={syncStatus === 'syncing'} />
            </Pressable>
          )}
          <Pressable onPress={() => router.push('/settings')} hitSlop={8} style={{ padding: 8 }}>
            <Icon name="settings" size={18} color={colors.textDim} />
          </Pressable>
        </View>
      </View>

      {/* Preview — tap to deselect */}
      <Pressable onPress={clearSelections} style={styles.previewWrap}>
        <PreviewPlayer
          currentClip={currentClip}
          currentClipSeekSec={currentClipSeekSec}
          isPlaying={isPlaying}
          visibleTexts={visibleTexts}
          visibleFilter={visibleFilter}
          selectedTextId={selectedTextId}
          focusTextInput={shouldFocusText}
          onSelectText={id => {
            clearSelections();
            if (id !== selectedTextId) {
              setSelectedTextId(id);
              setShouldFocusText(true);
            }
          }}
          onUpdateText={(id, text) => updateText(id, { text })}
          previewHeight={previewHeight}
        />
      </Pressable>

      {/* Resize handle */}
      <View {...resizePanResponder.panHandlers} style={styles.resizeHandle}>
        <View style={styles.resizeGrip} />
      </View>

      {/* Transport controls */}
      <View style={styles.transport}>
        <Pressable onPress={togglePlay} style={[styles.playBtn, { borderColor: isPlaying ? `${colors.coral}40` : `${colors.teal}40`, backgroundColor: isPlaying ? 'rgba(251,113,133,0.15)' : 'rgba(0,217,163,0.15)' }]}>
          <Text style={{ color: isPlaying ? colors.coral : colors.teal, fontSize: 14, fontWeight: '700' }}>
            {isPlaying ? '■' : '▶'}
          </Text>
        </Pressable>
        <Text style={styles.timeDisplay}>{formatDuration(Math.round(playheadPos * totalDurationSec))}</Text>
        <View style={styles.divider} />
        <Text style={styles.totalTime}>{formatDuration(totalDurationSec)}</Text>
        <Text style={styles.clipCount}>{clips.length} clips · {Math.round(timelineZoom * 100)}%</Text>
      </View>

      {/* NLE Timeline */}
      <EditorTimeline
        clips={clips}
        textOverlays={textOverlays}
        filterOverlays={filterOverlays}
        selectedClipId={selectedClipId}
        selectedTextId={selectedTextId}
        selectedFilterId={selectedFilterId}
        playheadPos={playheadPos}
        totalDurationSec={totalDurationSec}
        onSelectClip={selectClip}
        onSelectText={id => {
          clearSelections();
          if (id !== selectedTextId) {
            setSelectedTextId(id);
            // Auto-focus only if text is empty
            const overlay = textOverlays.find(t => t.id === id);
            setShouldFocusText(!overlay?.text);
          }
        }}
        onSelectFilter={id => { clearSelections(); setSelectedFilterId(id === selectedFilterId ? null : id); }}
        onAddClip={() => setAddingClip(true)}
        onAddText={() => addTextOverlay()}
        onAddFilter={() => addFilterOverlay()}
        onTimelinePress={pct => setPlayheadPos(pct)}
        onPlayheadDrag={pos => { if (isPlaying) { setIsPlaying(false); } setPlayheadPos(pos); }}
        onTrimClip={trimClip}
        onTrimText={trimText}
        onTrimFilter={trimFilter}
        onMoveText={moveText}
        onMoveFilter={moveFilter}
        onZoomChange={setTimelineZoom}
      />

      {/* Editor panels */}
      <ScrollView style={styles.panels} contentContainerStyle={styles.panelsContent}>
        {/* Add clip form */}
        {addingClip && (
          <View style={styles.addPanel}>
            <Text style={styles.addLabel}>ADD NEW CLIP</Text>
            <TextInput
              value={newCaption}
              onChangeText={setNewCaption}
              placeholder="What's in this clip?"
              placeholderTextColor={colors.textDimmer}
              autoFocus
              multiline
              blurOnSubmit={false}
              returnKeyType="default"
              style={styles.addInput}
            />
            <View style={styles.addBtnRow}>
              <Pressable onPress={() => { setAddingClip(false); setNewCaption(''); }} style={styles.cancelBtn}>
                <Text style={styles.cancelBtnText}>CANCEL</Text>
              </Pressable>
              <Pressable onPress={addClip} style={[styles.confirmBtn, { backgroundColor: newCaption.trim() ? colors.teal : 'rgba(255,255,255,0.05)' }]}>
                <Text style={[styles.confirmBtnText, { color: newCaption.trim() ? colors.bg : colors.textDimmer }]}>ADD CLIP</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Add text form */}

        {/* Filter picker removed — addFilterOverlay creates one directly */}

        {/* Selected clip editor */}
        {selectedClip && (
          <ClipEditor
            clip={selectedClip}
            playheadPctInClip={getPlayheadPctInClip()}
            onDelete={() => deleteClip(selectedClip.id)}
            onSplit={() => splitClip(selectedClip.id)}
          />
        )}

        {/* Selected text editor */}
        {selectedText && (
          <TextEditor
            overlay={selectedText}
            onUpdate={updates => updateText(selectedText.id, updates)}
            onDelete={() => deleteText(selectedText.id)}
          />
        )}

        {/* Selected filter editor */}
        {selectedFilter && (
          <FilterEditor
            overlay={selectedFilter}
            onUpdate={updates => updateFilter(selectedFilter.id, updates)}
            onDelete={() => deleteFilter(selectedFilter.id)}
          />
        )}

        {clips.length === 0 && !addingClip && !addingText && !selectedText && (
          <Text style={styles.emptyText}>No clips in your vlog yet. Tap + on the timeline to add.</Text>
        )}

        {/* Tap to deselect — fills remaining space */}
        {(selectedClipId || selectedTextId || selectedFilterId) && (
          <Pressable onPress={clearSelections} style={styles.deselectArea}>
            <Text style={styles.deselectText}>tap to deselect</Text>
          </Pressable>
        )}
      </ScrollView>


      {/* Hidden text renderer — only mounted when rendering text for export */}
      {renderingText && <TextRenderer />}

      {/* Export modal */}
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
  backText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textMuted,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  previewWrap: {
    position: 'relative',
  },
  previewSaveBtn: {
    position: 'absolute',
    top: 16,
    left: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewExportBtn: {
    position: 'absolute',
    top: 16,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
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
  topBarRight: {
    flexDirection: 'row',
    gap: 2,
  },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingBottom: 8,
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
  clipCount: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.amber,
  },
  panels: {
    flex: 1,
  },
  panelsContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  addPanel: {
    backgroundColor: 'rgba(0,217,163,0.06)',
    borderWidth: 1.5,
    borderColor: 'rgba(0,217,163,0.2)',
    borderRadius: 0,
    padding: 16,
    marginBottom: 14,
  },
  addLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
    marginBottom: 10,
  },
  addInput: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
    padding: 12,
    color: colors.text,
    fontSize: 13,
    fontFamily: fonts.body,
    height: 56,
    textAlignVertical: 'top',
  },
  addBtnRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 10,
    alignItems: 'center',
  },
  cancelBtnText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
  },
  confirmBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  confirmBtnText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: '700',
  },
  deselectArea: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  deselectText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDimmer,
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
