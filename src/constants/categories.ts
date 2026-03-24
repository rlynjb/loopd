import type { IconName } from '../components/ui/Icon';

export const CATEGORIES = [
  { id: 'coding', label: 'Coding', icon: 'code' as IconName },
  { id: 'gym', label: 'Gym', icon: 'dumbbell' as IconName },
  { id: 'food', label: 'Food', icon: 'utensils' as IconName },
  { id: 'social', label: 'Social', icon: 'users' as IconName },
  { id: 'solo', label: 'Solo', icon: 'user' as IconName },
  { id: 'errand', label: 'Errand', icon: 'shoppingCart' as IconName },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]['id'];
