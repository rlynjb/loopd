import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorProject, ClipItem, TextOverlay, FilterOverlay } from '../types/project';
import type { Entry } from '../types/entry';
import { getProjectByDate, upsertProject } from '../services/database';
import { FILTERS } from '../constants/filters';
import { generateId } from '../utils/id';

const CLIP_COLORS = ['#fb7185', '#a78bfa', '#00d9a3', '#fbbf24', '#38bdf8', '#f472b6', '#34d399', '#c084fc'];
const AUTO_SAVE_DELAY = 1000;

function logProjectDebug(message: string, details?: Record<string, unknown>) {
  if (!__DEV__) return;
  if (details) {
    console.log(`[useProject] ${message}`, details);
    return;
  }
  console.log(`[useProject] ${message}`);
}

function normalizeClipUri(uri: string): string {
  const clean = uri.replace(/^file:\/\//, '');
  const parts = clean.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? clean;
}

function getClipSourceKey(entryId: string, clipUri: string): string {
  return `${entryId}:${normalizeClipUri(clipUri)}`;
}

function getExactClipKey(clip: ClipItem): string {
  return `${getClipSourceKey(clip.entryId, clip.clipUri)}:${clip.trimStartPct}:${clip.trimEndPct}`;
}

function buildClipsFromEntries(entries: Entry[], startIndex: number): ClipItem[] {
  const videoEntries = entries.filter(e => e.clips.length > 0 || !!e.clipUri);
  const clips: ClipItem[] = [];
  let clipIndex = startIndex;

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

  return clips;
}

function dedupeExactClips(clips: ClipItem[]): ClipItem[] {
  const seen = new Set<string>();
  const deduped: ClipItem[] = [];

  for (const clip of clips) {
    const key = getExactClipKey(clip);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(clip);
  }

  return deduped.map((clip, index) => ({
    ...clip,
    order: index,
    color: clip.color || CLIP_COLORS[index % CLIP_COLORS.length],
  }));
}

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
        const clips = buildClipsFromEntries(currentEntries, 0);

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
          position: 'center',
          textAlign: 'center',
        }];

        existing = {
          id: generateId('proj'),
          date,
          status: 'draft',
          clips,
          removedClipSourceKeys: [],
          textOverlays,
          filterOverlays: (() => {
            const film = FILTERS.find(f => f.id === 'film');
            return film ? [{
              id: generateId('fx'),
              filterId: 'film',
              startPct: 0,
              endPct: 100,
              brightness: film.brightness,
              contrast: film.contrast,
              saturate: film.saturate,
            }] : [];
          })(),
          exportUri: null,
          updatedAt: new Date().toISOString(),
        };
        logProjectDebug('created new project from entries', {
          date,
          clipCount: existing.clips.length,
        });
      } else {
        existing = {
          ...existing,
          clips: dedupeExactClips(existing.clips),
          removedClipSourceKeys: existing.removedClipSourceKeys ?? [],
        };

        // Merge new clips — track by entryId:clipUri so split clips dedupe properly
        const currentEntries = entriesRef.current;
        const knownClipKeys = new Set(existing.clips.map(c => getClipSourceKey(c.entryId, c.clipUri)));
        const removedClipKeys = new Set(existing.removedClipSourceKeys);
        let clipIndex = existing.clips.length;
        const newClips: ClipItem[] = [];
        for (const clip of buildClipsFromEntries(currentEntries, clipIndex)) {
          const key = getClipSourceKey(clip.entryId, clip.clipUri);
          if (knownClipKeys.has(key) || removedClipKeys.has(key)) continue;
          knownClipKeys.add(key);
          newClips.push(clip);
          clipIndex++;
        }
        if (newClips.length > 0) {
          existing = { ...existing, clips: [...existing.clips, ...newClips] };
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
            position: existing.textOverlays[0]?.position || 'center',
            textAlign: 'center',
          }],
        };
        logProjectDebug('loaded existing project', {
          date,
          clipCount: existing.clips.length,
          removedClipSourceKeyCount: existing.removedClipSourceKeys.length,
          mergedClipCount: newClips.length,
        });
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

  // Merge new clips from entries. Track by entryId:clipUri so:
  // - Split clips (same entryId:clipUri, multiple project clips) count as "already present"
  // - Multi-clip entries (different URIs) each get tracked separately
  useEffect(() => {
    setProject(prev => {
      if (!prev) return prev;
      const dedupedPrevClips = dedupeExactClips(prev.clips);
      const knownClipKeys = new Set(dedupedPrevClips.map(c => getClipSourceKey(c.entryId, c.clipUri)));
      const removedClipKeys = new Set(prev.removedClipSourceKeys ?? []);
      let clipIndex = dedupedPrevClips.length;
      const newClips: ClipItem[] = [];
      for (const clip of buildClipsFromEntries(entries, clipIndex)) {
        const key = getClipSourceKey(clip.entryId, clip.clipUri);
        if (knownClipKeys.has(key) || removedClipKeys.has(key)) continue;
        knownClipKeys.add(key);
        newClips.push(clip);
        clipIndex++;
      }
      if (newClips.length > 0) {
        logProjectDebug('merged new clips from entries', {
          date,
          existingClipCount: dedupedPrevClips.length,
          mergedClipCount: newClips.length,
          removedClipSourceKeyCount: prev.removedClipSourceKeys?.length ?? 0,
        });
      }
      if (newClips.length === 0 && dedupedPrevClips.length === prev.clips.length) return prev;
      return { ...prev, clips: [...dedupedPrevClips, ...newClips] };
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

  const removeClip = useCallback((id: string) => {
    setProject(prev => {
      if (!prev) return null;
      const clip = prev.clips.find(c => c.id === id);
      if (!clip) return prev;
      const sourceKey = getClipSourceKey(clip.entryId, clip.clipUri);
      logProjectDebug('removed clip from project', {
        date: prev.date,
        clipId: id,
        sourceKey,
      });
      return {
        ...prev,
        clips: prev.clips.filter(c => c.id !== id),
        removedClipSourceKeys: prev.removedClipSourceKeys.includes(sourceKey)
          ? prev.removedClipSourceKeys
          : [...prev.removedClipSourceKeys, sourceKey],
      };
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
    removeClip,
    updateTextOverlays,
    updateFilterOverlays,
  };
}
