export const FILTERS = [
  { id: 'none', label: 'None', brightness: 100, contrast: 100, saturate: 100, tint: null, tintOpacity: 0, color: '#94a3b8' },
  { id: 'vivid', label: 'Vivid', brightness: 108, contrast: 118, saturate: 145, tint: null, tintOpacity: 0, color: '#fb7185' },
  { id: 'moody', label: 'Moody', brightness: 90, contrast: 120, saturate: 75, tint: '#1a0a2e', tintOpacity: 0.2, color: '#a78bfa' },
  { id: 'warm', label: 'Warm', brightness: 105, contrast: 108, saturate: 120, tint: '#4a2800', tintOpacity: 0.15, color: '#fbbf24' },
  { id: 'cool', label: 'Cool', brightness: 100, contrast: 112, saturate: 85, tint: '#001a3a', tintOpacity: 0.15, color: '#38bdf8' },
  { id: 'noir', label: 'Noir', brightness: 110, contrast: 130, saturate: 0, tint: null, tintOpacity: 0, color: '#e2e8f0' },
  { id: 'golden', label: 'Golden', brightness: 108, contrast: 105, saturate: 130, tint: '#3d2800', tintOpacity: 0.12, color: '#f59e0b' },
  { id: 'film', label: 'Film', brightness: 95, contrast: 92, saturate: 80, tint: '#2a1a0a', tintOpacity: 0.15, color: '#d4a574' },
  { id: 'dreamy', label: 'Dreamy', brightness: 112, contrast: 88, saturate: 90, tint: '#1a0020', tintOpacity: 0.1, color: '#f0abfc' },
  { id: 'bold', label: 'Bold', brightness: 102, contrast: 135, saturate: 135, tint: null, tintOpacity: 0, color: '#ef4444' },
  { id: 'muted', label: 'Muted', brightness: 100, contrast: 105, saturate: 40, tint: '#1a1a1a', tintOpacity: 0.1, color: '#9ca3af' },
  { id: 'sunset', label: 'Sunset', brightness: 95, contrast: 115, saturate: 130, tint: '#3a1500', tintOpacity: 0.18, color: '#f97316' },
  { id: 'clean', label: 'Clean', brightness: 108, contrast: 110, saturate: 108, tint: null, tintOpacity: 0, color: '#6ee7b7' },
] as const;

export type FilterId = (typeof FILTERS)[number]['id'];
