// Threads — lightweight project-attribution metadata. Mentions are derived
// from prose at scan time (principle 11); threads themselves persist.

import type { TodoType } from './todoMeta';
import type { TimeOfDay } from './entry';

export type Staleness = 'fresh' | 'aging' | 'stale' | 'cold';

export type Thread = {
  id: string;
  name: string;
  slug: string;
  icon?: string | null;
  color?: string | null;
  // Optional user-set cadence target. If set, staleness is measured against
  // it (1× target = fresh, 2× = aging, 4× = stale, beyond = cold). Otherwise
  // the default 1/3/7-day thresholds apply.
  targetCadenceDays: number | null;
  archived: boolean;
  pinned: boolean;
  // Time-of-day bucket (mirrors habits). Sort order on the dashboard:
  // morning → midday → evening → anytime.
  timeOfDay?: TimeOfDay;
  notionPageId?: string | null;
  notionLastSynced?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ThreadMention = {
  id: string;
  threadId: string;
  // Either entryId or todoId is set (sometimes both, when the tag is on a
  // [] todo line — the scanner records both for join flexibility).
  entryId: string | null;
  entryDate: string;
  todoId: string | null;
  sourceLine: number;
  tagText: string;     // literal text as typed (case preserved): "buffr", "Buffr"
  createdAt: string;
};

// Computed view shape consumed by the Today page (Phase C). Built by
// services/threads/getThreadCards.ts.
export type ThreadCard = {
  thread: Thread;
  lastMentionAt: string | null;
  daysSinceLast: number | null;
  staleness: Staleness;
  entriesThisWeek: number;
  openTodos: number;
  recentTodos: Array<{ todoId: string; text: string; type: TodoType }>;
  // Distinct entry_dates within the last 14 days where this thread had a
  // mention. Used to render a habit-style 14-cell heatmap strip on the
  // dashboard card.
  activeDates: Set<string>;
};
