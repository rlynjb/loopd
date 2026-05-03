import {
  getDatabase, getThreads, getLastMentionByThread, getAllTodoMetas, getAllEntries,
} from '../database';
import { computeStaleness, differenceInDays } from './staleness';
import type { Thread, ThreadCard } from '../../types/thread';
import type { TodoMeta, TodoType } from '../../types/todoMeta';

// Aggregate the data for the Today view's threads section in a single pass:
//   - all non-archived threads
//   - last mention timestamp per thread
//   - count of distinct entries this week per thread
//   - open-todo count per thread (joining thread_mentions.todo_id ↔ todo_meta)
//   - top 3 recent open todos per thread
//
// Returned cards are sorted: pinned DESC, then staleness order, then
// lastMentionAt DESC.
export async function getThreadCards(now: Date = new Date()): Promise<ThreadCard[]> {
  const threads = await getThreads(false);
  if (threads.length === 0) return [];

  const lastMentionMap = await getLastMentionByThread();

  // Build per-thread aggregates in one DB hit.
  const db = await getDatabase();

  // 14-day activity strip: distinct entry_dates within the last 14 days
  // where the thread was MANUALLY touched (tap on the dashboard row).
  // Prose-derived #tag mentions in entries/todos are deliberately excluded
  // from the strip — per user direction, only manual taps mark a day done.
  // Those rows are identified by entry_id IS NULL AND todo_id IS NULL,
  // which is the exact shape toggleThreadTouchToday writes.
  const activityCutoff = (() => {
    const d = new Date(now);
    d.setDate(d.getDate() - 14);
    return d.toISOString().slice(0, 10);
  })();
  type ActivityRow = { thread_id: string; entry_date: string };
  const activityRows = await db.getAllAsync<ActivityRow>(
    `SELECT DISTINCT thread_id, entry_date
     FROM thread_mentions
     WHERE entry_date >= ?
       AND entry_id IS NULL
       AND todo_id IS NULL
       AND deleted_at IS NULL`,
    [activityCutoff],
  );
  const activeDatesByThread = new Map<string, Set<string>>();
  for (const r of activityRows) {
    let set = activeDatesByThread.get(r.thread_id);
    if (!set) { set = new Set(); activeDatesByThread.set(r.thread_id, set); }
    set.add(r.entry_date);
  }

  // Entries this week — distinct entry_ids per thread within ISO week.
  const weekStartISO = startOfISOWeek(now);
  type WeekRow = { thread_id: string; cnt: number };
  const weekRows = await db.getAllAsync<WeekRow>(
    `SELECT thread_id, COUNT(DISTINCT entry_id) AS cnt
     FROM thread_mentions
     WHERE entry_id IS NOT NULL AND entry_date >= ? AND deleted_at IS NULL
     GROUP BY thread_id`,
    [weekStartISO],
  );
  const entriesThisWeekMap = new Map(weekRows.map(r => [r.thread_id, r.cnt]));

  // Distinct todo IDs mentioned per thread (so we can join to todo_meta).
  type TodoLinkRow = { thread_id: string; todo_id: string };
  const todoLinkRows = await db.getAllAsync<TodoLinkRow>(
    `SELECT DISTINCT thread_id, todo_id FROM thread_mentions WHERE todo_id IS NOT NULL AND deleted_at IS NULL`,
  );
  const todoIdsByThread = new Map<string, Set<string>>();
  for (const r of todoLinkRows) {
    let set = todoIdsByThread.get(r.thread_id);
    if (!set) { set = new Set(); todoIdsByThread.set(r.thread_id, set); }
    set.add(r.todo_id);
  }

  // Lookup tables for resolving todo IDs → text + type.
  const allMetas = await getAllTodoMetas();
  const metaById = new Map<string, TodoMeta>(allMetas.map(m => [m.todoId, m]));
  const allEntries = await getAllEntries();
  const todoTextById = new Map<string, { text: string; done: boolean; createdAt: string }>();
  for (const e of allEntries) {
    for (const t of e.todos ?? []) {
      todoTextById.set(t.id, {
        text: t.text,
        done: t.done,
        createdAt: t.createdAt ?? e.createdAt,
      });
    }
  }

  const cards: ThreadCard[] = threads.map(thread => {
    const lastAt = lastMentionMap.get(thread.id) ?? null;
    const days = lastAt ? differenceInDays(now, new Date(lastAt)) : null;
    const staleness = computeStaleness(thread, lastAt, now);
    const linkedTodoIds = todoIdsByThread.get(thread.id) ?? new Set<string>();

    let openTodos = 0;
    const recentCandidates: Array<{ todoId: string; text: string; type: TodoType; createdAt: string }> = [];
    for (const tid of linkedTodoIds) {
      const meta = metaById.get(tid);
      const todo = todoTextById.get(tid);
      if (!meta || !todo) continue;
      if (todo.done) continue;
      openTodos++;
      recentCandidates.push({
        todoId: tid,
        text: todo.text,
        type: meta.type,
        createdAt: todo.createdAt,
      });
    }
    recentCandidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const recentTodos = recentCandidates.slice(0, 3).map(({ todoId, text, type }) => ({
      todoId, text, type,
    }));

    return {
      thread,
      lastMentionAt: lastAt,
      daysSinceLast: days,
      staleness,
      entriesThisWeek: entriesThisWeekMap.get(thread.id) ?? 0,
      openTodos,
      recentTodos,
      activeDates: activeDatesByThread.get(thread.id) ?? new Set<string>(),
    };
  });

  return sortCards(cards);
}

const STALENESS_RANK: Record<ThreadCard['staleness'], number> = {
  fresh: 0,
  aging: 1,
  stale: 2,
  cold: 3,
};

function sortCards(cards: ThreadCard[]): ThreadCard[] {
  return cards.slice().sort((a, b) => {
    // Pinned threads always first.
    if (a.thread.pinned !== b.thread.pinned) return a.thread.pinned ? -1 : 1;
    // Then by staleness (fresh first).
    if (a.staleness !== b.staleness) {
      return STALENESS_RANK[a.staleness] - STALENESS_RANK[b.staleness];
    }
    // Within same staleness, most-recently-mentioned first. Null sorts last.
    if (a.lastMentionAt && b.lastMentionAt) {
      return b.lastMentionAt.localeCompare(a.lastMentionAt);
    }
    if (a.lastMentionAt) return -1;
    if (b.lastMentionAt) return 1;
    return a.thread.name.localeCompare(b.thread.name);
  });
}

// Local helper duplicated from cadence engine to avoid importing UI-flavored
// helpers here. Returns YYYY-MM-DD of the Monday in `date`'s ISO week.
function startOfISOWeek(date: Date): string {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}
