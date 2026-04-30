import type { Habit } from '../../types/entry';
import { isDueOn, startOfISOWeekStr, isoWeekDates } from './cadence';

// Cadence-aware streak math.
//
// Rules (per spec § 4.4):
//   - A streak counts due-days only.
//   - A due-day with no check-in breaks the streak.
//   - A non-due-day neither extends nor breaks the streak.
//   - For n_per_week: streak counts completed weeks (per plan decision #4).
//     A "completed week" means cadenceCount distinct check-in dates within
//     that ISO week. The current week is "in progress" — not counted toward
//     the streak until it closes (Monday rolls over).

export type CellState = 'completed' | 'missed' | 'neutral' | 'today-pending';

// Per-cell state for the heatmap. `checked` is whether this date is in the
// habit's check-in set. `today` is the YYYY-MM-DD string for today.
export function getCellState(
  habit: Habit,
  date: Date,
  checked: boolean,
  todayStr: string,
): CellState {
  const iso = toISO(date);
  if (!isDueOn(habit, date)) return 'neutral';
  if (checked) return 'completed';
  // Today not yet logged but still due is its own state — caller renders an
  // outline rather than a "missed" red.
  if (iso === todayStr) return 'today-pending';
  // Future days: treat as neutral (we don't show "missed" for tomorrow).
  if (iso > todayStr) return 'neutral';
  return 'missed';
}

// Current streak ending at `today`. For non-n_per_week cadences, walks
// backward through dates, counting due-days that were checked, stopping at
// the first due-day that wasn't.
//
// The "today not yet logged" case is handled gracefully: if today is due and
// not logged, the streak is computed up to *yesterday*. That matches user
// expectation — a 5-day streak yesterday should still read as 5 today, not
// drop to 0 just because the user hasn't logged yet.
export function computeStreak(
  habit: Habit,
  todayStr: string,
  checkedDates: Set<string>,
): number {
  if ((habit.cadenceType ?? 'daily') === 'n_per_week') {
    return computeWeeklyStreak(habit, todayStr, checkedDates);
  }

  // Walk backwards from today, but if today is due-and-unlogged, start from
  // yesterday so an in-progress day doesn't reset the streak.
  let cursor = new Date(todayStr + 'T12:00:00');
  if (isDueOn(habit, cursor) && !checkedDates.has(toISO(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }

  let streak = 0;
  // Hard cap at ~3 years to avoid pathological loops.
  for (let i = 0; i < 365 * 3; i++) {
    if (!isDueOn(habit, cursor)) {
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }
    if (checkedDates.has(toISO(cursor))) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

// Streak counted in completed-weeks for n_per_week cadences. A week is
// "completed" if at least cadenceCount distinct check-ins fell within its
// ISO Mon-Sun bounds. Walks backwards from the prior week (current week is
// always in-progress and not counted).
function computeWeeklyStreak(
  habit: Habit,
  todayStr: string,
  checkedDates: Set<string>,
): number {
  const target = habit.cadenceCount ?? 0;
  if (target <= 0) return 0;

  // Start at the Monday of the *previous* week.
  let cursor = new Date(startOfISOWeekStr(todayStr) + 'T12:00:00');
  cursor.setDate(cursor.getDate() - 7);

  let streak = 0;
  for (let i = 0; i < 156; i++) { // ~3 years
    const weekDates = isoWeekDates(cursor);
    const hits = weekDates.filter(d => checkedDates.has(d)).length;
    if (hits >= target) {
      streak++;
      cursor.setDate(cursor.getDate() - 7);
    } else {
      break;
    }
  }
  return streak;
}

// Build a habitId → Set<YYYY-MM-DD> map from a list of entries. Reusable
// across the dashboard heatmap and the Today view's anchors section.
export function buildCheckInsByHabit(
  entries: { date: string; habits: string[] }[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const hid of entry.habits) {
      let set = map.get(hid);
      if (!set) {
        set = new Set<string>();
        map.set(hid, set);
      }
      set.add(entry.date);
    }
  }
  return map;
}

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}
