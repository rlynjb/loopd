export const CATEGORIES = [
  { id: 'coding', label: 'Coding', emoji: '💻' },
  { id: 'gym', label: 'Gym', emoji: '🏋️' },
  { id: 'food', label: 'Food', emoji: '🍱' },
  { id: 'social', label: 'Social', emoji: '👥' },
  { id: 'solo', label: 'Solo', emoji: '🧠' },
  { id: 'errand', label: 'Errand', emoji: '🛒' },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]['id'];
