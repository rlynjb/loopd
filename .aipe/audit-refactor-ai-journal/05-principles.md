# Chapter 05 — Principles

This chapter walks the ten principles from `refactor.md` Section 5, not the techniques. The same locus (the AI provider switch; the scattered clip handling; the 1456-line `database.ts`) shows up here from a different angle — through the "why" lens rather than the "what shape" lens. The closing paragraph on which principles this codebase honours by default and which it strains against is the most useful paragraph in the book.

## Map of the territory

- **Open/Closed** — DEEP. Provider extensibility violates it cleanly; the codebase is closed to a third provider in five places.
- **Locality of Behaviour** — DEEP. Clip handling is scattered across five files; the concept has no home.
- **Single Responsibility** — DEEP. `database.ts` at 1456 lines holds schema migrations + entity CRUD + repair routines + sync stamping hooks.
- **Separation of Concerns** — BRIEF. The four load-bearing data principles (DB-canonical, prose-canonical, two-pass matching, cloud-as-mirror) are themselves Separation of Concerns choices; honoured by default.
- **Tell, Don't Ask** — BRIEF. Mostly honoured; one observation about the SmartTodoList ordering.
- **Principle of Least Surprise** — BRIEF. The `clip_uri` column name vs the multi-clip reality.
- **DRY (with care)** — MENTION. Folded into Open/Closed below.
- **Dependency Inversion** — NOT FOUND as a violation. Direction is correct throughout — leaves depend on roots, services depend on primitives.
- **Liskov Substitution** — NOT FOUND. No type hierarchy of consequence; the codebase is structural-typed.
- **Interface Segregation** — NOT FOUND. No formal interfaces with too-broad surfaces.

---

### Open/Closed — provider extensibility

**Where it's violated** (neutral)

Across five AI chain files (`src/services/ai/summarize.ts`, `caption.ts`, `expand.ts`, `classify.ts`, `interpret.ts`), the provider switch is a literal `provider === 'openai' ? … : …` branch. Adding a third provider — Gemini, a local Llama via an inference endpoint, anything — requires editing every one of these branches and re-validating that chain's behaviour against the new provider. The codebase is "closed" to a new provider in five places, not one.

**Why it matters here** (staff-engineer)

Open/Closed isn't a religion — sometimes the closed-ness is fine because the extension never happens. The reason this one matters is that buffr's AI surface is the part of the app that's most likely to absorb a third provider. The two existing providers cover "Claude" and "GPT," but the field of useful models has been expanding sideways: Gemini-2.5 for long-context summaries, Llama-3.x for on-device classify (no API cost), DeepSeek for cheap structured output. Each of those is a plausible third provider that the current shape resists. Every time a model choice gets attractive, the cost of trying it is "edit five files, regression-test five chains," and the realistic outcome is that the experiment never happens because the cost of even spike-testing it is too high.

**Is it worth fixing?** (staff-engineer)

Yes — but the fix is the Strategy refactor from Chapter 03, not a separate Open/Closed pass. Naming the principle here makes clear what the refactor *buys*: the next provider goes in one file (`providers.ts`) and the chain code is closed to that change. That's the payoff. Without naming Open/Closed explicitly, the Strategy refactor reads as "tidy up the duplication" and the cost-benefit gets fuzzy.

**Which techniques would address it** (neutral)

Chapter 03 — Strategy. Chapter 01 — Replace Conditional with Dispatch Table (the composition-level equivalent). Chapter 02 — Separate Pure from Effectful (necessary follow-up if you want the chain files to stop knowing about providers at all).

---

### Locality of Behaviour — clip handling

**Where it's violated** (neutral)

The "clip" concept is touched by five files: `fileManager.ts` (transcode + filesystem), `clipMigration.ts` (one-pass migration of missing-file references), `database.ts:repairBareClipUris()` (defensive repair at DB-open), `sync/tables/entries.ts` (round-trip the clip columns), `sync/tables/projects.ts` (round-trip clips for the editor project state). There is no `clips/` module.

**Why it matters here** (staff-engineer)

Locality of Behaviour means code that changes together should live together. The forcing test: imagine adding a feature that requires every clip URI to be transformed (e.g., moving clips from `Documents/buffr/clips/` to `Documents/buffr/media/v2/` for a future re-encoding pipeline). The change touches all five files. Worse, two of them (`database.ts:repairBareClipUris`, `sync/tables/*`) currently inline assumptions about clip URI shape that nobody named — a future contributor doesn't know they're part of "clip handling" until they read them. The principle is straining quietly today and would tear loudly the first time a clip-shaped feature lands.

