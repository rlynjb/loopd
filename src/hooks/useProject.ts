import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorProject, ClipItem, TextOverlay, FilterOverlay } from '../types/project';
import type { Entry } from '../types/entry';
import { getProjectByDate, upsertProject } from '../services/database';
import { generateId } from '../utils/id';

const CLIP_COLORS = ['#fb7185', '#a78bfa', '#00d9a3', '#fbbf24', '#38bdf8', '#f472b6', '#34d399', '#c084fc'];
const AUTO_SAVE_DELAY = 1000;

export function useProject(date: string, entries: Entry[], dayTitle?: string) {
  const [project, setProject] = useState<EditorProject | null>(null);
  const [loading, setLoading] = useState(true);
  const projectRef = useRef(project);
  projectRef.current = project;
  const dayTitleRef = useRef(dayTitle);
  dayTitleRef.current = dayTitle;
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadDone = useRef(false);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  // Load project once per date — entries are read via ref, not as a dependency
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      initialLoadDone.current = false;
      let existing = await getProjectByDate(date);
      if (cancelled) return;

      if (!existing) {
        // No project yet — wait a tick for entries to settle, then read from ref
        await new Promise(r => setTimeout(r, 300));
        if (cancelled) return;

        const currentEntries = entriesRef.current;
        const videoEntries = currentEntries.filter(e => e.clips.length > 0);
        const clips: ClipItem[] = [];
        let clipIndex = 0;
        for (const e of videoEntries) {
          const entryClips = e.clips && e.clips.length > 0
            ? e.clips
            : e.clipUri ? [{ uri: e.clipUri, durationMs: e.clipDurationMs ?? 10000 }] : [];
          for (const c of entryClips) {
            clips.push({
              id: generateId('clip'),
              entryId: e.id,
              clipUri: c.uri,
              caption: e.text ?? '',
              durationMs: c.durationMs,
              trimStartPct: 0,
              trimEndPct: 100,
              order: clipIndex,
              color: CLIP_COLORS[clipIndex % CLIP_COLORS.length],
            });
            clipIndex++;
          }
        }

        // Auto-add day title as text overlay if available
        const textOverlays: TextOverlay[] = [];
        const title = dayTitleRef.current;
        if (title && title.trim()) {
          textOverlays.push({
            id: generateId('txt'),
            text: title.trim(),
            startPct: 0,
            endPct: Math.min(20, 100),
            fontSize: 13,
            fontWeight: 700,
            color: '#ffffff',
            position: 'center',
            textAlign: 'center',
          });
        }

        existing = {
          id: generateId('proj'),
          date,
          status: 'draft',
          clips,
          textOverlays,
          filterOverlays: [],
          exportUri: null,
          updatedAt: new Date().toISOString(),
        };
      } else {
        // Merge new entries into existing project — add clips for entries not already present
        const currentEntries = entriesRef.current;
        const videoEntries = currentEntries.filter(e => e.clips.length > 0);
        const knownEntryIds = new Set(existing.clips.map(c => c.entryId));
        let clipIndex = existing.clips.length;
        const newClips: ClipItem[] = [];
        for (const e of videoEntries) {
          if (knownEntryIds.has(e.id)) continue;
          const entryClips = e.clips && e.clips.length > 0
            ? e.clips
            : e.clipUri ? [{ uri: e.clipUri, durationMs: e.clipDurationMs ?? 10000 }] : [];
          for (const c of entryClips) {
            newClips.push({
              id: generateId('clip'),
              entryId: e.id,
              clipUri: c.uri,
              caption: e.text ?? '',
              durationMs: c.durationMs,
              trimStartPct: 0,
              trimEndPct: 100,
              order: clipIndex,
              color: CLIP_COLORS[clipIndex % CLIP_COLORS.length],
            });
            clipIndex++;
          }
        }
        if (newClips.length > 0) {
          existing = { ...existing, clips: [...existing.clips, ...newClips] };
        }
      }
      if (cancelled) return;
      setProject(existing);
      setLoading(false);
      setTimeout(() => { initialLoadDone.current = true; }, 100);
    })();

    return () => {
      cancelled = true;
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current);
        const current = projectRef.current;
        if (current) {
          upsertProject({ ...current, updatedAt: new Date().toISOString() });
        }
      }
    };
  }, [date]);

  // Merge new entries into existing project when entries change
  useEffect(() => {
    setProject(prev => {
      if (!prev) return prev;
      const videoEntries = entries.filter(e => e.clips.length > 0);
      const knownEntryIds = new Set(prev.clips.map(c => c.entryId));
      let clipIndex = prev.clips.length;
      const newClips: ClipItem[] = [];
      for (const e of videoEntries) {
        if (knownEntryIds.has(e.id)) continue;
        const entryClips = e.clips && e.clips.length > 0
          ? e.clips
          : e.clipUri ? [{ uri: e.clipUri, durationMs: e.clipDurationMs ?? 10000 }] : [];
        for (const c of entryClips) {
          newClips.push({
            id: generateId('clip'),
            entryId: e.id,
            clipUri: c.uri,
            caption: e.text ?? '',
            durationMs: c.durationMs,
            trimStartPct: 0,
            trimEndPct: 100,
            order: clipIndex,
            color: CLIP_COLORS[clipIndex % CLIP_COLORS.length],
          });
          clipIndex++;
        }
      }
      if (newClips.length === 0) return prev;
      return { ...prev, clips: [...prev.clips, ...newClips] };
    });
  }, [entries]);

  // Auto-save when project changes
  useEffect(() => {
    if (!project || !initialLoadDone.current) return;

    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(async () => {
      const current = projectRef.current;
      if (current) {
        await upsertProject({ ...current, updatedAt: new Date().toISOString() });
      }
    }, AUTO_SAVE_DELAY);

    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [project]);

  const save = useCallback(async (updated?: Partial<EditorProject>) => {
    const current = projectRef.current;
    if (!current) return;
    const merged = { ...current, ...updated, updatedAt: new Date().toISOString() };
    await upsertProject(merged);
    setProject(merged);
  }, []);

  const updateClips = useCallback((updater: ClipItem[] | ((prev: ClipItem[]) => ClipItem[])) => {
    setProject(prev => {
      if (!prev) return null;
      const newClips = typeof updater === 'function' ? updater(prev.clips) : updater;
      return { ...prev, clips: newClips };
    });
  }, []);

  const updateTextOverlays = useCallback((updater: TextOverlay[] | ((prev: TextOverlay[]) => TextOverlay[])) => {
    setProject(prev => {
      if (!prev) return null;
      const newOverlays = typeof updater === 'function' ? updater(prev.textOverlays) : updater;
      return { ...prev, textOverlays: newOverlays };
    });
  }, []);

  const updateFilterOverlays = useCallback((updater: FilterOverlay[] | ((prev: FilterOverlay[]) => FilterOverlay[])) => {
    setProject(prev => {
      if (!prev) return null;
      const newOverlays = typeof updater === 'function' ? updater(prev.filterOverlays) : updater;
      return { ...prev, filterOverlays: newOverlays };
    });
  }, []);

  return {
    project,
    loading,
    save,
    updateClips,
    updateTextOverlays,
    updateFilterOverlays,
  };
}
