import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorProject, ClipItem, TextOverlay, FilterOverlay } from '../types/project';
import type { Entry } from '../types/entry';
import { getProjectByDate, upsertProject } from '../services/database';
import { generateId } from '../utils/id';

const CLIP_COLORS = ['#fb7185', '#a78bfa', '#00d9a3', '#fbbf24', '#38bdf8', '#f472b6', '#34d399', '#c084fc'];
const AUTO_SAVE_DELAY = 1000;

export function useProject(date: string, entries: Entry[]) {
  const [project, setProject] = useState<EditorProject | null>(null);
  const [loading, setLoading] = useState(true);
  const projectRef = useRef(project);
  projectRef.current = project;
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadDone = useRef(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      let existing = await getProjectByDate(date);
      if (!existing) {
        const videoEntries = entries.filter(e => e.type === 'video');
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

        existing = {
          id: generateId('proj'),
          date,
          status: 'draft',
          clips,
          textOverlays: [],
          filterOverlays: [],
          exportUri: null,
          updatedAt: new Date().toISOString(),
        };
      }
      setProject(existing);
      setLoading(false);
      // Mark initial load done after a tick so auto-save doesn't fire immediately
      setTimeout(() => { initialLoadDone.current = true; }, 100);
    })();

    return () => {
      // Save on unmount if there are pending changes
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current);
        const current = projectRef.current;
        if (current) {
          upsertProject({ ...current, updatedAt: new Date().toISOString() });
        }
      }
    };
  }, [date, entries]);

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