**Is it worth fixing?** (staff-engineer)

Yes, but not standalone — and the bar for "worth fixing standalone" is genuinely high here. Locality violations that haven't bitten anyone are easy to over-react to: extracting a module before there's a real reason just relocates the sprawl from "across files" to "across folders," and the navigation cost is worse not better. The fix becomes worth doing when (a) a new clip-shaped feature requires editing 4+ of the 5 files anyway, or (b) the cleanup audit's `consolidate-clips-json` work is happening and the `clips/` module is the natural container for the consolidation.

**Which techniques would address it** (neutral)

Chapter 02 — Extract Module (`services/clips/`). Chapter 01 — Move Function (`repairBareClipUris` out of `database.ts`).

---

### Single Responsibility — `database.ts`

**Where it's violated** (neutral)

`src/services/database.ts` is 1456 lines and holds:

- `getDatabase()` — the single SQLite handle opener (lines 10–18)
- `repairBareClipUris()` — defensive clip-URI repair (lines 21–50)
- `migrate()` — the entire schema migration logic, including `CREATE TABLE IF NOT EXISTS` for every table, `ALTER TABLE ADD COLUMN` for every incremental addition, and several `CREATE TABLE … new` rewrites for column-drop migrations (lines 53–~500)
- Per-entity CRUD: `getEntriesByDate`, `insertEntry`, `updateEntry`, `deleteEntry`, plus equivalents for `nutrition`, `habits`, `vlogs`, `projects`, `day_meta`, `ai_summaries`, `todo_meta`, `threads`, `thread_mentions`
- Row mappers per table (`mapRowToEntry`, `mapRowToHabit`, `mapRowToNutrition`, etc.)
- `schedulePush()` integration on every write site

Six or seven independent "reasons to change" coexist in one file.

**Why it matters here** (staff-engineer)

Single Responsibility says a unit should have one reason to change. `database.ts` has at least these: the schema (every time a new column lands), the entity CRUD (every time a new entity needs a new query), the repair logic (every time a defensive fix is needed for legacy data), the integration with `schedulePush()` (every time the sync trigger contract changes). Today these reasons-to-change rarely collide because the file is so big that two PRs touching different sections almost never conflict in git. That's the *cost-hiding* shape of SRP violations — the pain doesn't show up as merge conflicts; it shows up as "I opened the file to do X and got lost." Onboarding cost is real here; a new contributor needs ~30 minutes to understand what the file is and what it isn't.

**Is it worth fixing?** (staff-engineer)

This is where SRP gets nuanced and the answer is "not yet, and possibly not ever." The codebase's load-bearing principle is "DB is single source of truth, accessed via one mouth" — and that one mouth being one file is a feature, not a bug. Splitting `database.ts` into `database/migrate.ts` + `database/entries.ts` + `database/habits.ts` + ... would honour SRP at the cost of fragmenting the "one mouth" principle: now the mouth is a directory, and the discipline "every write goes through database.ts and calls schedulePush()" becomes "every write goes through the entries module which calls schedulePush() — and also the habits module which calls schedulePush() — and also the nutrition module..." The chance that a future write site forgets to call `schedulePush()` goes up, because the integration point is no longer one file you can grep.

The realistic move is *partial extraction*: pull `repairBareClipUris()` out (Chapter 02 / Chapter 01), and possibly extract the migration logic into `database/migrate.ts` since it's bounded and rarely-changed. Keep the entity CRUD in `database.ts` even at the cost of file size, because the "one mouth + every write calls schedulePush()" discipline is more valuable than per-entity file separation.

**Which techniques would address it** (neutral)

Chapter 02 — Extract Module (`database/migrate.ts`). Chapter 01 — Move Function (`repairBareClipUris`). NOT recommended: Extract Module per entity — that breaks the "single mouth" architectural principle.

---

### Separation of Concerns

**Where it shows up** (neutral)

The four load-bearing principles in `docs/spec.md` §10 — "DB is single source of truth," "prose is canonical for drops," "two-pass matching," "cloud is a sync mirror, never canonical" — are themselves Separation of Concerns choices that the codebase enforces. UI never talks to Supabase directly. Services never bypass `database.ts`. Sync never reads UI state. Prose-derived rows are rebuilt from prose at commit time, not edited independently.

**Take + verdict**

