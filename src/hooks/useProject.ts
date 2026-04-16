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

        // Single text overlay with day title as default
        const title = dayTitleRef.current;
        const textOverlays: TextOverlay[] = [{
          id: generateId('txt'),
          text: title?.trim() ?? '',
          startPct: 0,
          endPct: 100,
          fontSize: 13,
          fontWeight: 500,
          color: '#ffffff',
          position: 'bottom',
          textAlign: 'center',
        }];

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
        // Merge new clips into existing project
        const currentEntries = entriesRef.current;
        const videoEntries = currentEntries.filter(e => e.clips.length > 0);
        const knownClipKeys = new Set(existing.clips.map(c => `${c.entryId}:${c.clipUri}`));
        let clipIndex = existing.clips.length;
        const newClips: ClipItem[] = [];
        for (const e of videoEntries) {
          const entryClips = e.clips && e.clips.length > 0
            ? e.clips
            : e.clipUri ? [{ uri: e.clipUri, durationMs: e.clipDurationMs ?? 10000 }] : [];
          for (const c of entryClips) {
            const key = `${e.id}:${c.uri}`;
            if (knownClipKeys.has(key)) continue;
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

        // Remove clips whose source entries no longer have that clip URI
        const allEntryClipUris = new Set(
          currentEntries.flatMap(e => e.clips.map(c => c.uri))
        );
        if (currentEntries.length > 0) {
          const validClips = existing.clips.filter(c => allEntryClipUris.has(c.clipUri));
          if (validClips.length !== existing.clips.length) {
            existing = { ...existing, clips: validClips };
          }
        }

        // Always ensure exactly one text overlay
        const title = dayTitleRef.current;
        const keepText = existing.textOverlays[0]?.text || title?.trim() || '';
        existing = {
          ...existing,
          textOverlays: [{
            id: existing.textOverlays[0]?.id || generateId('txt'),
            text: keepText,
            startPct: 0,
            endPct: 100,
            fontSize: existing.textOverlays[0]?.fontSize || 13,
            fontWeight: 500,
            color: '#ffffff',
            position: existing.textOverlays[0]?.position || 'bottom',
            textAlign: 'center',
          }],
        };
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
  // Also handles entries that gained additional clips since last save
  useEffect(() => {
    setProject(prev => {
      if (!prev) return prev;
      const videoEntries = entries.filter(e => e.clips.length > 0);
      // Track known clips by entryId + URI combo to detect new clips within existing entries
      const knownClipKeys = new Set(prev.clips.map(c => `${c.entryId}:${c.clipUri}`));
      let clipIndex = prev.clips.length;
      const newClips: ClipItem[] = [];
      for (const e of videoEntries) {
        const entryClips = e.clips && e.clips.length > 0
          ? e.clips
          : e.clipUri ? [{ uri: e.clipUri, durationMs: e.clipDurationMs ?? 10000 }] : [];
        for (const c of entryClips) {
          const key = `${e.id}:${c.uri}`;
          if (knownClipKeys.has(key)) continue;
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
