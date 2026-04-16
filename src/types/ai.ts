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
  generatedAt: string;
};
