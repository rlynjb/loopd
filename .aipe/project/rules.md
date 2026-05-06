# Project rules

## Coding style
- Strict TypeScript. `npx tsc --noEmit` must pass before any commit.
- Functional React components; hooks-first. No class components.
- Prefer `Pressable` over `TouchableOpacity`.
- Styles via `StyleSheet.create()` at the bottom of each file. No inline styles for repeated patterns.
- Comments explain WHY, not WHAT — reference past data-loss bugs or constraints when present. Keep them short.

## File naming
- Routes: `app/<lowercase-slug>/...`. Dynamic segments use `[param]`.
- Services: `src/services/<domain>/<verb><Noun>.ts` (e.g. `scanTodos.ts`, `reconcileMeta.ts`).
- Components: `src/components/<area>/<ComponentName>.tsx` PascalCase.
- Types: `src/types/<domain>.ts` lowercase.

## Testing requirements
- No automated test suite at present. Manual end-to-end on the connected Android device after each meaningful change.
- All builds must pass `npx tsc --noEmit` cleanly.

## Architectural non-negotiables (from spec.md §10)
1. DB is single source of truth.
2. Prose is canonical for drops (`[]`, `** food N kcal`, `#tag`).
3. DB-first autosave on every keystroke. Scanners run only at commit.
4. Always read DB before deleting.
5. Never clear live refs in focus cleanup.
6. Don't auto-delete during sync. Soft delete via `deleted_at` is the deletion mechanism; hard delete (vacuum) is gated by 30-day age.
7. Two-pass matching (exact match, then line-index fallback).
8. SecureStore-gated one-time backfills for new prose-derived features.
9. Classifier output editable; user override permanent.
10. Heuristic before LLM.
11. Mentions are derived from prose. One documented deviation: dashboard manual-touch toggle for thread "done today" — see `services/threads/touch.ts`.
12. Cloud is a sync mirror, never the canonical source. Reads always hit local SQLite. Writes commit local first; cloud lags by 5s via debounced push (`schedulePush()`).

## What not to change
- The 1:1 invariant between `entries.todos_json` and `todo_meta` (enforced by `reconcileMeta.ts` since SQLite can't FK to a JSON-array element).
- The two-pass scanner pattern.
- `user_overridden_type` lock semantics.
- Slug-as-local-canonical for `threads` — renaming a slug invalidates existing `thread_mentions` reconciliation, so renames go through the threads CRUD only.
- Composite `(user_id, id)` PKs on the Supabase mirror — cross-user isolation at the schema level so RLS (currently disabled in Phase A) only has to be the runtime gate.
- Supabase migrations are append-only. Never edit a committed migration file; add a new one and run `node scripts/db-migrate.mjs --all-pending`.
- Every `database.ts` write that touches a synced table calls `schedulePush()`. New write paths must do the same or edits won't propagate to cloud.
