import type { AISummary } from '../../types/ai';

const VALID_MOODS = ['flat', 'ok', 'good', 'great', 'fired'];
const VALID_FILTERS = ['none', 'moody', 'cool', 'film', 'muted'];
const VALID_POSITIONS = ['top', 'center', 'bottom'];

export function validateSummary(
  raw: unknown,
  clipIds: Set<string>,
  clipDurations: Map<string, number>,
): { valid: boolean; summary: AISummary; errors: string[] } {
  const errors: string[] = [];
  const obj = raw as Record<string, unknown>;

  const headline = typeof obj.headline === 'string' ? obj.headline.slice(0, 100) : 'My day';
  const summary = typeof obj.summary === 'string' ? obj.summary.slice(0, 500) : '';
  const mood = VALID_MOODS.includes(obj.mood as string) ? (obj.mood as AISummary['mood']) : 'ok';
  const filterPreset = VALID_FILTERS.includes(obj.filterPreset as string) ? (obj.filterPreset as AISummary['filterPreset']) : 'none';

  // Validate clipOrder — only keep known IDs
  let clipOrder: string[] = [];
  if (Array.isArray(obj.clipOrder)) {
    clipOrder = obj.clipOrder.filter((id): id is string => typeof id === 'string' && clipIds.has(id));
    if (clipOrder.length !== (obj.clipOrder as unknown[]).length) {
      errors.push('Some clipOrder IDs were invalid');
    }
  }
  // Add any missing clips at the end
  for (const id of clipIds) {
    if (!clipOrder.includes(id)) clipOrder.push(id);
  }

  // Validate clipTrims — clamp to duration bounds
  let clipTrims: AISummary['clipTrims'] = [];
  if (Array.isArray(obj.clipTrims)) {
    clipTrims = (obj.clipTrims as unknown[]).filter((t): t is { id: string; startMs: number; endMs: number } => {
      if (!t || typeof t !== 'object') return false;
      const o = t as Record<string, unknown>;
      return typeof o.id === 'string' && typeof o.startMs === 'number' && typeof o.endMs === 'number';
    }).map(t => {
      const dur = clipDurations.get(t.id) ?? 10000;
      return {
        id: t.id,
        startMs: Math.max(0, Math.min(dur, t.startMs)),
        endMs: Math.max(0, Math.min(dur, Math.max(t.startMs + 500, t.endMs))),
      };
    });
  }

  // Validate textOverlays
  let textOverlays: AISummary['textOverlays'] = [];
  if (Array.isArray(obj.textOverlays)) {
    textOverlays = (obj.textOverlays as unknown[]).slice(0, 4).filter((t): t is AISummary['textOverlays'][number] => {
      if (!t || typeof t !== 'object') return false;
      const o = t as Record<string, unknown>;
      return typeof o.text === 'string';
    }).map(t => ({
      text: t.text.slice(0, 60),
      startPct: typeof t.startPct === 'number' ? Math.max(0, Math.min(100, t.startPct)) : 0,
      endPct: typeof t.endPct === 'number' ? Math.max(0, Math.min(100, t.endPct)) : 100,
      position: VALID_POSITIONS.includes(t.position) ? t.position : 'bottom',
    }));
  }

  return {
    valid: errors.length === 0,
    summary: {
      headline,
      summary,
      mood,
      clipOrder,
      clipTrims,
      textOverlays,
      filterPreset,
      generatedAt: new Date().toISOString(),
    },
    errors,
  };
}
