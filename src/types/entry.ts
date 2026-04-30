export type ClipRef = {
  uri: string;
  durationMs: number;
};

export type TodoItem = {
  id: string;
  text: string;
  done: boolean;
  completedAt: string | null;
  // Optional on older todos that pre-date the field; falls back to the source
  // entry's createdAt when ranking.
  createdAt?: string;
  // 0-indexed line in the source entry's text where this todo was last
  // scanned from. Used by the scanner's two-pass matching to survive text
  // edits that change the content of a "[]" line in place.
  sourceLine?: number;
  // Set after the todo has been pushed to Notion as a standalone row.
  // Unset means "never pushed yet" — push path will create a new page.
  notionPageId?: string | null;
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

export type CadenceType = 'daily' | 'weekdays' | 'weekly' | 'specific_days' | 'n_per_week';

// Time-of-day bucket. Sort order on the dashboard:
// morning → midday → evening → anytime. "anytime" is the default catch-all.
export type TimeOfDay = 'morning' | 'midday' | 'evening' | 'anytime';

export type Habit = {
  id: string;
  label: string;
  sortOrder: number;
  // Cadence + metadata (added 2026-04-29). All optional on the type so existing
  // call sites that construct minimal Habit objects keep compiling; the DB
  // layer fills sensible defaults (cadence_type='daily', time_of_day='anytime').
  slug?: string | null;
  icon?: string | null;
  color?: string | null;
  cadenceType?: CadenceType;
  cadenceDays?: number[] | null;
  cadenceCount?: number | null;
  timeOfDay?: TimeOfDay;
  notionPageId?: string | null;
  notionLastSynced?: string | null;
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
