# buffr — Daily Schedule Grid Implementation Plan

Working plan for executing [`buffr-daily-schedule-grid-spec.md`](./buffr-daily-schedule-grid-spec.md). The spec covers *what* and *why*; this doc covers *in what order, with what checkpoints, and what to confirm before starting.*

The spec is small (~12–17h total) because it's a pure view-layer redesign — same `habits` table, same cadence engine, same streak math. No data migration. The plan reflects that: 8 milestones, mostly thin, with two checkpoints and a list of confirm-first decisions.

---

## 0. Confirm-first — open questions from the spec

Three decisions need answers before I start building. Each comes from a spec section that explicitly asks for confirmation.

### Q1 — Threads in the daily schedule (spec §13)

The current dashboard's `DAILY SCHEDULE` renders habits AND threads in one combined section. This patch redesigns the **habits half**. Three options for threads:

- **(a) Keep threads' 14-cell strip below the new habits grid** — two visually distinct sections under one header. Easiest ship; mixed visual language.
- **(b) Threads get the same weekly grid treatment** — requires extending the cadence engine for threads (real work).
- **(c) Threads move out of the dashboard entirely** — cleaner, but loses the at-a-glance "did I touch buffr today" signal.

**Recommendation: (a) for v1.** Ship the habits redesign without expanding scope. (b) is a follow-up; (c) is a separate product call.

### Q2 — Archived habits in past weeks (spec §14)

A habit archived mid-week has historical check-ins in the visible week. Default per spec §14: archived habits are not rendered, even on past-week views, so they vanish from the grid the moment they're archived. **Confirm or override.**

### Q3 — Today-tint on past weeks (spec §14)

Past weeks have no "today." Default per spec §14: drop the today-tint entirely when `?week=` is set; no column is highlighted. **Confirm.**

### Q4 — `manage →` link target (spec §14)

Currently routes to `/more/habits`. Spec §14 wonders whether it should deep-link somewhere richer. **Default: keep as `/more/habits` for v1.**

Once these are answered, the rest is mechanical execution.

---

## 1. Snapshot — what's currently in tree

Verified 2026-05-04 against the spec's modified-files list:

| Path | Status | Action |
|---|---|---|
| [`app/index.tsx`](../app/index.tsx) lines 237–299 | Present — combined habits + threads strip | Replace habits half; keep threads (per Q1 default) |
| [`src/components/home/HabitHeatmapRow.tsx`](../src/components/home/HabitHeatmapRow.tsx) | Present — 14-cell trailing strip per habit | Mark deprecated; delete in follow-up |
| `src/components/home/DailyScheduleGrid.tsx` | **Does not exist** | New |
| `src/components/home/DailyScheduleHeader.tsx` | **Does not exist** | New |
| `src/components/home/OffDayToggle.tsx` | **Does not exist** | New |
| [`src/services/habits/cadence.ts`](../src/services/habits/cadence.ts) | Present — `isDueOn`, `summarizeCadence` | No change |
| [`src/services/habits/streaks.ts`](../src/services/habits/streaks.ts) | Present | No change |
| `ThreadHeatmapRow` (inline in `app/index.tsx` ~line 326) | Present | Move below new grid (per Q1 default), no behaviour change |

Net new component code: ~3 files (~400 lines estimated). Net deletion: 1 file (`HabitHeatmapRow.tsx`, ~90 lines) — deferred one cycle.

---

## 2. Milestones

Each milestone leaves the app working. The spec's flat 10-step list maps to these eight milestones plus two checkpoints.

### M1 — Cell-state engine (pure function)
**Spec step:** part of 1 · **Est:** 1h · **Ships:** testable function, no UI

Pure function that turns `(habit, date, today, checkedDates)` into one of the five visual states from spec §2.6. No React, no rendering — just the cadence × check-in × time logic. Lives in `src/components/home/cellState.ts` (or as a private helper inside the grid component).

Five states from spec §2.6:
- `done` — `checkedDates.has(dateStr)`
- `pending` — `dateStr === todayStr` AND `isDueOn(habit, dateStr)` AND not done
- `upcoming` — date in future AND `isDueOn(habit, dateStr)` AND not done
- `missed` — date in past AND `isDueOn(habit, dateStr)` AND not done
- `off-day` — `!isDueOn(habit, dateStr)`

Build this first because everything else depends on it and it's trivially testable in isolation. Walk through each `cadenceType` (`daily`, `weekdays`, `weekly`, `specific_days`, `n_per_week`) by hand.

