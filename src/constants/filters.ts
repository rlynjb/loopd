export const FILTERS = [
  { id: 'none', label: 'None', brightness: 100, contrast: 100, saturate: 100, tint: null, tintOpacity: 0, color: '#94a3b8' },
  { id: 'moody', label: 'Moody', brightness: 90, contrast: 120, saturate: 75, tint: '#1a0a2e', tintOpacity: 0.2, color: '#a78bfa' },
  { id: 'cool', label: 'Cool', brightness: 100, contrast: 112, saturate: 85, tint: '#001a3a', tintOpacity: 0.15, color: '#38bdf8' },
  { id: 'film', label: 'Film', brightness: 95, contrast: 92, saturate: 80, tint: '#2a1a0a', tintOpacity: 0.15, color: '#d4a574' },
  { id: 'muted', label: 'Muted', brightness: 100, contrast: 105, saturate: 40, tint: '#1a1a1a', tintOpacity: 0.1, color: '#9ca3af' },
] as const;

export type FilterId = (typeof FILTERS)[number]['id'];
