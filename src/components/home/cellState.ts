// Pure cell-state engine for the Daily Schedule weekly grid.
// See docs/loopd-daily-schedule-grid-spec.md §2.6.
//
// Maps (habit, cell date, today, checkedDates) → one of five visual states.
// No DB reads, no side effects — easy to test in isolation, easy to reuse
// from past-week views (just pass a different `today` reference).

import type { Habit } from '../../types/entry';
import { isDueOn } from '../../services/habits/cadence';

export type CellState = 'done' | 'pending' | 'upcoming' | 'missed' | 'off-day';

/**
 * Compute the cell state for one habit on one calendar day.
 *
 * Decision order (first match wins):
 *   1. checkedDates.has(dateStr)  → 'done'
 *      (a check-in always wins over cadence — users can mark a habit done
 *       on an off-day, and we honor that signal.)
 *   2. !isDueOn(habit, date)      → 'off-day'
 *   3. dateStr === todayStr       → 'pending'
 *   4. dateStr > todayStr         → 'upcoming'
 *   5. dateStr < todayStr         → 'missed'
 *
 * `dateStr` is the YYYY-MM-DD string for the cell. `todayStr` is the same
 * format. Past-week views pass a `todayStr` that's outside the rendered
 * week — every cell ends up as 'done' / 'missed' / 'off-day' (never
 * 'pending' or 'upcoming'), which is the spec's read-only past-week shape.
 */
export function cellStateFor(
  habit: Habit,
  dateStr: string,
  todayStr: string,
  checkedDates: ReadonlySet<string>,
): CellState {
  if (checkedDates.has(dateStr)) return 'done';
  // Cadence check needs a Date; build one at noon-local to avoid TZ edge cases.
  const date = new Date(dateStr + 'T12:00:00');
  if (!isDueOn(habit, date)) return 'off-day';
  if (dateStr === todayStr) return 'pending';
  if (dateStr > todayStr) return 'upcoming';
  return 'missed';
}

/**
 * Cell state for a thread row. Threads don't have a weekday schedule the way
 * habits do — they have a target_cadence_days "aspiration" plus a binary
 * touched/not-touched signal per day. So the state space collapses to three:
 *
 *   - 'done'    when the user manually touched the thread on this date
 *   - 'pending' when this is today and there's no touch yet
 *   - 'off-day' for every other day (past or future, untouched)
 *
 * The 'off-day' visual reads as "empty/inactive" which matches threads'
 * non-scheduled nature. Today's cell stays interactive even when 'off-day'
 * resolves to invisible-with-mode='hidden' — but that's a UI concern handled
 * by the grid, not this function.
 */
export function cellStateForThread(
  touchedDates: ReadonlySet<string>,
  dateStr: string,
  todayStr: string,
): CellState {
  if (touchedDates.has(dateStr)) return 'done';
  if (dateStr === todayStr) return 'pending';
  return 'off-day';
}
