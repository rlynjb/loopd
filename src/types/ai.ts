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

// Output of the caption generator. `caption` is the primary 2–4 line
// reflective caption that becomes the vlog's text overlay; `alternate`
// is a shorter 2-line variant the user can swap to from the editor.
export type CaptionOutput = {
  caption: string;
  alternate: string;
  detectedTheme: string;
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
  // Relatable-caption fields (added 2026-05-02). Optional so older
  // ai_summaries cached before this feature shipped keep parsing.
  caption?: string;
  captionAlternate?: string;
  captionTheme?: string;
  generatedAt: string;
};
