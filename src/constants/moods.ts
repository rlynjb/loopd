export const MOODS = [
  { id: 'calm', label: 'Calm', emoji: '🧘', color: '#00d9a3' },
  { id: 'chaotic', label: 'Chaotic', emoji: '🌀', color: '#fb7185' },
  { id: 'focused', label: 'Focused', emoji: '🎯', color: '#a78bfa' },
  { id: 'energized', label: 'Energized', emoji: '⚡', color: '#fbbf24' },
] as const;

export type MoodId = (typeof MOODS)[number]['id'];
