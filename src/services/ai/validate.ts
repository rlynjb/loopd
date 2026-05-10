import {
  CAPTION_VARIANT_KEYS,
  type AISummary,
  type CaptionVariantKey,
  type Interpretation,
} from '../../types/ai';

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

  // Preserve caption-related fields if present on the parsed object. The
  // summarize() chain populates these in a second LLM call AFTER
  // validateSummary runs, so on a fresh summary path they're undefined
  // here and added downstream. On a cached re-parse (editor re-validates a
  // previously-saved summary on load) both shapes round-trip:
  //   - Legacy 2-variant fields (caption / captionAlternate / captionTheme)
  //   - New 4-variant block (variants / variantsTheme)
  const caption = typeof obj.caption === 'string' ? obj.caption : undefined;
  const captionAlternate = typeof obj.captionAlternate === 'string' ? obj.captionAlternate : undefined;
  const captionTheme = typeof obj.captionTheme === 'string' ? obj.captionTheme : undefined;

  let variants: Record<CaptionVariantKey, string> | undefined;
  if (obj.variants && typeof obj.variants === 'object') {
    const raw = obj.variants as Record<string, unknown>;
    const built: Partial<Record<CaptionVariantKey, string>> = {};
    for (const key of CAPTION_VARIANT_KEYS) {
      if (typeof raw[key] === 'string' && raw[key]) built[key] = raw[key] as string;
    }
    // Only round-trip if all four keys are present — partial sets are
    // treated as malformed and dropped (the editor falls back to legacy).
    if (CAPTION_VARIANT_KEYS.every(k => typeof built[k] === 'string')) {
      variants = built as Record<CaptionVariantKey, string>;
    }
  }
  const variantsTheme = typeof obj.variantsTheme === 'string' ? obj.variantsTheme : undefined;

  // Round-trip the cached Interpretation if present. Required string fields
  // must be non-empty; coreThemes must be a 1+ array of {label, explanation}
  // objects. Anything malformed gets dropped (treated as no cache) so the
  // modal will offer a fresh Interpret on next open.
  let interpret: Interpretation | undefined;
  if (obj.interpret && typeof obj.interpret === 'object') {
    const i = obj.interpret as Record<string, unknown>;
    const requiredStr = (k: string): string | null =>
      typeof i[k] === 'string' && (i[k] as string).trim() ? (i[k] as string) : null;
    const main = requiredStr('mainInterpretation');
    const pattern = requiredStr('emotionalPattern');
    const reframe = requiredStr('healthyReframe');
    const takeaway = requiredStr('keyTakeaway');
    const generatedAt = typeof i.generatedAt === 'string' ? i.generatedAt : null;
    let coreThemes: Interpretation['coreThemes'] | null = null;
    if (Array.isArray(i.coreThemes)) {
      coreThemes = (i.coreThemes as unknown[])
        .filter((t): t is { label: string; explanation: string } => {
          if (!t || typeof t !== 'object') return false;
          const o = t as Record<string, unknown>;
          return typeof o.label === 'string' && typeof o.explanation === 'string';
        })
        .map(t => ({ label: t.label.trim(), explanation: t.explanation.trim() }));
      if (coreThemes.length === 0) coreThemes = null;
    }
    if (main && pattern && reframe && takeaway && generatedAt && coreThemes) {
      interpret = {
        mainInterpretation: main,
        coreThemes,
        emotionalPattern: pattern,
        healthyReframe: reframe,
        keyTakeaway: takeaway,
        sourceText: typeof i.sourceText === 'string' ? i.sourceText : '',
        generatedAt,
        model: typeof i.model === 'string' ? i.model : '',
      };
    }
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
      caption,
      captionAlternate,
      captionTheme,
      variants,
      variantsTheme,
      interpret,
      generatedAt: new Date().toISOString(),
    },
    errors,
  };
}