**Verify:** for a fake `M/W/F` habit with check-ins on Mon and Wed in the visible week, on Friday the grid should show: `done` Mon, `off` Tue, `done` Wed, `off` Thu, `pending` Fri (today), `off` Sat, `off` Sun.

---

### M2 — `DailyScheduleGrid.tsx` component
**Spec step:** 1 (rest) · **Est:** 3h · **Ships:** static grid renders for current week

Receives `habits: Habit[]` + `checkedDatesByHabit: Map<string, Set<string>>` + `weekStart: string` (Monday ISO) + `today: string`. Renders:
- Bucket by `time_of_day` (existing pattern — copy from `app/index.tsx:257-297`).
- For each habit row: 100px label column (name + `summarizeCadence` line), then 7 cell `<View>`s.
- Each cell consults M1's `cellStateFor()` and renders the corresponding visual.
- Tap handler on `pending` and `done` cells (today only) calls a passed-in `onToggleToday(habitId)` prop.

**Don't build yet:** week navigation, off-day toggle, past-week handling, today-tint background. Hardcode current week, current day, `faded` off-day mode. Pure cell rendering.

**Verify:** drop into `app/index.tsx` temporarily, comment out the existing strip, see all habits render with correct cell states for the current week.

---

### M3 — `DailyScheduleHeader.tsx` + week-nav URL param
**Spec steps:** 2, 5 · **Est:** 2–3h · **Ships:** can navigate weeks back through history

Component receives `weekStart` + `today` + handlers. Renders:
- `‹` / `›` arrows + "May 4 — May 10, 2026" label, all in a top row.
- Below that: 7 day-column headers (M letter + day-of-month number stacked).
- Today's column gets the cream pill on the day-of-month + the column tint background (the column tint extends through the rows, so this part needs to live as a sibling of the grid, not inside the header).

URL wiring at `app/index.tsx`: read `?week=YYYY-MM-DD` via `useLocalSearchParams`, default to current Monday, validate (must be a Monday, must not be > current week). `‹` / `›` set/clear the param via `router.setParams`. Tap label → clear param.

**Verify:** open dashboard, tap `‹`, see last week's grid in read-only mode. Tap `›` back. Tap label to return.

---

### M4 — `OffDayToggle.tsx` + SecureStore wiring
**Spec step:** 3 · **Est:** 1h · **Ships:** off-day cells visibility toggles per user preference

Two-chip segmented control at the bottom of the section. Reads/writes `daily_schedule_offday_mode` from SecureStore. Default `'faded'`. Wired into `DailyScheduleGrid` via prop so cell rendering picks up the mode.

**Verify:** toggle to `hidden`, see off-day cells go transparent (grid alignment preserved). Toggle back to `faded`, see the faint scaffolding.

---

### M5 — Replace dashboard strip + keep threads below
**Spec step:** 4 · **Est:** 1–2h · **Ships:** the new grid is live on the dashboard

Edit `app/index.tsx` lines ~237–299:
- Replace the `<HabitHeatmapRow>` loop with `<DailyScheduleGrid>` (per habit bucket, or render the whole bucketed thing inside the grid component — pick the cleaner split).
- **Keep `<ThreadHeatmapRow>` rendering as it is** (Q1 default = option (a)). Threads' 14-cell strip stays below the new habits grid, under the same `DAILY SCHEDULE` header.
- Remove the existing `habitHeaderRow` / `habitHeaderCells` / `heatmapHeaderCells` block (replaced by `DailyScheduleHeader`).
- Move `OffDayToggle` + legend below the grid but above the threads section.

`HabitHeatmapRow.tsx` is **not deleted yet**. Mark with a comment header noting deprecation; delete in a follow-up after one screen-cycle of dogfooding.

**Checkpoint:** the dashboard renders with the new habits grid + threads section + smart todos. Take a screenshot. Confirm no regression on threads side.

---

### M6 — Past-week rendering + archived habits + tap-to-edit name
**Spec steps:** 6, 7 · **Est:** 2.5h · **Ships:** read-only history, edit shortcut

Past-week handling (when `?week=` is set):
- All cells read-only — no `onToggleToday` callbacks fire.
- `pending` state never appears (no day in the past is "today").
- Today-tint on column header is dropped (Q3 default).
- All scheduled-but-not-done past cells render as `missed`.

Archived habits per Q2 default: filter `WHERE archived = 0` already happens in `getHabits()`. No extra work — archived habits stay invisible on every week, including past weeks where they had check-ins. Document this in a code comment so the call doesn't get re-litigated.

