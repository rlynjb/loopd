import type { IconName } from '../components/ui/Icon';

export const CAPTURE_TYPES = [
  { id: 'video', label: 'Clip', icon: 'video' as IconName, color: '#e05555' },
  { id: 'journal', label: 'Journal', icon: 'penLine' as IconName, color: '#4caf7d' },
  { id: 'habit', label: 'Habit', icon: 'checkSquare' as IconName, color: '#c46fd4' },
] as const;

export const DEFAULT_HABITS = [
  { id: 'workout', label: 'Workout', icon: 'dumbbell' as IconName },
  { id: 'study', label: 'Study', icon: 'bookOpen' as IconName },
  { id: 'vlog', label: 'Vlog', icon: 'clapperboard' as IconName },
  { id: 'meditate', label: 'Meditate', icon: 'feather' as IconName },
  { id: 'read', label: 'Read', icon: 'bookMarked' as IconName },
] as const;
