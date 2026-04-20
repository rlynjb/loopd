import type { Entry, TodoItem } from '../../types/entry';

export type TodoSource = 'journal' | 'ai' | 'pinned' | 'carried';

export type RankedTodo = TodoItem & {
  entryId: string;
  entryDate: string;       // YYYY-MM-DD
  entryCreatedAt: string;  // ISO timestamp of source entry
  source: TodoSource;
};

type RankOptions = {
  today?: string;          // YYYY-MM-DD, for carried-from-yesterday detection
  includeDoneOlderThanMs?: number; // keep recently-completed todos visible briefly; default 2s
};

function effectiveCreatedAt(t: TodoItem, entryCreatedAt: string): string {
  return t.createdAt ?? entryCreatedAt;
}

// Flatten all todos from all entries and rank them so the most relevant items
// bubble to the top: pinned first, then carried-from-yesterday, then newest
// journal-origin todos, then older.
export function rankTodos(entries: Entry[], options: RankOptions = {}): RankedTodo[] {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const keepDoneMs = options.includeDoneOlderThanMs ?? 2000;
  const now = Date.now();

  const flat: RankedTodo[] = [];
  for (const entry of entries) {
    for (const todo of entry.todos ?? []) {
      // Skip todos completed long ago — SmartTodoList auto-hides them anyway.
      if (todo.done && todo.completedAt) {
        const completed = new Date(todo.completedAt).getTime();
        if (now - completed > keepDoneMs) continue;
      }
      let source: TodoSource = 'journal';
      if (todo.pinned) source = 'pinned';
      else if (!todo.done && entry.date < today) source = 'carried';
      flat.push({
        ...todo,
        entryId: entry.id,
        entryDate: entry.date,
        entryCreatedAt: entry.createdAt,
        source,
      });
    }
  }

  const priority: Record<TodoSource, number> = {
    pinned: 0,
    carried: 1,
    ai: 2,
    journal: 3,
  };

  flat.sort((a, b) => {
    // Done goes to the bottom of its group.
    if (a.done !== b.done) return a.done ? 1 : -1;
    // Then by source priority.
    if (priority[a.source] !== priority[b.source]) {
      return priority[a.source] - priority[b.source];
    }
    // Then newest first.
    const aTime = new Date(effectiveCreatedAt(a, a.entryCreatedAt)).getTime();
    const bTime = new Date(effectiveCreatedAt(b, b.entryCreatedAt)).getTime();
    return bTime - aTime;
  });

  return flat;
}

// Human-readable relative time for UI badges. "2m ago", "3h ago", "yesterday",
// "3d ago". Falls back to the ISO date string if very old.
export function formatRelativeTime(isoOrDate: string, now: Date = new Date()): string {
  const then = new Date(isoOrDate);
  const diffMs = now.getTime() - then.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return then.toISOString().slice(0, 10);
}
