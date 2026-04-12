export type ClipRef = {
  uri: string;
  durationMs: number;
};

export type TodoItem = {
  id: string;
  text: string;
  done: boolean;
  completedAt: string | null;
};

export type Entry = {
  id: string;
  date: string;
  text: string | null;
  habits: string[];
  todos: TodoItem[];
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
  caption: string | null;
  durationSeconds: number;
  exportUri: string | null;
  createdAt: string;
};
