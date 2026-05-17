# buffr — Implementation Plan: Today, Habits Expansion, and Threads

Last updated: 2026-04-22

Companion to [`buffr-today-habits-threads-spec.md`](./buffr-today-habits-threads-spec.md). This plan slices the spec's 22-step list (§12) into four shippable phases, records the auto-approved decisions on the spec's open questions (§14), and flags architectural concerns to resolve before build.

The user instruction is "create the plan, auto-approve any decisions, don't commit and push." This document captures those decisions.

---

## 0. Auto-approved decisions (from spec §14)

These five open questions are resolved here so the build doesn't stall:

1. **Default staleness thresholds.** Accept defaults: fresh ≤1d, aging ≤3d, stale ≤7d, cold >7d. Pure heuristic; tunable later from a single constants file. Revisit after one week of dogfooding.
2. **Habit tile grid layout.** 2-column grid with vertical scroll (not horizontal scrollrow). Matches existing dashboard tile rhythm and avoids hidden content on small viewports.
3. **Slug edit re-scanning.** Option (b) — leave existing mentions in place; let the next commit-time scan reconcile against the new slug. The threads scanner already runs on every entry edit, so the migration cost is amortized across normal usage. No bulk-update path.
4. **`n_per_week` streak semantics.** Streak counts **completed weeks**: a 3x/week habit done Mon/Wed/Fri = 1 week of streak. A 3x/week habit done Mon/Tue = 0 (target not hit yet). The current week is "in progress" — shown but not counted toward streak until it closes.
5. **Tag visibility in prose.** v1: plain text in editor and read view. No clickable pills. Defer pill rendering to v1.1 once the read-view markdown renderer is touched anyway.

---

## 1. Pushbacks before build

Three concerns worth resolving up front. None are blockers; all are cheap if caught now and expensive if caught at integration time.

### 1.1 The `useEntries.editEntry` scanner chain is getting long

Today the chain is `scanTodos → scanNutrition → notion queue`. This spec adds `scanThreads` after the first two. That's three independent scanners running on every keystroke commit. Each is fast individually but they share an autosave path that's already the hottest loop in the app.

**Mitigation:** keep each scanner pure, make sure none of them do DB writes that could race with each other (they all touch different tables — todos/nutrition/thread_mentions — so this is fine in practice), and add a comment in `editEntry` documenting the order-dependency (`scanThreads` reads `todo_id`s produced by `scanTodos`).

Don't refactor into a "scanner pipeline" abstraction yet. Three scanners is not a pipeline; it's three function calls.

### 1.2 The `n_per_week` cadence engine needs week-boundary clarity

`isDueOn(habit, date)` for `n_per_week` is described in spec §4.3 as "due any day this week if not yet completed cadenceCount times." That requires reading habit check-ins for "this week" — which means defining what week.

**Decision:** week starts Monday (ISO 8601). Use `startOfISOWeek(date)` from `date-fns`. Document the choice in `cadence.ts` comments because timezone bugs in week-boundary code are a classic gotcha.

### 1.3 Six-tab bottom nav is at the limit of legibility

Five tabs is comfortable on Android. Six is the practical max before label truncation kicks in on small phones (tested visually, not formally measured). The Record button is a center FAB-style modal trigger; the other five compete for label space.

**Decision:** ship six tabs as specified. If labels truncate on the test device, swap to icon-only for Today and More (they have the most distinctive icons of the six). Don't redesign the nav for this feature.

---

## 2. Phasing

The 22-step build slices cleanly into four phases. Each phase is independently shippable — each one delivers user-facing value or sets up the next phase without leaving the app in a broken state.

```
Phase A — Habits expansion (cadence + CRUD + streaks)        ~12–16h
Phase B — Threads core (table + scanner + CRUD + autocomplete) ~14–19h
Phase C — Today view + More tab restructure                   ~8–11h
Phase D — Notion sync (habits cadence + threads bidirectional) ~9–13h
                                                       Total: ~43–59h
```

Phases A and B are independent and could ship in either order. Phase C consumes from both. Phase D is additive — the app works without it; turning it on extends Notion coverage.

### Phase A — Habits expansion

**Ships:** users can define habits with proper cadence rules, archive habits, and see cadence-aware streaks on the existing dashboard heatmap.

**Spec sections covered:** §2.1, §4, §8 (habits backfill only).

**Spec steps from §12:** 1, 3 (habit half), 4, 5, 6, 7.