This is the principle the codebase honours best. The sync engine, the AI chains, the scanners, the editor pipeline — each layer talks to the layer immediately below it and not to anything else. The discipline is visible in every module boundary. *Nothing to refactor.* The closest thing to a SoC violation is `app/_layout.tsx` orchestrating boot, AI auto-summary, and seven backfills in one file — but each effect is independent, and the violation is "things that happen at the same time live in the same file," which is a defensible reading of Locality of Behaviour rather than an SoC failure.

---

### Tell, Don't Ask

**Where it shows up** (neutral)

`src/components/home/SmartTodoList.tsx` reads `todo_meta.pinned` from each todo and decides sort order externally (pinned-first then `createdAt DESC`). The decision lives in the component; the data is read from the row.

**Take + verdict**

The honest Tell-Don't-Ask shape is `getTodosForList(date)` in `services/todos/crud.ts` that returns rows already ordered. The component would `Tell` the service "give me the list for this date" and not `Ask` about each row's pinned flag. The cost of the current shape is small — one component knows about the ordering rule. The cost of the refactor is small — a 10-line query change. *Worth doing eventually*; not urgent. The reason it stays in the component today is probably that the sort is cheap and visible right next to the rendering, which is itself a Locality-of-Behaviour argument. Either reading is defensible.

---

### Principle of Least Surprise

**Where it shows up** (neutral)

The `entries.clip_uri` and `entries.clip_duration_ms` columns are the legacy single-clip pointer; `entries.clips_json` is the actual primary path. A new contributor opening the schema would predict `clip_uri` is canonical because it's named that way.

**Take + verdict**

This is the rename from Chapter 01 viewed through the principle lens. The name violates Least Surprise by ~3 on a 10-point scale — bad enough that someone will misuse it eventually, not bad enough to be worth a standalone fix. *Folds into the consolidate-clips-json fix-later track* in the cleanup audit; rename and drop in one move.

---

### Open/Closed — already covered above

### Liskov Substitution — NOT FOUND

No type hierarchy of consequence. Sync mappers implement a `SyncableTable<TLocal, TCloud>` generic; each implementation is interchangeable at the orchestrator level, and there are no surprising overrides. Honoured by default through structural typing.

### Interface Segregation — NOT FOUND

No formal interfaces with broad surfaces that callers depend on. The `SyncableTable<>` generic is small and exposes only what the orchestrator needs. The provider switch (the closest thing to an interface) is the Open/Closed target above.

### Dependency Inversion — NOT FOUND

Direction is correct: `app/*` depends on `src/hooks/*` which depends on `src/services/*` which depends on primitives (`expo-sqlite`, `@supabase/supabase-js`, `expo-secure-store`). High-level (UI) doesn't depend on low-level (SDK details). The one place this might look like a violation — the AI chains importing the Anthropic SDK directly — is fine because the dependency is on a stable external SDK, not on an internal low-level module.

### DRY (with care) — MENTION

The provider-switch duplication is the only DRY violation worth naming. Folded into Open/Closed and Chapter 01's Replace Conditional. Other apparent duplication in the codebase (the per-table sync mappers, for example) is structural-similarity not concept-duplication — each mapper handles a different entity with different fields and different validation. Deduplicating them would create the fake-coupling that the "with care" qualifier exists to prevent.

---

## Chapter close

**Take:** here's the most useful paragraph in the book.

Buffr **honours** Separation of Concerns by default (the four load-bearing data principles enforce it across every module boundary), Locality of Behaviour within a domain (`services/todos/` owns todos end-to-end; `services/habits/` owns habits; etc.), Dependency Inversion (high-level reads always go to local, low-level details stay in primitives), Tell-Don't-Ask in most places (one minor exception in the dashboard sort), Interface Segregation by default (because the codebase has almost no formal interfaces), and Liskov Substitution by default (because there's almost no inheritance).

Buffr **strains against** Open/Closed for provider extensibility (the AI layer is closed to a third provider in five places), Locality of Behaviour across the clip concept (five files, no `clips/` module), and Single Responsibility for `database.ts` (one file holds schema + CRUD + repair + sync hooks because the "single mouth to SQLite" principle is more valuable than per-entity file separation, and accepting that trade is correct).

The three strains are correlated. Each is the legacy of a secondary concern (AI providers, clip handling, internal database structure) that grew without being named — while the four primary data principles absorbed all the design attention. That's not a failure mode; that's how small codebases work when the primary concerns are correctly load-bearing. The refactor moves you'd take from this book all address the secondary concerns without touching the primary ones, which is the correct sequencing. The day a primary principle starts straining ("cloud is a sync mirror" gets violated by a feature that needs cloud-canonical reads, say), the book gets rewritten — but that's feature-level work, not refactor work.
