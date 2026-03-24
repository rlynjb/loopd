export type EntryType = 'video' | 'journal' | 'habit';

export type ClipRef = {
  uri: string;
  durationMs: number;
};

export type Entry = {
  id: string;
  date: string;
  type: EntryType;
  text: string | null;
  mood: string | null;
  category: string | null;
  habits: string[];
  clipUri: string | null;
  clipDurationMs: number | null;
  clips: ClipRef[];
  createdAt: string;
  notionPageId?: string | null;
  updatedAt?: string | null;
};

export type Habit = {
  id: string;
  label: string;
  emoji: string;
  sortOrder: number;
  notionPageId?: string | null;
  updatedAt?: string | null;
};

export type Vlog = {
  id: string;
  date: string;
  clipCount: number;
  habitCount: number;
  mood: string | null;
  caption: string | null;
  categories: string[];
  durationSeconds: number;
  exportUri: string | null;
  createdAt: string;
};