| File | Action | Why |
|---|---|---|
| `src/services/database.ts` | Migration: extend `habits` with `slug, icon, color, cadence_type, cadence_days, cadence_count, archived, notion_page_id, notion_last_synced` + CHECK constraint + indexes | Schema first |
| `src/types/habit.ts` | Add `CadenceType` union and extend `Habit` interface | Source of truth for both code and the Phase D Notion mapper |
| `src/services/habits/cadence.ts` | New: pure `isDueOn(habit, date)` + `needsMoreThisWeek(habit, date)` | Engine lives in its own file so the today view can reuse it |
| `src/services/habits/streaks.ts` | New: cadence-aware streak math (replaces existing inline streak logic) | Streak counts due-days only |
| `src/services/habits/crud.ts` | New (or extend wherever habits CRUD currently lives — likely `database.ts`): create / edit / archive / delete | Standard CRUD pattern matching nutrition |
| `src/services/habits/migrate.ts` | New: SecureStore-gated `habits_cadence_backfill_v1_done` migration | Default `daily`, derive slug from name |
| `app/_layout.tsx` | Wire migrate call into boot sequence | One line, follows existing backfill pattern |
| `app/more/habits.tsx` | New: list / create / edit / archive UI | Note: this lives under `app/more/` which is created in Phase C; for Phase A standalone, ship at `app/habits.tsx` and move in Phase C |
| Existing dashboard (likely `app/index.tsx`) | Update streak/heatmap to use new streak math | Cadence-aware visuals |

**Sequencing note:** since `app/more/` doesn't exist until Phase C, the habits CRUD ships at `app/habits.tsx` first and gets moved when the More hub lands. Cheap rename, no logic change.

**Non-goals for Phase A:**
- No today view changes (Phase C).
- No Notion sync of cadence properties (Phase D).
- No threads anywhere.

### Phase B — Threads core

**Ships:** users can create threads, type `#tag` autocomplete in the editor, and see mentions persisted in `thread_mentions`. No today view yet, no Notion sync yet.

**Spec sections covered:** §2.2, §2.3, §2.4, §3, §5, §8 (threads backfill).

**Spec steps from §12:** 2, 3 (threads half), 8, 9, 10, 11, 12, 13, 14.

| File | Action | Why |
|---|---|---|
| `src/services/database.ts` | Migration: new `threads` and `thread_mentions` tables; extend `sync_deletions` CHECK to include `'thread'` | Schema first |
| `src/types/thread.ts` | New: `Thread`, `ThreadMention`, `ThreadCard` (the last is unused until Phase C but lives here for cohesion) | One file per domain |
| `src/services/threads/crud.ts` | New: create / edit / archive / pin / hard-delete; slug uniqueness enforced at insert time | Mirrors nutrition CRUD |
| `src/services/threads/scanThreads.ts` | New: regex extraction + two-pass reconcile against `thread_mentions` | Core of the feature; principle 7 |
| `src/services/threads/migrate.ts` | New: SecureStore-gated `thread_mentions_backfill_v1_done`, runs after the user's first thread is created | Lazy backfill; cheap |
| `src/hooks/useEntries.ts` | Add `scanThreads` call after `scanNutrition` in `editEntry` | One line + a comment about order dependency |
| `src/components/TagAutocomplete.tsx` | New: positioned popover, recency-sorted, inline-create option | Reuses the existing keyboard-toolbar overlay positioning logic |
| `app/editor/[date].tsx` | Wire `TagAutocomplete` to the editor's text input | Detects `#` and tracks cursor |
| `app/threads.tsx` | New: list / create / edit / archive / pin / delete (moves to `app/more/threads.tsx` in Phase C) | Same temporary-location idea as Phase A's habits page |

**Auto-approved behavior:** the autocomplete popover always shows a "+ create #foo" row at the bottom (§5.3). Tapping it inserts the tag at cursor and creates the thread row immediately. The next commit-time scan picks up the mention.

