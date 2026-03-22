export const FILTERS = [
  { id: 'none', label: 'None', brightness: 100, contrast: 100, saturate: 100, color: '#94a3b8' },
  { id: 'vivid', label: 'Vivid', brightness: 105, contrast: 115, saturate: 140, color: '#fb7185' },
  { id: 'moody', label: 'Moody', brightness: 85, contrast: 120, saturate: 70, color: '#a78bfa' },
  { id: 'warm', label: 'Warm', brightness: 105, contrast: 105, saturate: 120, color: '#fbbf24' },
  { id: 'cool', label: 'Cool', brightness: 100, contrast: 110, saturate: 80, color: '#38bdf8' },
  { id: 'noir', label: 'Noir', brightness: 110, contrast: 130, saturate: 0, color: '#e2e8f0' },
] as const;

export type FilterId = (typeof FILTERS)[number]['id'];
