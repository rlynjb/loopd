import { useCallback, useEffect, useState } from 'react';
import type { EditorProject, ClipItem, TextOverlay, FilterOverlay } from '../types/project';
import type { Entry } from '../types/entry';
import { getProjectByDate, upsertProject } from '../services/database';
import { generateId } from '../utils/id';

const CLIP_COLORS = ['#fb7185', '#a78bfa', '#00d9a3', '#fbbf24', '#38bdf8', '#f472b6', '#34d399', '#c084fc'];

export function useProject(date: string, entries: Entry[]) {
  const [project, setProject] = useState<EditorProject | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      let existing = await getProjectByDate(date);
      if (!existing) {
        const videoEntries = entries.filter(e => e.type === 'video');
        const clips: ClipItem[] = videoEntries.map((e, i) => ({
          id: generateId('clip'),
          entryId: e.id,
          clipUri: e.clipUri ?? '',
          caption: e.text ?? '',
          durationMs: e.clipDurationMs ?? 10000,
          trimStartPct: 0,
          trimEndPct: 100,
          order: i,
          color: CLIP_COLORS[i % CLIP_COLORS.length],
        }));

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
    })();
  }, [date, entries]);

  const save = useCallback(async (updated?: Partial<EditorProject>) => {
    if (!project) return;
    const merged = { ...project, ...updated, updatedAt: new Date().toISOString() };
    await upsertProject(merged);
    setProject(merged);
  }, [project]);

  const updateClips = useCallback((clips: ClipItem[]) => {
    setProject(prev => prev ? { ...prev, clips } : null);
  }, []);

  const updateTextOverlays = useCallback((textOverlays: TextOverlay[]) => {
    setProject(prev => prev ? { ...prev, textOverlays } : null);
  }, []);

  const updateFilterOverlays = useCallback((filterOverlays: FilterOverlay[]) => {
    setProject(prev => prev ? { ...prev, filterOverlays } : null);
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
