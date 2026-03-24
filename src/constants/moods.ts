import type { IconName } from '../components/ui/Icon';

export const MOODS = [
  { id: 'calm', label: 'Calm', icon: 'smile' as IconName, color: '#4caf7d' },
  { id: 'chaotic', label: 'Chaotic', icon: 'frown' as IconName, color: '#e05555' },
  { id: 'focused', label: 'Focused', icon: 'target' as IconName, color: '#c4a96a' },
  { id: 'energized', label: 'Energized', icon: 'zap' as IconName, color: '#d4922a' },
] as const;

export type MoodId = (typeof MOODS)[number]['id'];