Tap-to-edit habit name: wrap the label column in `Pressable` → `router.push('/more/habits')` (no per-habit deep link exists yet; see Q4). Half-hour of work.

**Verify:** navigate to `?week=YYYY-MM-DD` for last week. See done/missed/off-day cells. No today-tint. Tap a habit name → goes to `/more/habits`.

---

### M7 — Polish: today-tint, legend, optional first-time tooltip
**Spec step:** 8 · **Est:** 1.5h · **Ships:** v1 visual polish

- Today-column tint background (current week only): `rgba(232, 213, 176, 0.03)` extending from header through every habit row. Implement as a positioned `<View>` sibling, NOT a per-cell background (cleaner alignment).
- Legend row at the bottom: 5 swatches with one-word labels (`done`, `today`, `upcoming`, `missed`, `off-day`).
- **Optional**: first-time tooltip (spec §9) anchored to the legend's off-day swatch. Gated by `daily_schedule_grid_v1_seen` SecureStore flag. Skip if you want a cleaner ship — the grid is self-explanatory enough that this is a nice-to-have.

---

### M8 — Test pass + APK build
**Spec step:** 9 · **Est:** 2–3h · **Ships:** confidence that all cadence types render correctly

Walk through each cadence type with a real habit on the device:
- `daily` → all 7 cells scheduled
- `weekdays` → Mon–Fri scheduled, Sat–Sun off
- `weekly` (e.g. Tue) → just Tue scheduled
- `specific_days` (e.g. M/W/F) → Mon/Wed/Fri scheduled
- `n_per_week` (e.g. 3×/wk) → all days scheduled (cadence engine treats every day as fair game)

Plus visual verification:
- Today's pending cell is interactive; future scheduled cells aren't.
- Past missed cells render as missed (red dashed).
- Off-day toggle flips between `faded` and `hidden`.
- Past-week nav works; arrow forward greys out at current week.
- Tap habit name → `/more/habits`.
- Tap `manage →` → `/more`.
- Tap-target ergonomics on a 380px Pixel: cell is ~29px visual but the tap zone extends ~44px (spec §4).

**Cell-aspect-ratio reality check (Q from spec §14):** verify on a real Pixel-class phone before shipping. If cells feel too cramped, fallback to label column at 88px per spec §4 mitigation.

Build a release APK after this lands; install + dogfood for a day before doing the deferred cleanup in M9.

---

### M9 — Cleanup (follow-up after dogfooding)
**Spec step:** 10 · **Est:** 0.5h · **Ships:** deletes deprecated code

After one screen-cycle (a day or two of normal use) confirms no regression:
- Delete `src/components/home/HabitHeatmapRow.tsx`
- Remove its import from `app/index.tsx`
- Delete the now-unused `heatmapHeaderCells` memoized helper in `app/index.tsx`

Single small commit. Do this in a separate PR from the M1–M8 work so the rollback path is clean if anything surfaces.

---

## 3. Risks

1. **Tap-target ergonomics on small phones.** Spec §4 estimates ~29px visual cells on a 380px frame. Android's recommendation is 48dp. Mitigation is the wrapper-padding trick (44px tap zone, 29px visual). Real-device test in M8 is the gate; if it feels cramped, fall back to 88px label column.

2. **Today-column tint implementation.** The tint extends from the column header through every habit row vertically. Easiest implementation is one absolutely-positioned `<View>` behind the grid. Alternative (per-cell background) creates alignment headaches when off-day cells go transparent.

3. **Past-week URL state vs. focus reload.** The dashboard uses `useFocusEffect(loadAll)` on every screen focus. When the user navigates back from `/more/habits` and the URL still has `?week=YYYY-MM-DD`, that focus reload should preserve the week param, not reset to current. Test in M6.

4. **Streak count removal regression.** The current dashboard shows a streak number per habit row. Some users (n=1: me) may notice the omission. Mitigation per spec §6: streaks stay computed in `streaks.ts`; if the loss is felt, surface them in `/more/habits` row stats (the spec mentions this as the long-term home).

---

## 4. Summary

8 milestones, ~12–17h total. The work is mostly rendering. The cell-state engine (M1) is the keystone — once that's right, everything else is layout. The two checkpoints (after M5 dashboard integration and M8 test pass) are where regressions would surface; both are quick to confirm.

Confirm Q1–Q4 first. Then the order is **M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8 → M9** with no skips. The aggressive cut from spec §11 ("skip the first-time tooltip") lives inside M7 — drop it if you want a tighter ship. Recommended: skip the tooltip; the design is legible without it.
