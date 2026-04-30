import type { Habit } from '../../types/entry';

// Pure cadence engine. No DB reads, no side effects.
//
// Day numbering: 0=Sun ... 6=Sat (matches Date.prototype.getDay).
// Week boundary: ISO week (Monday-start). The n_per_week branch defers
// "have we hit the target?" to the caller, which has access to check-in
// history; this module just answers "is the schedule asking for it?"

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// Returns the YYYY-MM-DD string for the Monday of the ISO week containing
// `date`. Local time, not UTC — matches how the rest of the app stores dates.
export function startOfISOWeek(date: Date): string {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  // Sunday (0) is the *last* day of the ISO week, so offset = -6.
  const offset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

// Given an ISO date string (YYYY-MM-DD), returns the YYYY-MM-DD string of
// that week's Monday. Convenience wrapper for callers that already have a string.
export function startOfISOWeekStr(dateStr: string): string {
  return startOfISOWeek(new Date(dateStr + 'T12:00:00'));
}

// Returns an array of YYYY-MM-DD strings for the 7 days of the ISO week
// containing `date`, Monday through Sunday.
export function isoWeekDates(date: Date): string[] {
  const monday = new Date(startOfISOWeek(date) + 'T12:00:00');
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Schedule-only: is this habit "potentially due" on `date`?
// For n_per_week, returns true any day of the week — the caller must use
// needsMoreThisWeek() to decide whether to surface it.
export function isDueOn(habit: Habit, date: Date): boolean {
  const day = date.getDay();
  switch (habit.cadenceType ?? 'daily') {
    case 'daily':
      return true;
    case 'weekdays':
      return day >= 1 && day <= 5;
    case 'weekly':
      return habit.cadenceDays?.[0] === day;
    case 'specific_days':
      return habit.cadenceDays?.includes(day) ?? false;
    case 'n_per_week':
      // Schedule alone says "any day this week is fair game". History decides.
      return true;
    default:
      return false;
  }
}

// History-aware: for an n_per_week habit, has the user already hit the target
// this week? `weekCheckInDates` is the set of distinct YYYY-MM-DD strings
// within the current ISO week where the habit was logged.
//
// Returns true if more check-ins are still needed; false if the target is met.
// For non-n_per_week cadences, returns isDueOn semantics (no history needed).
export function needsMoreThisWeek(habit: Habit, weekCheckInDates: string[]): boolean {
  if ((habit.cadenceType ?? 'daily') !== 'n_per_week') return false;
  const target = habit.cadenceCount ?? 0;
  if (target <= 0) return false;
  const distinct = new Set(weekCheckInDates).size;
  return distinct < target;
}

// Convenience: combined "should this habit appear as due-today on the Today
// view" check that handles all cadence types in one call.
//
// `weekCheckInDates` is only consulted for n_per_week. Pass an empty array
// for non-n_per_week habits if you don't have the data.
export function isDueToday(
  habit: Habit,
  date: Date,
  weekCheckInDates: string[] = [],
): boolean {
  if (!isDueOn(habit, date)) return false;
  if ((habit.cadenceType ?? 'daily') === 'n_per_week') {
    return needsMoreThisWeek(habit, weekCheckInDates);
  }
  return true;
}

// Human-readable cadence summary for the CRUD list ("M/W/F", "daily", etc).
const DAY_ABBREV = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function summarizeCadence(habit: Habit): string {
  switch (habit.cadenceType ?? 'daily') {
    case 'daily':
      return 'daily';
    case 'weekdays':
      return 'weekdays';
    case 'weekly':
      return habit.cadenceDays?.[0] != null
        ? DAY_ABBREV[habit.cadenceDays[0]] + 's'
        : 'weekly';
    case 'specific_days': {
      const days = habit.cadenceDays ?? [];
      if (days.length === 0) return 'no days';
      // Sort Mon-first for display
      const order = [1, 2, 3, 4, 5, 6, 0];
      return order
        .filter(d => days.includes(d))
        .map(d => DAY_SHORT[d])
        .join('/');
    }
    case 'n_per_week':
      return `${habit.cadenceCount ?? 0}x/week`;
    default:
      return 'daily';
  }
}
