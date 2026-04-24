# Drops — Implementation Plan (Proposal, awaiting approval)

Features derived from [loopd-drops-spec.md](../loopd-drops-spec.md). Implemented against loopd's current stack as described in [docs/spec.md](./spec.md). Status: **plan only — do not execute until approved.**

This plan deliberately diverges from the spec on one structural decision: **all drops write to a single shared "Drops" Notion database, not one destination DB per drop type.** Rationale: solo-user app where simplicity outweighs per-type schema flexibility; SQLite's `drops` table and Notion's Drops DB mirror each other 1:1. Every drop-type edit is just metadata; there's no per-type destination wiring to set up.

Prep work before drops (Phase 0): habits get their own Notion DB and the Entries DB points at it by relation; Notion Guide is extended with setup instructions. Phase 1 lands drops foundation + a `>>` system drop type + todos migration.

---

## 1. Feature goal

A **drop type** is a user-defined rule that scans free-form journal text for matching lines, extracts structured fields, and writes a row to the shared **Drops** Notion database. Two trigger shapes in v1:

- **prefix** — line starts with a user-chosen marker (`>>`, `**`, `#learned`, `::`, etc.)
- **suffix** — line contains `<number> <unit>` (e.g. `320 kcal`, `12 reps`)

Runs on entry save/blur. A secondary **AI-scan** path lets the user retroactively extract drops from prose they forgot to tag. Both paths write to the same Drops DB.

**Loopd's existing structured todos (`entries.todos_json`) are folded into this feature** as a default `>>` prefix drop type. Users write `>> call mom` in journal prose; the dashboard's todo list shows those lines. Migration plan in §9.

---

## 2. Phase 0 — Prep work (before drops)

### 2.1 Habits → dedicated Notion DB (+ relation from Entries DB)

Habits today are a `habits` SQLite table + a multi-select property on the Entries Notion DB. The vocabulary (habit names) is synced as part of the entries sync ([notion/sync.ts](../src/services/notion/sync.ts)). Sort order and metadata live only in SQLite and are lost on a reinstall.

Proposal — make habits a first-class synced entity like entries and todos, with **ID-based references on both sides**:

- New Notion "Habits" DB, schema:

  | Property | Type |
  |---|---|
  | Name | title |
  | Sort Order | number |
  | loopd ID | rich_text (local UUID) |
  | Updated At | last_edited_time (read-only on loopd side) |