**Non-goals for Phase B:**
- No today view (Phase C).
- No Notion sync of threads (Phase D).
- No tag-mention rendering as pills in read view (deferred to v1.1 per decision #5).

### Phase C — Today view + More tab restructure

**Ships:** the new Today bottom-nav tab, the More hub, and the consolidated nav structure (Nutrition moves under More).

**Spec sections covered:** §6, §7.

**Spec steps from §12:** 15, 16, 17.

| File | Action | Why |
|---|---|---|
| `src/services/threads/staleness.ts` | New: pure `computeStaleness(thread, lastMentionAt)` | Hybrid model per §7.4 |
| `src/services/threads/getThreadCards.ts` | New: aggregate thread + last mention + entries this week + open todos | Today view consumer |
| `src/services/today/getAnchors.ts` | New: filter habits by `isDueOn(habit, today)` + check-in status | Reuses cadence engine from Phase A |
| `src/services/today/getRecentCaptures.ts` | New: top 5 recent todos (reuses logic from existing dashboard) | Same query, new caller |
| `app/today.tsx` | New: three-section layout (anchors, threads, recent captures) | The new tab |
| `app/more/index.tsx` | New: hub with stat-line links to nutrition, habits, threads, settings, notion-sync | One screen, ~30 lines |
| `app/more/habits.tsx` | Move from `app/habits.tsx` (Phase A's temp location) | Pure rename + import path updates |
| `app/more/threads.tsx` | Move from `app/threads.tsx` (Phase B's temp location) | Pure rename + import path updates |
| `app/more/nutrition.tsx` | Move from `app/nutrition.tsx` (existing) | Existing screen, new route |
| `src/components/nav/GlobalBottomNav.tsx` | Six-tab layout: Home / Record / Journal / Today / Todos / More | Per §6.1 |

**Layout decisions (auto-approved):**
- Habit tiles: 2-column vertical-scroll grid (decision #2).
- Thread cards: full-width vertical stack, ordered by `pinned DESC, staleness, lastMentionAt DESC`.
- Recent captures: reuses existing `SmartTodoList` flat-mode component.

**Non-goals for Phase C:**
- No Notion sync changes (Phase D).
- No thread detail page beyond opening the CRUD edit screen (a real detail page is v2).
- No habit reminders / push notifications.

### Phase D — Notion sync

**Ships:** habits cadence properties bidirectional, new Threads DB bidirectional, Slug-rejected-on-pull rule, manual sync triggers, guide updates.

**Spec sections covered:** §4.6, §9.

**Spec steps from §12:** 18, 19, 20, 21, 22 (test pass spans the whole feature).

| File | Action | Why |
|---|---|---|
| `src/services/notion/habitsMapper.ts` | New (or extend if exists): bidirectional mapping for `cadenceType`, `cadenceDays`, `cadenceCount`, `archived` | Schema-gap tolerance per existing pattern |
| `src/services/notion/threadsMapper.ts` | New: bidirectional mapping for threads; **slug edits in Notion rejected with warning log** | §9.2 |
| `src/services/notion/sync.ts` | Extend: existing `syncAllHabits` consumes new mapper; new `syncAllThreads` orchestrator | Mentions are NOT synced (principle 11) |
| `src/services/notion/config.ts` | Add `THREADS_DB_ID` config + storage key | Standard pattern |
| `app/_layout.tsx` | Add `syncAllThreads()` call after `syncAllHabits()` in autosync chain | One line |
| `app/settings/notion-sync.tsx` | Add Threads DB ID input, "Sync threads now", "Reset threads sync timestamp" | Mirrors existing buttons |
| `app/settings/notion-guide.tsx` | Add Threads section + cadence guidance for habits | Doc-only |

**Auto-approved behavior:**
- Mentions (`thread_mentions`) are NOT synced to Notion (spec §9.2). Derived from prose; entries/todos already sync.
- New row from Notion with no local match → create local thread, derive slug if blank, append `-1`/`-2` on collision (spec §9.3).

**Non-goals for Phase D:**
- No bulk-update of `tag_text` when slug changes in Notion — slug edits in Notion are simply rejected (§9.2 + decision #3).

---

## 3. Architectural principles — checklist

Per spec §11, plus the new principle 11. This plan honors all of them.

| Principle | Phase enforcement |
|---|---|
| 1. DB is single source of truth | Today view (C) reads `habits`, `thread_mentions`, `todo_meta` directly. No derived in-memory caches. |
| 2. Prose is canonical | `#tag` mentions (B) are derived from prose. Removing the tag deletes the mention row at next scan. |
| 3. Save on keystroke; scanners on commit | `scanThreads` (B) runs at commit alongside `scanTodos`/`scanNutrition`. Inline create from autocomplete is the documented one-off — explicit user action writes immediately. |
| 4. Read DB before deleting | Thread archive/hard-delete (B) re-fetches before mutating. Habit archive (A) likewise. |
| 5. Live refs in focus cleanup | N/A — no autosave additions. |
| 6. Don't auto-delete during sync | Threads use `sync_deletions` queue (extended in Phase B migration). |
| 7. Two-pass matching | `scanThreads` (B) implements exact reconcile + line-index fallback. |
| 8. Backfills SecureStore-gated | Three flags total: `habits_cadence_backfill_v1_done` (A), `threads_table_init_v1_done` (B, table init only), `thread_mentions_backfill_v1_done` (B, lazy after first thread). |
| 9. Classifier output editable, override permanent | N/A. |
| 10. Heuristic before LLM | N/A — no LLM in this feature. |
| **11. Mentions are derived; metadata is stored** | Phase D enforces this by NOT syncing `thread_mentions` to Notion. Threads (metadata) sync; mentions (derived) don't. |

---

## 4. Risk register

Three risks worth flagging now so the build doesn't have to discover them.

**Risk: tag autocomplete cursor positioning across keyboard states.** React Native + Expo's keyboard handling is notoriously fiddly. The popover needs to track cursor coordinates across keyboard show/hide events. Mitigation: reuse the existing keyboard-toolbar overlay's positioning logic verbatim rather than reinventing it.

**Risk: thread_mentions backfill on a heavy entries table.** A user with 1000+ entries will run a full re-scan when they create their first thread. Mitigation: backfill is non-blocking (background, with progress logs); user sees mentions populate over a few seconds. If this turns out to be slow, batch in chunks of 100 entries with `requestAnimationFrame` yields between chunks.

**Risk: Slug-rejected-on-pull confuses users with multi-device Notion edits.** A user who edits a slug in Notion sees nothing change in buffr, with no in-app feedback. Mitigation: in Phase D, surface a settings-page banner ("N slug edits rejected from Notion") that links to the threads CRUD where the user can re-rename from the buffr side.

---

## 5. Test pass (Phase D close-out — spec step 22)

Manual end-to-end on a physical Android device after Phase D ships. The grid:

| Scenario | Expected |
|---|---|
| Daily habit done 5 days in a row | Streak = 5, all 5 cells filled in heatmap |
| M/W/F habit done Mon and Wed, missed Fri | Streak breaks; Tue/Thu are neutral, not red |
| 3x/week habit done Mon/Tue/Wed of same week | Streak = 1 (one completed week); current week not yet counted |
| Type `#loop` in editor → autocomplete shows `buffr` | Recency-sorted, top match selected |
| Type `#newthing` → tap "+ create #newthing" | Thread created, `#newthing` inserted at cursor, mention reconciles on next save |
| Edit existing entry to remove `#buffr` from prose | `thread_mentions` row deleted on save |
| Insert blank line above an entry's `#buffr` | Two-pass fallback matches by `(thread_id, tag_text)`, mention preserved |
| Rename thread `buffr` → `buffr-app` in CRUD | Existing mentions stay; next normal scan reconciles |
| Edit `Slug` on the Notion side | Pull rejects with warning log; buffr value unchanged |
| Create new Threads page in Notion | On next pull, local thread created with derived slug |
| Archive a thread | Disappears from Today and autocomplete; mentions remain in DB |
| Open Today view with 5+ habits and 4+ threads | All visible; staleness ordering correct; recent captures section populated |

---

## 6. Suggested cuts if scope tightens

In rough order of impact-vs-pain:

1. **Defer Phase D entirely** (~9–13h saved). Threads stay local-only; habits cadence stays local-only. The product still works fully — Notion just doesn't reflect the new shape. Re-add Phase D once dogfooding stabilizes the data model.
2. **Defer pinning + target_cadence_days on threads** (~3h saved). Default activity-based staleness only. Skip the `pinned` column or keep it nullable and never write to it.
3. **Defer the lazy thread_mentions backfill** (~2h saved). Mentions populate only for newly-edited entries going forward. Historical mentions never appear. Acceptable for solo dogfooding; less acceptable if there are many old entries to surface.
4. **Defer the inline-create autocomplete option** (~2h saved). Force users to create threads from the CRUD page first, then type `#`. Lower friction wins this back, so don't cut unless time-pressed.

Even with the first three cuts, the floor is ~30h of build time. This is a substantial feature; the spec's estimate is honest.

---

## 7. What's next

The plan is now committed to disk. Per user instruction, **not committing or pushing** the plan file — it sits as untracked-or-modified for the user to review. Whenever the user gives the go-ahead, start with Phase A migrations and iterate from there.
