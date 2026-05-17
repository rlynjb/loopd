# buffr — Spec Patch: Daily Schedule Weekly Grid

Last updated: 2026-05-04 · revision 1

A view-layer redesign of the dashboard's `DAILY SCHEDULE` section. Replaces the trailing-14-day strip with a **7-column weekday grid** anchored to the current week. Habits are rows, weekdays are columns, cadence determines which cells are scheduled vs. off-days.

This patch modifies [`spec.md`](./spec.md) §4 (`app/index.tsx`) and §6.7 (Daily Schedule tracker). **The data layer is unchanged** — same `habits` table, same cadence engine, same streak math. Pure view-layer redesign.

---

## 1. Why this change

The existing 14-day trailing strip (per [spec.md §4](./spec.md#4-screens) and [§6.7](./spec.md#67-daily-schedule-tracker)) does three things at once: shows past completions, today's check-ins, and a glimpse of the upcoming few days. It's compact, but three frictions:

1. **Cells have no day-of-week meaning.** Monday isn't always column 2; the strip rolls forward each day. You can't read "did I do this on Wednesday" without counting cells.
2. **Cadence is invisible.** A `M/W/F` habit looks identical to a `daily` one in the strip. Off-days and missed days look the same.
3. **Past dominates the layout.** 13 of 14 cells are historical; today is one cell. The page is mostly review, not planning.

The weekly row-grid fixes all three:
- Fixed weekday columns (M / T / W / T / F / S / S). Wednesday is always column 3.
- Cadence shows up as cell *presence* — `M/W/F` rows have solid cells on Mon/Wed/Fri and faint scaffolding on Tue/Thu/Sat/Sun.
- The week split is balanced: today plus a glimpse forward, with the past visible as a navigable previous week (arrow back).

---

## 2. Layout

### 2.1 Section structure

Replaces the existing `DAILY SCHEDULE` section in [`app/index.tsx`](../app/index.tsx). New structure, top-to-bottom:

```
DAILY SCHEDULE                              manage →
─────────────────────────────────────────────────────
‹    May 4 — May 10, 2026                          ›
─────────────────────────────────────────────────────
habit                M    T    W    T    F    S    S
                     4    5    6    7    8    9   10
                    [4]
─────────────────────────────────────────────────────
morning ─────────────────────────────────────────────
Skincare — day      [✓]  [·]  [·]  [·]  [·]  [·]  [·]
daily
Workout             [ ]  [-]  [·]  [-]  [·]  [-]  [-]
M / W / F
─────────────────────────────────────────────────────
evening ─────────────────────────────────────────────
Skincare — wash     [✓]  [·]  [·]  [·]  [·]  [·]  [·]
...
─────────────────────────────────────────────────────
anytime ─────────────────────────────────────────────
...

off-days:    [ hidden ]  [ faded ]                   ← user toggle

[legend: done · today · upcoming · missed · off-day]
```

Column 1 holds habit name + cadence summary on a second line (smaller, dimmer). Columns 2–8 are day cells, fixed Monday-first. No streak column.

### 2.2 Week anchoring

**Week-of-today, Monday-first.** The visible week is the Monday-Sunday window containing today. The week boundary rolls forward at midnight on the next Monday — Monday May 11 shows May 11–17, regardless of how recently the user opened the app on Sunday.

Header navigation:
- **`‹` arrow** — previous week (read-only; past data, no cells are interactive)
- **Week label** — "May 4 — May 10, 2026"; tap to return to current week from history
- **`›` arrow** — next week (greyed if current week; tap allowed only when in past)

Future weeks beyond next-week are not navigable. The grid is "this week + history," not "this week + future planning."

### 2.3 Day-cell column header

Each of the 7 day-columns shows two stacked elements:
- **Day-of-week letter** (M / T / W / T / F / S / S), small, dim
- **Day-of-month number**, larger, more prominent

Today's column gets two visual treatments:
- The day-of-month number is rendered as a **filled circle** (cream pill, dark text) — same idiom as the existing UI's "today" badge in `HomeHeader`.
- The whole **column** gets a faint background tint (`rgba(232, 213, 176, 0.03)`) extending from the header through every habit row. Subtle but readable — at a glance the eye lands on today even before reading the date.

### 2.4 Bucket section headers

Habits are grouped by `time_of_day` (morning / midday / evening / anytime), same ordering as the existing dashboard. Between groups, a slim section header:

```
morning ─────────────────────────────────────────────
```

The header is a small italic lowercase label on the left, rule line filling the rest. **Adaptive visibility**: if only one bucket has rows, no headers render (a single `morning` divider above all rows is just visual noise). Mirrors the existing rule from `spec.md §4` ("adaptive mini-headers appear once 2+ buckets are populated").

### 2.5 Habit row

Two-line label on the left:
- **Line 1** — habit name (e.g. `Skincare — wash`), 12px, full color
- **Line 2** — cadence summary (e.g. `daily`, `M / W / F`, `5×/wk`, `tu / th`), 8.5px, uppercase, dim

The cadence summary is generated by the existing `summarizeCadence` helper in [`habits/cadence.ts`](../src/services/habits/cadence.ts). No new logic.

The label column is fixed at ~100px. Names truncate with ellipsis if longer (rare given the existing examples; users tend to write 8–18 character habit names).

### 2.6 Cell states

Five visual states. Each cell is square (aspect-ratio 1) with a 4px corner radius.

| State | Visual | Meaning | Interactivity |
|---|---|---|---|
| **done** | Solid green fill `rgba(95, 189, 128, 0.4)` + checkmark | Habit completed on this day | Tap → toggle off (only on today's cell) |
| **pending** | Outlined cream `rgba(232, 213, 176, 0.7)`, no fill | Today's cell, scheduled, not yet done | Tap → toggle done |
| **upcoming** | Dashed cream `rgba(232, 213, 176, 0.3)`, no fill | Future scheduled day | Not interactive |
| **missed** | Dashed red `rgba(226, 75, 74, 0.4)`, no fill | Past scheduled day with no check-in | Not interactive (history) |
| **off-day** | Faint solid border `rgba(232, 213, 176, 0.04)` | Habit's cadence excludes this day | Not interactive |

Past-week navigation (via `‹`) shows the same five states but no `pending` (today only exists in the current week). Past `done` cells stay solid green; past missed cells render as `missed`.

### 2.7 Off-day toggle

Below the grid, before the legend:

```
off-days:    [ hidden ]   [ faded ]
```

Two-state segmented control. Persists to SecureStore as `daily_schedule_offday_mode = 'hidden' | 'faded'`. Default is `faded`.

- **`faded`** (default) — off-day cells render the faint scaffolding border, visible but barely. The cadence shape of every habit is legible in the grid.
- **`hidden`** — off-day cells render with no border, transparent background. The cells exist (preserve grid alignment) but are invisible. Cleaner; the grid emphasizes only what's actually scheduled.

The toggle is per-user, not per-habit. (Per-habit visibility was considered and rejected — too granular for the daily-glance surface.)

### 2.8 Legend

Slim row at the bottom of the section. Five swatches with one-word labels: `done`, `today`, `upcoming`, `missed`, `off-day`. Renders unconditionally; doesn't take up much space and lowers the cognitive cost on the user's first few weeks with the new design.

---

## 3. Interactions

| Trigger | Behavior |
|---|---|
| Tap today's `pending` cell | Mark habit as done for today; cell flips to `done`. Round-trips into today entry's `habits_json` via the existing path. |
| Tap today's `done` cell | Mark undone; cell flips to `pending`. Round-trips. |
| Tap any `upcoming` cell | No-op. (Future cells aren't interactive — you can't pre-complete a habit.) |
| Tap any `missed` cell | No-op at v1. (Backfilling missed check-ins is a v1.x consideration; currently no UI surface, deliberately.) |
| Tap any `off-day` cell | No-op. |
| Tap habit name | Open habit edit sheet at `/more/habits` for that habit. Shortcut to change cadence/icon/color/etc. |
| Tap `manage →` | Navigate to `/more/habits` (existing route). |
| Tap `‹` arrow | Navigate to previous week. URL gains a `?week=YYYY-MM-DD` query param (the Monday of that week). |
| Tap `›` arrow | Forward by one week, only enabled when not in current week. |
| Tap week label | Return to current week (clear `?week=` param). |
| Long-press cell | (Reserved for v1.1 — likely "edit history" affordance for missed/done cells.) |

The `pending` → `done` toggle is the only write interaction. Read-only for everything else, including history. Matches the existing strip's behavior; no regression for the user.

---

## 4. Mobile constraints

A 380px frame minus 32px horizontal padding leaves 348px for the grid. Subtract the 100px label column and 6px × 7 cell gaps (42px). 348 − 100 − 42 = **206px for 7 cells = ~29px per cell.**

29px is a borderline tap target (Android's recommendation is 48dp; cells will be slightly smaller). Two mitigations:
- Cells are visually smaller than the tap target. The interactive area extends a few px beyond the visible cell edge using padding inside the cell wrapper. Tap zone ~44px, visual ~29px.
- Only **today's cells are tappable.** All other cells are read-only. Users only need precision tapping on a single column at a time.

If real-device testing shows the tap target is too cramped, fallback options:
- Reduce label column from 100px to 88px → cells become ~31px (small win).
- Drop the `time_of_day` cadence summary to fit name on one line, freeing the second line for something else (or for future stats). Then the label column can shrink.
- Make the bucket headers full-width banners instead of inline labels (small layout win).

The least-invasive option is probably the first. Keep the spec at 100px and revisit after dogfooding.

---

## 5. Past-week navigation

The `‹` arrow on the week-nav lets the user scroll back through history. Implementation:

- URL pattern `/(today)?week=YYYY-MM-DD` where the date is the Monday of the target week.
- No `week` param → render current week (the default).
- `week` param past → render that week, all cells read-only. The "today" treatment doesn't apply (no day in the past is "today" anymore).
- `week` param future or invalid → fall back to current week, log warning.

On past weeks:
- All `done` cells render normally.
- All scheduled-but-not-done cells render as `missed`.
- Off-day cells unchanged.
- The `pending` state never appears.
- The `›` arrow is enabled until the current week is reached.
- Tap the week label to jump back to current week.

Past-week views are **read-only** at v1. Backfill / late-check-in is out of scope for the schedule view (backfilling check-ins for missed days is a habit-tracker design problem with its own thorny questions about retroactive streaks; defer).

---

## 6. Streak count: deferred to detail surface

The existing strip shows a streak number per row on the right. The new grid removes this. Two reasons:

1. **Cell width is the binding constraint** on a 380px frame. Recovering the streak slot pushes cells to ~32px (vs. ~29px), a real ergonomic win.
2. **The cells themselves carry the streak signal.** A row of green-checkmark cells reads as "I'm on a roll" without an explicit number. The signal is qualitative but immediate.

The streak number remains in the data layer (computed by [`habits/streaks.ts`](../src/services/habits/streaks.ts)) and stays available for:
- The habit-detail page (existing `/more/habits` row + sheet) — adds a "current streak" stat line if the data isn't already there.
- A v1.1 hover/long-press tooltip on the habit name in the grid (low priority).
- Notion sync (if the optional Habits DB is configured).

This is a deliberate UX cut, not a data cut. The spec patch makes it visible-or-not; the underlying engine doesn't change.

---

## 7. Service Layer Impact

**Zero new services.** This is a pure view-layer redesign.

Files modified (rendering only):

| Path | Change |
|---|---|
| [`app/index.tsx`](../app/index.tsx) | Replace `DAILY SCHEDULE` section's strip-rendering code with the new grid component. |
| `src/components/home/DailyScheduleGrid.tsx` (new) | The 7-column grid renderer. Receives `Habit[]` + check-in data, renders rows + cells per § 2.6. |
| `src/components/home/DailyScheduleHeader.tsx` (new) | Week-nav controls + day-of-week column headers. |
| `src/components/home/OffDayToggle.tsx` (new) | Two-chip segmented control + SecureStore read/write. |
| [`src/services/habits/cadence.ts`](../src/services/habits/cadence.ts) | No change. `isDueOn` already drives off-day rendering; `summarizeCadence` already drives the cadence label. |
| [`src/services/habits/streaks.ts`](../src/services/habits/streaks.ts) | No change. Streak count is no longer rendered on the dashboard but the function stays for detail surfaces and Notion sync. |

The existing `HabitHeatmapRow.tsx` is **deprecated and removable** after this patch lands and dogfooding confirms the new grid. Don't delete in the same PR — keep one screen-cycle to confirm no regression. Mark as deprecated and remove in a follow-up.

---

## 8. SecureStore additions

| Key | Type | Default | Purpose |
|---|---|---|---|
| `daily_schedule_offday_mode` | `'hidden' \| 'faded'` | `'faded'` | Per-user toggle (§ 2.7). |
| `daily_schedule_grid_v1_seen` | `boolean` | `false` | Welcome-tooltip flag for first-time users seeing the new grid (optional; § 9). |

No backfill flags — this is a view-layer change, no derived-data migration needed.

---

## 9. First-time UX (optional)

Optional one-time tooltip the first time the new grid renders. Anchored to the legend, points at the off-day swatch:

> "Off-days are habits whose cadence skips this day. Tap **hidden** to clean up the view."

Dismissed by tap; flips `daily_schedule_grid_v1_seen = true`.

This is a small touch but matters because the new design introduces a concept (off-days) that didn't exist visually before. Optional — skip if you want a cleaner ship.

---

## 10. Architectural Principles — adherence checklist

For the reviewer, against [`spec.md §10`](./spec.md#10-architectural-principles):

| Principle | How this patch honors it |
|---|---|
| 1. DB is single source of truth | Grid reads from the same `habits` + entry `habits_json` data the existing strip reads. No new derived state. |
| 2. Prose is canonical | N/A — this is the habits surface, not a drop scanner. |
| 3. Save on keystroke; scanners on commit | N/A — no text input. |
| 4. Read DB before deleting | N/A — toggling done is an upsert, not a delete. |
| 5. Live refs in focus cleanup | N/A. |
| 6. Don't auto-delete during sync | N/A. |
| 7. Two-pass matching | N/A — habits are not derived from prose. |
| 8. Backfills SecureStore-gated | N/A — no data migration. The two new SecureStore keys are config, not gates. |
| 9. Classifier output editable, override permanent | N/A. |
| 10. Heuristic before LLM | N/A — no AI in the schedule view. |
| 11. Mentions are derived; metadata is stored | N/A. |

This patch touches view-layer only. No principles in tension; nothing to negotiate.

---

## 11. Implementation Order

| Step | What | Est. |
|---|---|---|
| 1 | Build `DailyScheduleGrid.tsx` — 7-column render, cell-state mapping, off-day handling | 3–4h |
| 2 | Build `DailyScheduleHeader.tsx` — week-nav, day-column headers, today-tint | 1–2h |
| 3 | Build `OffDayToggle.tsx` + SecureStore wiring | 1h |
| 4 | Integrate into `app/index.tsx`, replace existing strip rendering | 1–2h |
| 5 | Wire week-nav URL param (`?week=YYYY-MM-DD`) into the route | 1h |
| 6 | Past-week rendering: read-only, missed-state derivation from cadence × check-in history | 2h |
| 7 | Tap-to-edit on habit name → routes to `/more/habits/[id]` edit sheet | 0.5h |
| 8 | Polish: today-tint background, legend, optional first-time tooltip | 1–2h |
| 9 | Test pass: cadence types (daily / weekdays / weekly / specific_days / n_per_week) all render correctly; today/missed/upcoming/off-day all distinct; off-day toggle works; past-week nav works | 2–3h |
| 10 | Mark `HabitHeatmapRow.tsx` deprecated; remove in follow-up after dogfooding | 0h (note only) |

**Total: ~12–17h.**

This is a small spec because it's a small change. The data layer and service layer don't move. Everything is rendering.

---

## 12. What This Patch Does NOT Cover

- **Backfill of missed check-ins.** Past-week cells are read-only at v1. No "I forgot to mark this yesterday" affordance. Defer.
- **Habit reorder within a bucket.** Existing `sort_order` on habits is honored; no new reorder UI in the schedule view (use `/more/habits`).
- **Per-habit color rendering in cells.** All cells use the same green-for-done. Habits' `color` column is unused on this surface (it shows in the More-tab CRUD). v1.x candidate.
- **Cell hover tooltips** (e.g. "completed at 7:23 AM"). Mobile-only, no hover. Long-press tooltip is reserved for v1.1.
- **Custom week start day** (Sunday-first vs. Monday-first). Hardcoded to Monday at v1. Add user preference if needed.
- **Multi-week views** (e.g. month grid). Out of scope. The week-nav arrows give access to past weeks one at a time.
- **Threads in the schedule.** The current dashboard's schedule combines habits AND threads in the same strip (per [`spec.md` §6.7](./spec.md#67-daily-schedule-tracker)). **This patch deliberately separates them** — see § 13.

---

## 13. Threads in the daily schedule — open question

The existing `DAILY SCHEDULE` section per [`spec.md` §6.7](./spec.md#67-daily-schedule-tracker) renders habits AND threads in the same strip. Threads use a 14-cell strip driven by manual touches; habits use the cadence-aware strip.

This patch redesigns the **habits** half. **It does not specify what happens to threads.** Three options:

- **(a) Threads keep their 14-cell strip below the new habits grid.** Two visually distinct sections under one `DAILY SCHEDULE` header. Easy ship; mixed visual language.
- **(b) Threads get the same weekly grid treatment as habits.** Same 7-column structure; "manual touch" cells render as done; off-days for threads = days the thread doesn't have a `target_cadence_days`. Requires extending the cadence engine to handle threads' cadence concept (different from habits').
- **(c) Threads move out of the dashboard entirely.** The dashboard becomes habit-only; threads live exclusively on the More tab and their detail pages. Cleanest but loses the at-a-glance "did I touch buffr today" signal that the existing combined strip provides.

I'd recommend **(a)** for v1 of this patch — ship the habits redesign, leave threads alone, address the visual mismatch in a follow-up. (b) is the most consistent design but requires real cadence-engine work for threads, which expands the scope significantly. (c) is a separate product call about whether threads belong on the dashboard at all.

Confirm before building.

---

## 14. Open Questions

- **Does the `manage →` link change?** Current target is `/more/habits` (which still exists post-patch). If the habit-detail view ever hosts the streak count display we removed from the grid, the link could deep-link to a more useful screen. Default: keep as `/more/habits` for v1.
- **Does the today-column tint persist when the user navigates to a past week?** Past weeks have no "today." Default: drop the tint when `?week=` is set; no column gets highlighted.
- **What's the rendering for a habit that's `archived` but has historical check-ins in the visible week?** The grid currently renders only non-archived habits. Past weeks containing the habit's history become invisible. Default: archived habits are not rendered. If a user archives a habit mid-week they lose visibility for past days that week. Confirm.
- **Cell aspect ratio on very tall phones.** `aspect-ratio: 1` means cell height equals cell width. On a 380px-wide phone that's ~29px cells; on a 412px phone (Pixel) that's ~31px. Tablet form factors balloon. The CSS handles it cleanly but worth verifying on a real Pixel before shipping.