- Bidirectional sync in [notion/sync.ts](../src/services/notion/sync.ts): `syncAllHabits()` added alongside `syncAll`, `syncAllTodos`. Runs under the same auto-sync toggle.
- New secure-store key: `notion_habits_db_id`. Settings screen gains a new DB-ID input.
- Deletions queued via `sync_deletions` with `entity_type = 'habit'`.
- `habits.notion_page_id` and `habits.updated_at` columns already exist ([docs/spec.md § 4](./spec.md#4-data-model)).

**Entries → Habits is by ID on both sides, not by name:**

- **SQLite** — `entries.habits_json` already stores local habit UUIDs. No schema change on entries.
- **Notion** — the Entries DB gets a new `Habits` property of **type `relation`** pointing to the Habits DB. Notion relations hold Notion page IDs (not loopd UUIDs), so [mapper.ts](../src/services/notion/mapper.ts) translates at the sync boundary using `habits.notion_page_id`. Push: UUID → `notion_page_id` → relation payload. Pull: relation page id → local habit UUID → `entries.habits_json`.

**Migration for existing users** (runs once after Phase 0.1 ships):

1. User creates the Habits DB + pastes its ID in Settings.
2. First `syncAllHabits()` after the DB ID is set populates Notion Habits pages (or merges with existing) and fills each local `habits.notion_page_id`.
3. First `syncAll()` after step 2 reads each entry's old multi-select Habits names, looks up local habits, maps to Notion page IDs, writes the new `Habits` relation property. The Entries DB must already have the relation property — manual step in the Notion Guide (see §11.7 for auto-add option).
4. After relation is populated, loopd stops writing to the multi-select. User can delete it manually when confident.

### 2.2 Notion Guide — extend [app/settings/notion-guide.tsx](../app/settings/notion-guide.tsx)

Current guide covers Entries DB and (optional) Todos DB. Extend with:

- **Habits Database** — schema from §2.1; how to share with the loopd integration; copy the ID.
- **Drops Database** — shared DB for all drops. Schema below in §3.4.
- **Drop Types Database** — registry of user-defined drop types. Schema in §3.3.
- **Entries DB → Habits relation property** — how to add a `Habits` relation property (step-by-step: in Notion UI, `+ Add property` → Relation → pick the Habits DB → name `Habits`).

Matches the existing step-per-DB pattern.

---

## 3. Data model additions

### 3.1 `drop_types` table (SQLite)

Slimmed because there's no per-type destination wiring. Drop types are metadata only — the trigger, the name, the on/off state.

```sql
CREATE TABLE drop_types (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  is_system       INTEGER NOT NULL DEFAULT 0,
  trigger_type    TEXT NOT NULL,            -- 'prefix' | 'suffix'
  trigger_value   TEXT NOT NULL,
  notion_page_id  TEXT,                     -- Drop Types Notion DB page id
  error_state     TEXT,                     -- last write failure for this type; null when healthy
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_drop_types_enabled ON drop_types(enabled);
CREATE INDEX idx_drop_types_notion ON drop_types(notion_page_id);
```

### 3.2 `drops` cache table (SQLite)

Every extracted drop is mirrored here. Notion's Drops DB row is the canonical remote copy; this local table is the fast-read surface for dashboard / `/todos` / `/drops` feed.

```sql
CREATE TABLE drops (
  hash           TEXT PRIMARY KEY,
  drop_type_id   TEXT NOT NULL,
  entry_id       TEXT NOT NULL,
  source         TEXT NOT NULL,            -- 'explicit' | 'inferred'
  fields_json    TEXT NOT NULL,            -- { text, tags, value, unit, context, created_at }
  dest_row_id    TEXT,                     -- Notion page id in the Drops DB; null until write succeeds
  done           INTEGER DEFAULT 0,        -- app-managed (see §4.4)
  done_at        TEXT,
  pinned         INTEGER DEFAULT 0,        -- app-managed
  archived       INTEGER DEFAULT 0,        -- set when the source line is removed from the entry or drop type deleted
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX idx_drops_type ON drops(drop_type_id);
CREATE INDEX idx_drops_entry ON drops(entry_id);
CREATE INDEX idx_drops_archived ON drops(archived);
```

### 3.3 Drop Types Notion DB (synced registry)

Bidirectionally synced mirror of SQLite's `drop_types`. Used as config-backup so a reinstall can restore all of the user's drop-type definitions.

| Property | Type |
|---|---|
| Name | title |
| Enabled | checkbox |
| Is System | checkbox |
| Trigger Type | select (`prefix` / `suffix`) |
| Trigger Value | rich_text |
| loopd ID | rich_text |

Secure-store key: `notion_drop_types_db_id`.

### 3.4 Drops Notion DB (shared destination, fixed schema)

The big simplification. **One Notion database holds every drop of every type.** Filtering by type is native Notion filtering on the `Drop Type` relation column.

| Property | Type | Source |
|---|---|---|
| Name | title | primary text — `fields.text` for prefix, `fields.context` for suffix |
| Drop Type | relation → Drop Types DB | set from `drops.drop_type_id` via `drop_types.notion_page_id` mapping |
| Text | rich_text | `fields.text` (prefix) or `fields.context` (suffix) |
| Tags | multi_select | `fields.tags` (prefix only; suffix has no tags) |
| Value | number | `fields.value` (suffix only) |
| Unit | rich_text | `fields.unit` (suffix only) |
| Done | checkbox | `drops.done` (app state) |
| Pinned | checkbox | `drops.pinned` (app state) |
| Source Entry | relation → Entries DB | `drops.entry_id` via `entries.notion_page_id` |
| Source Method | select (`explicit` / `inferred`) | `drops.source` |
| loopd ID | rich_text | `drops.hash` |
| Created At | date | `fields.created_at` (the source entry's date) |

Secure-store key: `notion_drops_db_id`.

Schema is known to the mapper at compile time — **no per-drop-type field mapping UI**. Every drop writes the same properties; the ones irrelevant to a given trigger shape (e.g. `Value` for prefix drops) stay empty.

**Users can add extra properties** to this DB in Notion (notes column, review-date column, etc.). Loopd writes only the standard set and leaves extras untouched — same rule as today's entries DB.

### 3.5 `entries.drop_hashes_json` column

```sql
ALTER TABLE entries ADD COLUMN drop_hashes_json TEXT;
```

JSON array of `{hash, dropTypeId, destRowId, source}`. Used by the compile loop for dedup and archive decisions.

### 3.6 `drop_write_queue` table (offline safety)

Pending Notion writes — mirrors the pattern used for entry/todo deletions today.

```sql
CREATE TABLE drop_write_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id     TEXT NOT NULL,
  drop_type_id TEXT NOT NULL,
  hash         TEXT NOT NULL,
  fields_json  TEXT NOT NULL,
  op           TEXT NOT NULL,             -- 'create' | 'archive'
  dest_row_id  TEXT,                      -- set for archive ops
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  queued_at    TEXT NOT NULL
);

CREATE INDEX idx_drop_queue_entry ON drop_write_queue(entry_id);
```

### 3.7 Runtime TS types — `src/types/drops.ts`

```ts
export type DropTrigger =
  | { type: 'prefix'; value: string }
  | { type: 'suffix'; value: string };

export type DropType = {
  id: string;
  name: string;
  enabled: boolean;
  isSystem: boolean;
  trigger: DropTrigger;
  errorState: string | null;
  notionPageId?: string;
  createdAt: string;
  updatedAt: string;
};

export type DropHash = {
  hash: string;
  dropTypeId: string;
  destRowId: string | null;
  source: 'explicit' | 'inferred';
};

export type Drop = {
  hash: string;
  dropTypeId: string;
  entryId: string;
  source: 'explicit' | 'inferred';
  fields: Record<string, unknown>;
  destRowId: string | null;
  done: boolean;
  doneAt: string | null;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};
```

`Entry` in [src/types/entry.ts](../src/types/entry.ts) loses `todos: TodoItem[]` (see §9) and gains `dropHashes?: DropHash[]`.

---

## 4. Service layer — `src/services/drops/`

| File | Purpose |
|---|---|
| `types.ts` | Re-exports + parse-result shapes |
| `parse.ts` | Pure parsers for prefix + suffix; markdown disambiguation (spec §6.1.6) |
| `hash.ts` | `hashExplicit(dropTypeId, lineIndex, normalizedLine)` / `hashInferred(dropTypeId, normalizedSourceText)`. Normalization: `trim → collapse whitespace → lowercase` |
| `runner.ts` | `compileEntry(entry, dropTypes) → { toCreate, toArchive }`. Pure over inputs |
| `writer.ts` | Upserts into local `drops` table + enqueues Notion ops into `drop_write_queue` |
| `drain.ts` | Drains the queue → calls [notion/api.ts](../src/services/notion/api.ts)::createPage/archivePage against the single Drops DB → updates `drops.dest_row_id` + `entries.drop_hashes_json` |
| `compile.ts` | Orchestrator: loads enabled drop types, runs runner, enqueues writes, kicks drain |
| `crud.ts` | SQLite CRUD for `drop_types` |
| `sync.ts` | `syncAllDropTypes()` — bidirectional push/pull of the `drop_types` registry |

Note: no separate "mapper per drop type" file. One mapper builds the Drops DB row payload from a local `drops` row.

### 4.1 When compile runs

On entry **commit** — hook into [`updateEntry` in src/services/database.ts](../src/services/database.ts). If `text` changed vs DB state, fire `compile.compileEntry(id)` async (fire-and-forget; errors logged, never thrown). Compile reads the entry fresh by id from the DB, never trusting the passed-in object (per [CLAUDE.md](../CLAUDE.md)).

### 4.2 Drop Types ↔ Notion sync

`syncAllDropTypes()` follows `syncAll` / `syncAllTodos` / `syncAllHabits`: push local dirty rows, pull remote, merge by `loopd ID`. Governed by the auto-sync toggle. Last-sync key: `notion_drop_types_last_sync`.

### 4.3 AI scan path

`src/services/ai/scan.ts` — follows [summarize.ts](../src/services/ai/summarize.ts) shape. Input: entry text + enabled drop-types catalog. Output: `{ sourceText, dropTypeId, extracted, confidence }[]`. Pre-LLM dedup: strip lines already matching explicit triggers. Writes via `writer.ts` with `source: 'inferred'` and `hashInferred(...)`. User-triggered only.

### 4.4 App-managed state: done / pinned / archived

The spec's prefix extraction doesn't include `done`. loopd's current todo UX needs it. Resolution:

- `done`, `doneAt`, `pinned` live on the local `drops` row and are pushed to the Drops Notion DB as checkbox properties. Not extracted from source text; not rewritten into source text.
- User toggles them in the dashboard/todos UI. The source `>>` line in the entry is unchanged.
- When the source line is edited, compile archives the old hash and creates a new one. New row starts `done=0, pinned=0`. **Open question §11.3:** carry-forward via fuzzy match of similar text in the same entry+drop-type (recommended), or reset on every edit.

---

## 5. UI surfaces

### 5.1 Drop-types management — `app/settings/drops.tsx` + `app/settings/drops/[id].tsx`

List screen: name, trigger summary (`prefix: >>`), enabled toggle, system badge, error badge when `error_state` set. `+ New drop type` CTA. Tap row → edit (system rows are view-only).

Edit screen (simpler than the original plan — no destination step, no field mapping step):
1. Name + enabled toggle.
2. Trigger type segmented control (prefix / suffix); `trigger_value` input.
3. Preview pane — sample-line textarea, live extraction render.
4. Save / Delete.

Markdown-conflict warning inline when marker is `**`, `__`, `>`, `-` (spec §6.1.6).

### 5.2 Unified Drops feed — `app/drops.tsx`

Reads from local `drops` table (fast, offline-capable). Single `queryDatabase` call against the Drops Notion DB only when the user pulls-to-refresh or on scheduled sync.

- Filter chips (multi-select) per drop type.
- Search + date range + source filter (explicit / inferred).
- Rows: drop-type badge, primary text, tags, source-entry date, inferred icon, done/pinned state.
- Tap row → detail: full extraction, source-entry excerpt with trigger line highlighted, "Open source entry" → `/journal/[date]`, "Open in Notion" → `Linking.openURL` to the Drops DB page.

### 5.3 Entry-level drops panel

Collapsible footer under each entry in [app/journal/[date].tsx](../app/journal/[date].tsx). Reads `entries.drop_hashes_json` for count + breakdown; detail fetched from local `drops`.

### 5.4 AI-scan UI

Per-entry "Scan for drops" button. Modal with proposals — highlighted source text, target drop type, extracted preview, confidence chip, Accept/Edit/Reject. Bulk "Accept all high-confidence". Disabled when no drop types enabled.

### 5.5 Nav placement — **decision needed**

Current global nav: Home / Record / Journal / Todos. With todos→`>>` migration the Todos model changes but the tab itself could stay. Options:

- **A — Keep Todos, add Drops as 5th tab**: some redundancy (Todos = filter on Drops).
- **B — Replace Todos with Drops**: Todos becomes a preset filter. Cleaner.
- **C — Drops under Settings**: low discoverability.

Recommend **B**. Asking for your call.

---

## 6. Integration with existing systems

### 6.1 Rate limiting

[notion/api.ts](../src/services/notion/api.ts) has a module-singleton 350ms rate-limiter + 429 retry. All Notion writes (entries, todos, habits, drop_types, drops) share it. No extra mutex needed.

### 6.2 Auto-sync orchestration

Revised boot sync: `syncAllHabits().then(syncAll).then(syncAllTodos).then(syncAllDropTypes).then(drainWriteQueue)`. Habits first so entries can reference them by relation. Drops DB writes drain last so drop_types are up-to-date before each drop row references its type.

### 6.3 Autosave interaction

Compile only fires when `text` actually changed vs DB. Todo edits, clip changes, habit toggles call `updateEntry` without touching `text` — no drops churn.

### 6.4 AI provider reuse

`scan.ts` reuses the Claude / OpenAI toggle from [ai/config.ts](../src/services/ai/config.ts). No new settings surface.

---

## 7. Build order

### Phase 0 — Prep (before any drops code)

- **0.1** Habits Notion sync + Entries→Habits relation migration (§2.1). Largest prep item.
- **0.2** Notion Guide updates (§2.2). Cosmetic docs / setup copy.

### Phase 1 — Drops foundation + `>>` system drop + todos migration

- SQLite migrations for all five tables/columns in §3.
- `src/types/drops.ts` + `src/services/drops/*`.
- Prefix trigger; suffix stubbed.
- Compile hook in `updateEntry`; archive enqueue in `deleteEntry`.
- Seed the `>>` system drop type on first boot.
- Todos → `>>` one-time data migration (§9).
- Dashboard `SmartTodoList` + `/todos` screen switch source to `drops` table, filtered by the `>>` drop type.
- Journal screen stops rendering a dedicated todo list under each entry.

### Phase 2 — Drop-types CRUD UI

- `app/settings/drops.tsx` + `app/settings/drops/[id].tsx`.
- Settings menu entry.
- Name, trigger, preview, save.
- Duplicate-trigger-value validation.
- Markdown-conflict warning.
- `syncAllDropTypes()` wired into auto-sync.

### Phase 3 — Unified `/drops` feed

- `app/drops.tsx` + nav slot.
- Filter chips, search, date range, source filter.
- Detail view with source-entry + Notion links.
- Empty states.

### Phase 4 — Suffix trigger + polish

- Suffix trigger implementation.
- Entry-level drops footer panel.
- Error-state surfacing in Settings → Drops.
- kcal offered as an opt-in template (not auto-seeded).

### Phase 5 — AI inference

- `src/services/ai/scan.ts`.
- Per-entry Scan button + proposal modal.
- Inferred-drop hash formula + writer path.
- Pre-LLM explicit-trigger dedup.
- `Source Method` column tagged on Drops DB rows.

---

## 8. Open questions — recommendations

| # | Question | Recommendation |
|---|---|---|
| 1 | Nav placement (§5.5) | **B** (replace Todos with Drops). Needs your call. |
| 2 | kcal as system drop type | v1: opt-in template in Settings → Drops. Not auto-seeded. |
| 3 | done/pinned carry on text edit | Carry forward via fuzzy match (same type + same entry + text similarity ≥ 0.8). |
| 4 | Hash normalization | `trim → collapse whitespace → lowercase`. Unit-test. |
| 5 | Error surfacing | Settings → Drops row badge + entry-footer panel. No toasts. |
| 6 | Drops DB + Drop Types DB ID source | User-paste. No auto-create (consistent with Entries/Todos/Habits). |
| 7 | Duplicate trigger values | Disallow at save time. |
| 8 | LLM provider for inference | Reuse Claude/OpenAI toggle. |
| 9 | Marker disambiguation | Rule: marker counts only when followed by space or non-marker char. |
| 10 | Feed query scaling | Non-issue — one DB. |
| 11 | Destination DB access lost | Set `drop_types.error_state`, pause that type, keep others running. |
| 12 | DB ID format | Accept ID-with-dashes, ID-without-dashes, full URL. Normalize. |

---

## 9. Todos → `>>` migration plan

Destructive. Needs your confirmation before Phase 1 ships.

### Current state

- `entries.todos_json: TodoItem[]` per entry.
- Dashboard's `SmartTodoList` and `/todos` read from aggregated `todos_json`.
- Optional sync to a Notion Todos DB via `syncAllTodos`.

### Target state

- `todos_json` deprecated.
- Each `TodoItem` becomes a `>>`-prefixed line appended to its parent entry's `text`.
- The `>>` system drop type writes to the shared Drops Notion DB (not the old Todos DB).
- Dashboard + `/todos` read from the local `drops` table, filtered to the `>>` drop type.
- `done` / `pinned` preserved on the new `drops` rows.

### Migration script (first boot after Phase 1)

```
for each entry with todos_json:
  for each todo in todos_json:
    line = ">> " + todo.text
    append to entry.text (newline-separated)
    mark done/pinned carry-forward for the matching future drop row
  clear entry.todos_json

seed the ">>" system drop type:
  name: "Todo"
  trigger: prefix ">>"
  is_system: true

for each entry with new ">> ..." lines:
  run compile loop → creates drops rows, enqueues writes, carries done/pinned
```

### Invariants

- No Notion writes during migration (queue fills; drain runs after).
- Resumable — `drops` rows keyed by hash; re-running the migration no-ops already-migrated entries.
- `todos_json` column kept for one release cycle as rollback fallback. Dropped in a later schema version.

### What happens to the old Notion Todos DB

Out of scope for loopd — it's the user's DB. On migration, loopd simply stops writing to `notion_todos_db_id`. Its rows remain in Notion untouched. User can delete it, keep it as archive, or manually copy rows into the new Drops DB. Settings → Notion Sync should surface a one-liner explaining the stop-write (§11.14 below).

### UX risk

Existing users see `>> ` lines appear in their entry text on first post-migration launch. Propose a one-time in-app banner: "Your todos now live in your journal prose as `>>` lines. See Settings → Drops."

---

## 10. Invariants / edge cases

1. **`updateEntry` semantics** — compile fires only when `text` changed vs DB. Todo/habit/clip edits don't trigger it.
2. **Idempotency** — `drop_write_queue` rows keyed by hash; drain checks `entries.drop_hashes_json` before writing.
3. **Archive semantics** — edit-then-edit-back produces a new row, not a revived one (spec §7.1).
4. **Drop-type delete** — existing Drops DB rows stay in Notion. Local `drops` rows get `archived=1`. Drain skips orphaned queue entries with a warning.
5. **Drop-type disable** — new writes paused; existing rows untouched.
6. **Concurrent sync** — rate-limiter singleton serializes everything.
7. **Save must not fail on drop errors** — compile is fire-and-forget.
8. **Parallel compiles for same entry** — module-level `Set<entryId>` guard; second call short-circuits.
9. **done/pinned carry (§11.3)** — fuzzy-match text similarity ≥ 0.8 across the same entry + drop type. Carry forward when matched.
10. **Habits sync cascades with entries** — habits pushed before entries so relation writes succeed. If a habit is deleted in Notion, entries still reference its old ID locally; don't cascade-delete.

---

## 11. Clarifying questions back to you

1. **Nav placement (§5.5)** — replace Todos with Drops, or keep both?
2. **Todos migration (§9)** — confirm destructive write of `>>` lines into existing entries' `text`. Silent or with banner?
3. **done/pinned carry on text edit** — fuzzy match (recommended) or reset?
4. **kcal template** — one-tap from Settings → Drops, or user-built from scratch?
5. **AI scan button placement** — per-entry action, or single "Scan today" on the day header?
6. **Phase 0.1 Habits DB** — ships with the Habits DB ID required (blocking sync until pasted), or falls back to today's multi-select behavior when not yet configured?
7. **Entries DB `Habits` relation property** — auto-add via Notion API `PATCH /v1/databases/{id}` during onboarding, or manual step in the Notion Guide? Recommend manual.
8. **Old multi-select cleanup** — nudge in Settings once relation is populated, or say nothing?
9. **Old `Notion Todos DB` after migration** — leave the ID in Settings, or clear it to avoid confusion?

---

## 12. Phase 0 + Phase 1 scope estimate

### Phase 0.1 — Habits Notion sync + Entries→Habits relation

- `src/services/notion/habitsMapper.ts` (~80 LOC)
- `src/services/notion/sync.ts` — `syncAllHabits()` + habits-relation migration pass inside `syncAll` (~270 LOC added)
- `src/services/notion/mapper.ts` — teach `entryToNotionProperties` / `notionPageToEntry` about the new `Habits` relation, with multi-select fallback read (~60 LOC edits)
- `src/services/notion/config.ts` — `notion_habits_db_id` + accessors + migration status flag (~40 LOC)
- `app/settings/notion-sync.tsx` — Habits DB ID input + migration-status indicator (~60 LOC)
- Boot orchestration in [app/_layout.tsx](../app/_layout.tsx) — chain `syncAllHabits` before `syncAll`

~510 LOC. One-and-a-half focused sessions.

### Phase 0.2 — Notion Guide updates

~80 LOC in [notion-guide.tsx](../app/settings/notion-guide.tsx) adding Habits, Drops, Drop Types, and the Entries→Habits relation step. Half-session.

### Phase 1 — Drops foundation + `>>` system drop + todos migration

- `src/types/drops.ts` (~50 LOC)
- `src/services/drops/{types,parse,hash,runner,writer,drain,compile,crud,sync}.ts` (~650 LOC total — smaller than before because no per-type destination mapping)
- `src/services/database.ts` — four migrations + compile hook + archive hook (~150 LOC added)
- `src/services/todos/migrate.ts` — one-time todos→`>>` migration (~120 LOC)
- [app/index.tsx](../app/index.tsx) — switch `SmartTodoList` source to `drops` table (~40 LOC edits)
- [app/todos.tsx](../app/todos.tsx) — same switch (~40 LOC edits)
- [app/journal/[date].tsx](../app/journal/[date].tsx) — remove dedicated todo render path; rely on prose (~60 LOC edits; deletion-heavy)
- `app/settings/notion-sync.tsx` — Drops DB ID + Drop Types DB ID inputs (~40 LOC edits)

Rough total: ~950 LOC new + ~200 LOC edits. Two focused sessions with buffer for migration edge cases.

Ship-time visible change: todos are now `>>` lines in prose, rendered by the same dashboard list as before. No CRUD UI for custom drop types yet. No `/drops` feed yet. Plumbing complete, foundation proven.

---

*Awaiting your answers to §11 before Phase 0 code.*
