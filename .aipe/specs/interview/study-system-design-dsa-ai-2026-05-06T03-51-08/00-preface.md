# Preface — What this project is really about

loopd looks, on the surface, like a journaling app with a video editor bolted on. That's not what it is. The interesting part of loopd is that it is a **derived-state engine that hides behind a textbox.**

The user types a single block of prose into the day's entry. From that prose, the app extracts:

- **Todos** — every line that starts with `[]` or `[x]` materializes a `TodoItem` in `entries.todos_json` and a paired `todo_meta` row carrying its AI-classified type (`todo`, `idea`, `concern`, `decision`, `question`, `pattern`, `gratitude`).
- **Nutrition** — every line that starts with `** food N kcal` becomes a row in `nutrition`.
- **Thread mentions** — every `#tag` becomes a row in `thread_mentions` linking the entry (and any todo on that line) to a thread.
- **Habits** — explicit checkboxes for the day's repeatable disciplines.

None of those derived shapes are the source. **Prose is canonical.** Everything else is a projection. That is the load-bearing decision in the codebase, and it is the one a senior interviewer is going to push on first, because everything downstream — the autosave model, the conflict-resolution strategy, the AI compose pipeline, the cloud sync mirror — only makes sense once you accept it.

The project also shows a specific kind of engineering judgment that is hard to fake: the willingness to **not** abstract. There is no event bus, no plugin architecture, no service container. There is `database.ts` (a single 700-line file that owns every SQL write), there are scanners (one per derived shape), there are reconcilers (one per 1:1 mapping), and there is a sync orchestrator that walks a flat array of `SyncableTable` definitions in order. The discipline is the architecture.

What this shows about the engineer:

1. **I know how to pick a single source of truth and defend it.** Two competing canonical stores would give two slightly-different bug reports per feature. I picked one (SQLite locally; prose for derived shapes) and made sure no code path violates it.
2. **I know when to ship a sync engine instead of a sync feature.** The Supabase mirror landed as 12 files (`src/services/sync/*.ts` + 10 per-table modules in `tables/`). Generic push, generic pull, `chooseWinner` for last-write-wins, and a per-table `SyncableTable` definition. Adding the 11th synced table would be ~70 lines.
3. **I know what AI is for.** loopd uses Claude Sonnet 4.6 for compose-the-day (structured `AISummary` JSON), Claude Haiku 4.5 for the cheap todo classifier, and a separate caption call that emits four tonal variants (`clean` / `smoother` / `reflective` / `punchy`) from the same raw log. Each call is single-purpose. None of them are in the hot path of the UI. None of them block the user.
4. **I know what I deferred.** Hard delete (vacuum) — deferred. RLS enforcement — disabled in Phase A; the schema gate is composite `(user_id, id)` PK on every cloud table. Test suite — none; manual end-to-end on the connected Android device. Each of those is a deliberate non-decision, not an oversight, and I can defend each.

What an interviewer should walk away with after the first 10 minutes: this is a person who designed a system instead of assembling one. The AI wrote a lot of the lines; I wrote every rule. The chapters that follow are how to tell that apart under pressure.
