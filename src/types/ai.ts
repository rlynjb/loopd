export type CaptionTheme = 'growth' | 'discipline' | 'clarity' | 'struggle' | 'shift' | 'curiosity';

// Input shape for the relatable caption generator (see
// docs/relatable-caption-spec.md). Built from a day's entries + recent
// ai_summaries before the LLM call.
export type CaptionInput = {
  date: string;
  rawLog: string[];                  // bullet list of tasks/actions/ideas
  recentCaptions?: string[];         // last 3–5 captions for tonal continuity & anti-repetition
  mood?: string;                     // optional self-reported mood/state
  themeHint?: CaptionTheme | null;
};

// Four-variant tonal caption set. Same day, same content, different voice
// per spec docs/loopd-caption-variants-plan.md. The user picks which
// variant to publish via chips in the editor TEXT tab.
export type CaptionVariantKey = 'clean' | 'smoother' | 'reflective' | 'punchy';

export const CAPTION_VARIANT_KEYS: CaptionVariantKey[] = [
  'clean', 'smoother', 'reflective', 'punchy',
];

// Output of the new 4-variant caption generator. Each value is the
// 3-line body for that variant; the day-title prefix is added by the
// editor at render time.
export type CaptionVariantOutput = {
  variants: Record<CaptionVariantKey, string>;
  detectedTheme: string;
};

// Legacy 2-variant output retained for type round-trip on old cached rows.
// New code should not write this shape; reads fall through to it when
// `variants` is absent on an AISummary.
export type CaptionOutput = {
  caption: string;
  alternate: string;
  detectedTheme: string;
};

// Per-day journal interpretation — see docs/interpret-spec.md.
// User-triggered from the journal page; cached on ai_summaries.summary_json
// so the modal opens instantly on revisits and the result round-trips
// through cloud sync uniformly with the rest of the AISummary.
//
// `sourceText` snapshots the day's combined entry text at generation time
// so the modal can flag staleness when the user has typed since.
export type Interpretation = {
  mainInterpretation: string;
  coreThemes: { label: string; explanation: string }[];
  emotionalPattern: string;
  healthyReframe: string;
  keyTakeaway: string;
  sourceText: string;
  generatedAt: string;
  model: string;
};

export type AISummary = {
  headline: string;
  summary: string;
  mood: 'flat' | 'ok' | 'good' | 'great' | 'fired';
  clipOrder: string[];
  clipTrims: { id: string; startMs: number; endMs: number }[];
  textOverlays: {
    text: string;
    startPct: number;
    endPct: number;
    position: 'top' | 'center' | 'bottom';
  }[];
  filterPreset: 'none' | 'moody' | 'cool' | 'film' | 'muted';

  // Legacy 2-variant relatable-caption fields (added 2026-05-02, deprecated
  // 2026-05-05). Read for backward-compat on cached rows; not written by
  // current code. Older rows that still carry these will render as a
  // 3-chip group (PRIMARY / ALT / SUMMARY) in the editor; the next
  // regenerate upgrades to the 4-variant set below.
  caption?: string;
  captionAlternate?: string;
  captionTheme?: string;

  // 4-variant tonal caption set (added 2026-05-05). Optional because older
  // cached rows pre-date this. New `variantsTheme` field is preferred
  // over the legacy `captionTheme` but readers should fall back.
  variants?: Record<CaptionVariantKey, string>;
  variantsTheme?: string;

  // Optional interpretation cached on the day's AI summary row. Generated
  // separately from the editor compose pass — populated on demand when the
  // user taps Interpret on the journal page.
  interpret?: Interpretation;

  generatedAt: string;
};
