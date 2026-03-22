import { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, Pressable, TextInput, ScrollView, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { colors, fonts } from '../../src/constants/theme';
import { FILTERS } from '../../src/constants/filters';
import { useEntries } from '../../src/hooks/useEntries';
import { useHabits } from '../../src/hooks/useHabits';
import { useProject } from '../../src/hooks/useProject';
import { insertVlog } from '../../src/services/database';
import { generateId } from '../../src/utils/id';
import { formatDuration } from '../../src/utils/time';
import { MOODS } from '../../src/constants/moods';
import { EditorTimeline } from '../../src/components/editor/EditorTimeline';
import { PreviewPlayer } from '../../src/components/editor/PreviewPlayer';
import { ClipEditor } from '../../src/components/editor/ClipEditor';
import { TextEditor } from '../../src/components/editor/TextEditor';
import { FilterEditor } from '../../src/components/editor/FilterEditor';
import { ExportModal } from '../../src/components/editor/ExportModal';
import type { ClipItem, TextOverlay, FilterOverlay } from '../../src/types/project';

const CLIP_COLORS = ['#fb7185', '#a78bfa', '#00d9a3', '#fbbf24', '#38bdf8', '#f472b6', '#34d399', '#c084fc'];

function getEffective(c: ClipItem): number {
  return Math.round((c.durationMs / 1000) * (c.trimEndPct - c.trimStartPct) / 100);
}

export default function EditorScreen() {
  const { date } = useLocalSearchParams<{ date: string }>();
  const router = useRouter();
  const { entries } = useEntries(date);
  const habits = useHabits();
  const { project, save, updateClips, updateTextOverlays, updateFilterOverlays } = useProject(date, entries);

  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [selectedFilterId, setSelectedFilterId] = useState<string | null>(null);
  const [playheadPos, setPlayheadPos] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [addingClip, setAddingClip] = useState(false);
  const [addingText, setAddingText] = useState(false);
  const [addingFilter, setAddingFilter] = useState(false);
  const [newCaption, setNewCaption] = useState('');
  const [newTextContent, setNewTextContent] = useState('');
  const [exporting, setExporting] = useState(false);
  const playRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

  const clips = project?.clips ?? [];
  const textOverlays = project?.textOverlays ?? [];
  const filterOverlays = project?.filterOverlays ?? [];

  const totalDurationSec = clips.reduce((sum, c) => sum + getEffective(c), 0);

  const clearSelections = () => {
    setSelectedClipId(null);
    setSelectedTextId(null);
    setSelectedFilterId(null);
  };

  // Playhead animation
  useEffect(() => {
    if (isPlaying && totalDurationSec > 0) {
      const start = Date.now();
      const startPos = playheadPos;
      const remaining = 1 - startPos;
      const durationMs = remaining * totalDurationSec * 200;
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

  // Find current clip at playhead
  const getCurrentClipAtPlayhead = (): ClipItem | null => {
    if (totalDurationSec === 0) return null;
    let acc = 0;
    for (const c of clips) {
      const w = getEffective(c) / totalDurationSec;
      if (playheadPos < acc + w) return c;
      acc += w;
    }
    return clips[clips.length - 1] ?? null;
  };

  const playheadPct = playheadPos * 100;
  const visibleTexts = textOverlays.filter(t => playheadPct >= t.startPct && playheadPct <= t.endPct);
  const visibleFilter = filterOverlays.find(f => playheadPct >= f.startPct && playheadPct <= f.endPct) ?? null;
  const currentClip = getCurrentClipAtPlayhead();

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
    const idx = clips.findIndex(c => c.id === id);
    if (idx < 0) return;
    const ni = idx + dir;
    if (ni < 0 || ni >= clips.length) return;
    const next = [...clips];
    [next[idx], next[ni]] = [next[ni], next[idx]];
    updateClips(next);
  };

  const deleteClip = (id: string) => {
    updateClips(clips.filter(c => c.id !== id));
    if (selectedClipId === id) setSelectedClipId(null);
  };

  const updateClip = (id: string, updates: Partial<ClipItem>) => {
    updateClips(clips.map(c => c.id === id ? { ...c, ...updates } : c));
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

  // Text overlay operations
  const addTextOverlay = () => {
    if (!newTextContent.trim()) return;
    const newT: TextOverlay = {
      id: generateId('txt'),
      text: newTextContent.trim(),
      startPct: Math.round(playheadPos * 100),
      endPct: Math.min(100, Math.round(playheadPos * 100) + 25),
      fontSize: 20,
      fontWeight: 400,
      color: '#ffffff',
    };
    updateTextOverlays([...textOverlays, newT]);
    setNewTextContent('');
    setAddingText(false);
    clearSelections();
    setSelectedTextId(newT.id);
  };

  const updateText = (id: string, updates: Partial<TextOverlay>) => {
    updateTextOverlays(textOverlays.map(t => t.id === id ? { ...t, ...updates } : t));
  };

  const deleteText = (id: string) => {
    updateTextOverlays(textOverlays.filter(t => t.id !== id));
    if (selectedTextId === id) setSelectedTextId(null);
  };

  // Filter overlay operations
  const addFilterOverlay = (filterId: string) => {
    const f = FILTERS.find(x => x.id === filterId) ?? FILTERS[0];
    const newF: FilterOverlay = {
      id: generateId('fx'),
      filterId: f.id,
      startPct: Math.round(playheadPos * 100),
      endPct: Math.min(100, Math.round(playheadPos * 100) + 30),
      brightness: f.brightness,
      contrast: f.contrast,
      saturate: f.saturate,
    };
    updateFilterOverlays([...filterOverlays, newF]);
    setAddingFilter(false);
    clearSelections();
    setSelectedFilterId(newF.id);
  };

  const updateFilter = (id: string, updates: Partial<FilterOverlay>) => {
    updateFilterOverlays(filterOverlays.map(f => f.id === id ? { ...f, ...updates } : f));
  };

  const deleteFilter = (id: string) => {
    updateFilterOverlays(filterOverlays.filter(f => f.id !== id));
    if (selectedFilterId === id) setSelectedFilterId(null);
  };

  const handleSaveDraft = async () => {
    await save({ clips, textOverlays, filterOverlays });
    router.back();
  };

  const handleExportComplete = useCallback(async () => {
    // Create vlog entry
    const videoEntries = entries.filter(e => e.type === 'video');
    const habitsLogged = [...new Set(entries.filter(e => e.type === 'habit').flatMap(e => e.habits))];
    const moods = entries.map(e => e.mood).filter(Boolean);
    const cats = [...new Set(entries.map(e => e.category).filter(Boolean))];
    const topMood = moods.length ? moods[moods.length - 1] : 'calm';

    await insertVlog({
      id: generateId('vlog'),
      date,
      clipCount: clips.length,
      habitCount: habitsLogged.length,
      mood: topMood,
      caption: `${entries.length} moments captured today.`,
      categories: cats as string[],
      durationSeconds: totalDurationSec,
      exportUri: null,
      createdAt: new Date().toISOString(),
    });

    await save({ clips, textOverlays, filterOverlays, status: 'exported' });
    setExporting(false);
    router.replace('/');
  }, [entries, clips, textOverlays, filterOverlays, date, totalDurationSec]);

  const selectedClip = clips.find(c => c.id === selectedClipId);
  const selectedText = textOverlays.find(t => t.id === selectedTextId);
  const selectedFilter = filterOverlays.find(f => f.id === selectedFilterId);

  return (
    <View style={styles.container}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()}>
          <Text style={styles.backText}>← BACK</Text>
        </Pressable>
        <Text style={styles.title}>Vlog Editor</Text>
        <View style={{ width: 48 }} />
      </View>

      {/* Preview */}
      <PreviewPlayer
        currentClip={currentClip}
        visibleTexts={visibleTexts}
        visibleFilter={visibleFilter}
        selectedTextId={selectedTextId}
        onSelectText={id => { clearSelections(); setSelectedTextId(id === selectedTextId ? null : id); }}
      />

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
        <Text style={styles.clipCount}>{clips.length} clips</Text>
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
        onSelectText={id => { clearSelections(); setSelectedTextId(id === selectedTextId ? null : id); }}
        onSelectFilter={id => { clearSelections(); setSelectedFilterId(id === selectedFilterId ? null : id); }}
        onAddClip={() => setAddingClip(true)}
        onAddText={() => { setAddingText(true); clearSelections(); }}
        onAddFilter={() => { setAddingFilter(true); clearSelections(); }}
        onTimelinePress={pct => setPlayheadPos(pct)}
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
        {addingText && (
          <View style={[styles.addPanel, { borderColor: 'rgba(251,191,36,0.2)', backgroundColor: 'rgba(251,191,36,0.06)' }]}>
            <Text style={[styles.addLabel, { color: colors.amber }]}>ADD TEXT OVERLAY</Text>
            <TextInput
              value={newTextContent}
              onChangeText={setNewTextContent}
              placeholder="Your text..."
              placeholderTextColor={colors.textDimmer}
              autoFocus
              style={[styles.addInput, { fontFamily: fonts.heading }]}
            />
            <View style={styles.addBtnRow}>
              <Pressable onPress={() => { setAddingText(false); setNewTextContent(''); }} style={styles.cancelBtn}>
                <Text style={styles.cancelBtnText}>CANCEL</Text>
              </Pressable>
              <Pressable onPress={addTextOverlay} style={[styles.confirmBtn, { backgroundColor: newTextContent.trim() ? colors.amber : 'rgba(255,255,255,0.05)' }]}>
                <Text style={[styles.confirmBtnText, { color: newTextContent.trim() ? colors.bg : colors.textDimmer }]}>ADD TEXT</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* Add filter picker */}
        {addingFilter && (
          <View style={[styles.addPanel, { borderColor: 'rgba(167,139,250,0.2)', backgroundColor: 'rgba(167,139,250,0.06)' }]}>
            <Text style={[styles.addLabel, { color: colors.purple }]}>ADD FILTER OVERLAY</Text>
            <View style={styles.filterGrid}>
              {FILTERS.filter(f => f.id !== 'none').map(f => (
                <Pressable key={f.id} onPress={() => addFilterOverlay(f.id)} style={[styles.filterBtn, { backgroundColor: `${f.color}10`, borderColor: `${f.color}30` }]}>
                  <View style={[styles.filterSwatch, { backgroundColor: `${f.color}40`, borderColor: `${f.color}40` }]} />
                  <Text style={[styles.filterBtnLabel, { color: f.color }]}>{f.label}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable onPress={() => setAddingFilter(false)} style={styles.cancelBtn}>
              <Text style={styles.cancelBtnText}>CANCEL</Text>
            </Pressable>
          </View>
        )}

        {/* Selected clip editor */}
        {selectedClip && (
          <ClipEditor
            clip={selectedClip}
            onUpdate={updates => updateClip(selectedClip.id, updates)}
            onMoveLeft={() => moveClip(selectedClip.id, -1)}
            onMoveRight={() => moveClip(selectedClip.id, 1)}
            onDelete={() => deleteClip(selectedClip.id)}
          />
        )}

        {/* Selected text editor */}
        {selectedText && (
          <TextEditor
            overlay={selectedText}
            totalDurationSec={totalDurationSec}
            onUpdate={updates => updateText(selectedText.id, updates)}
            onDelete={() => deleteText(selectedText.id)}
          />
        )}

        {/* Selected filter editor */}
        {selectedFilter && (
          <FilterEditor
            overlay={selectedFilter}
            totalDurationSec={totalDurationSec}
            onUpdate={updates => updateFilter(selectedFilter.id, updates)}
            onDelete={() => deleteFilter(selectedFilter.id)}
          />
        )}

        {clips.length === 0 && !addingClip && !addingText && !selectedText && (
          <Text style={styles.emptyText}>No clips in your vlog yet. Tap + on the timeline to add.</Text>
        )}
      </ScrollView>

      {/* Bottom bar */}
      <View style={styles.bottomBar}>
        <Pressable onPress={handleSaveDraft} style={styles.draftBtn}>
          <Text style={styles.draftBtnText}>SAVE DRAFT</Text>
        </Pressable>
        <Pressable
          onPress={() => clips.length > 0 && setExporting(true)}
          style={[styles.exportBtn, { backgroundColor: clips.length > 0 ? colors.teal : 'rgba(255,255,255,0.05)' }]}
        >
          <Text style={[styles.exportBtnText, { color: clips.length > 0 ? colors.bg : colors.textDimmer }]}>EXPORT & CLOSE</Text>
        </Pressable>
      </View>

      {/* Export modal */}
      <ExportModal
        visible={exporting}
        clipCount={clips.length}
        textCount={textOverlays.length}
        filterCount={filterOverlays.length}
        onComplete={handleExportComplete}
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
    borderRadius: 14,
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
  filterGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  filterBtn: {
    flex: 1,
    minWidth: '28%',
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    gap: 4,
  },
  filterSwatch: {
    width: 28,
    height: 28,
    borderRadius: 7,
    borderWidth: 1,
  },
  filterBtnLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.4,
  },
  emptyText: {
    textAlign: 'center',
    paddingVertical: 28,
    paddingHorizontal: 16,
    color: colors.textDim,
    fontFamily: fonts.body,
    fontSize: 13,
  },
  bottomBar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 36,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
    backgroundColor: 'rgba(0,0,0,0.95)',
    flexDirection: 'row',
    gap: 10,
  },
  draftBtn: {
    flex: 1,
    paddingVertical: 13,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    alignItems: 'center',
  },
  draftBtnText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
    letterSpacing: 0.6,
  },
  exportBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
  },
  exportBtnText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
});
