import type { AISummary } from '../../types/ai';
import type { Entry } from '../../types/entry';
import type { EditorProject, ClipItem, TextOverlay, FilterOverlay } from '../../types/project';
import { FILTERS } from '../../constants/filters';
import { generateId } from '../../utils/id';

const CLIP_COLORS = ['#fb7185', '#a78bfa', '#00d9a3', '#fbbf24', '#38bdf8', '#f472b6', '#34d399', '#c084fc'];

export function autoCompose(summary: AISummary, entries: Entry[], date: string, dayTitle?: string): Partial<EditorProject> {
  // Build a map of clip-index → entry clip
  const entryClips: { entryId: string; uri: string; durationMs: number; text: string }[] = [];
  for (const e of entries) {
    for (const c of e.clips) {
      entryClips.push({ entryId: e.id, uri: c.uri, durationMs: c.durationMs, text: e.text ?? '' });
    }
  }

  // Build clips in AI-suggested order
  const clips: ClipItem[] = [];
  const usedIndices = new Set<number>();
  for (const clipId of summary.clipOrder) {
    const idx = parseInt(clipId.replace('clip-', ''), 10);
    if (isNaN(idx) || idx >= entryClips.length || usedIndices.has(idx)) continue;
    usedIndices.add(idx);
    const ec = entryClips[idx];

    // Find trim from AI
    const trim = summary.clipTrims.find(t => t.id === clipId);
    let trimStartPct = 0;
    let trimEndPct = 100;
    if (trim && ec.durationMs > 0) {
      trimStartPct = Math.max(0, Math.min(100, (trim.startMs / ec.durationMs) * 100));
      trimEndPct = Math.max(trimStartPct + 1, Math.min(100, (trim.endMs / ec.durationMs) * 100));
    }

    clips.push({
      id: generateId('clip'),
      entryId: ec.entryId,
      clipUri: ec.uri,
      caption: ec.text.slice(0, 50),
      durationMs: ec.durationMs,
      trimStartPct,
      trimEndPct,
      order: clips.length,
      color: CLIP_COLORS[clips.length % CLIP_COLORS.length],
    });
  }
  // Add any remaining clips not in AI order
  for (let i = 0; i < entryClips.length; i++) {
    if (usedIndices.has(i)) continue;
    const ec = entryClips[i];
    clips.push({
      id: generateId('clip'),
      entryId: ec.entryId,
      clipUri: ec.uri,
      caption: ec.text.slice(0, 50),
      durationMs: ec.durationMs,
      trimStartPct: 0,
      trimEndPct: 100,
      order: clips.length,
      color: CLIP_COLORS[clips.length % CLIP_COLORS.length],
    });
  }

  // Text overlay — journal title + AI summary, one sentence per line
  const title = dayTitle?.trim() ?? '';
  const sentences = summary.summary
    .replace(/([.!?])\s+/g, '$1\n')
    .trim();
  const overlayText = title
    ? `${title}\n\n${sentences}`
    : sentences;
  const textOverlays: TextOverlay[] = [{
    id: generateId('txt'),
    text: overlayText,
    startPct: 0,
    endPct: 100,
    fontSize: 13,
    fontWeight: 500,
    color: '#ffffff',
    textAlign: 'center',
    position: 'center',
  }];

  // Filter
  const filterOverlays: FilterOverlay[] = [];
  if (summary.filterPreset !== 'none') {
    const preset = FILTERS.find(f => f.id === summary.filterPreset);
    if (preset) {
      filterOverlays.push({
        id: generateId('fx'),
        filterId: preset.id,
        startPct: 0,
        endPct: 100,
        brightness: preset.brightness,
        contrast: preset.contrast,
        saturate: preset.saturate,
      });
    }
  }

  return { clips, textOverlays, filterOverlays };
}

export function fallbackCompose(entries: Entry[], date: string, dayTitle?: string): Partial<EditorProject> {
  const entryClips: { entryId: string; uri: string; durationMs: number; text: string }[] = [];
  for (const e of entries) {
    for (const c of e.clips) {
      entryClips.push({ entryId: e.id, uri: c.uri, durationMs: c.durationMs, text: e.text ?? '' });
    }
  }

  // Clips in chronological order, trimmed to middle 3 seconds
  const clips: ClipItem[] = entryClips.map((ec, i) => {
    const durSec = ec.durationMs / 1000;
    let trimStartPct = 0;
    let trimEndPct = 100;
    if (durSec > 3) {
      const centerSec = durSec / 2;
      const startSec = Math.max(0, centerSec - 1.5);
      const endSec = Math.min(durSec, centerSec + 1.5);
      trimStartPct = (startSec / durSec) * 100;
      trimEndPct = (endSec / durSec) * 100;
    }
    return {
      id: generateId('clip'),
      entryId: ec.entryId,
      clipUri: ec.uri,
      caption: ec.text.slice(0, 50),
      durationMs: ec.durationMs,
      trimStartPct,
      trimEndPct,
      order: i,
      color: CLIP_COLORS[i % CLIP_COLORS.length],
    };
  });

  const textOverlays: TextOverlay[] = [{
    id: generateId('txt'),
    text: dayTitle?.trim() ?? '',
    startPct: 0,
    endPct: 100,
    fontSize: 13,
    fontWeight: 500,
    color: '#ffffff',
    textAlign: 'center',
    position: 'center',
  }];

  const film = FILTERS.find(f => f.id === 'film');
  const filterOverlays: FilterOverlay[] = film ? [{
    id: generateId('fx'),
    filterId: 'film',
    startPct: 0,
    endPct: 100,
    brightness: film.brightness,
    contrast: film.contrast,
    saturate: film.saturate,
  }] : [];

  return { clips, textOverlays, filterOverlays };
}
