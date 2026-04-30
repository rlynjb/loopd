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

## Architectural non-negotiables (from CLAUDE.md + spec.md)
1. DB is single source of truth.
2. Prose is canonical for drops (`[]`, `** food N kcal`, `#tag`).
3. DB-first autosave on every keystroke. Scanners run only at commit.
4. Always read DB before deleting.
5. Never clear live refs in focus cleanup.
6. Don't auto-delete during sync.
7. Two-pass matching (exact match, then line-index fallback).
8. SecureStore-gated one-time backfills for new prose-derived features.
9. Classifier output editable; user override permanent.
10. Heuristic before LLM.
11. Mentions are derived from prose. One documented deviation: dashboard manual-touch toggle for thread "done today" — see `services/threads/touch.ts`.

## What not to change
- The 1:1 invariant between `entries.todos_json` and `todo_meta`.
- The two-pass scanner pattern.
- `user_overridden_type` lock semantics.
- Notion source-of-truth rules per spec.md §6.9.
- Slug-rejected-on-pull for threads (renaming a slug invalidates existing mention reconciliation).
