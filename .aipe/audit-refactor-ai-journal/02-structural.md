# Chapter 02 — Structural

Structural refactors touch multiple files or module boundaries: extracting or inlining modules, inverting dependency directions, separating pure from effectful code, introducing translation layers between domains. Larger blast radius than composition; the cost of getting them wrong is higher because there's nowhere convenient to roll back to.

## Map of the territory

- **Separate Pure from Effectful** — DEEP. The five AI chains each interleave pure prompt-construction with effectful API calls. Splitting them buys testability and shrinks the chain files to readable size.
- **Extract Module** — DEEP. Clip handling is scattered across `fileManager.ts`, `clipMigration.ts`, `database.ts:repairBareClipUris()`, and two sync mapper files. No one drew the box for "clips" as its own module.
- **Introduce Boundary / Anti-Corruption Layer** — BRIEF. AI providers (Anthropic SDK and raw `fetch` to OpenAI) speak in two different vocabularies; the chain files translate per-call. A real anti-corruption layer is a natural pair with Chapter 03's Strategy take.
- **Invert Dependency** — NOT FOUND. The sync layer depends on `getDatabase` because it's a leaf depending on a primitive — direction is correct. AI service layer depends on SecureStore; same shape.
- **Hide Delegate** — NOT FOUND. `getDatabase()` exposes the SQLite instance directly and callers run SQL, but that's a feature of the project's "DB is single source of truth" principle — the SQL is the API.
- **Inline Module / Class** — NOT FOUND. Nothing's so thin it doesn't earn its existence; the modules that are too small (`src/services/sync/types.ts`, `src/services/sync/schedulePush.ts`) are sized that way for clarity.

---

### Separate Pure from Effectful — AI chain functions

**Where it shows up** (neutral)

Each AI chain file under `src/services/ai/` is a single async function (or a small handful) that interleaves four kinds of work in one body:

1. **Pure setup**: read provider preference (`await getProvider()`), pull domain inputs (date, entries text, etc.), normalize them.
2. **Pure prompt construction**: build the user/system prompts from the inputs. Sometimes involves a sibling module (`prompt.ts`, `expandPrompts.ts`) but most chains build prompts inline.
3. **Effectful API call**: `Anthropic SDK messages.create()` or `fetch(OPENAI_URL, …)`.
4. **Effectful parse + validate**: extract the text from the provider-specific response shape, `JSON.parse` it (for the four JSON chains), run a validator (`validate.ts` for the structured summary chain), return the typed result.

Example: `src/services/ai/summarize.ts` runs all four phases in `summarize(date)` between lines 40 and 188. The pure parts (prompt construction, JSON parsing into typed shape) cannot be exercised without making a real provider call.

**Why it's like this** (neutral)

Each chain was authored as a verb — `summarize(date)`, `caption(entry)`, `expand(todo)` — and the chain body grew to do whatever that verb implied end-to-end. There was never a moment where someone said "the prompt-building deserves its own function and the API call deserves its own function." The chain stayed cohesive at the verb level by being a single function.

**Take**

The right shape is `chain = build → call → parse`, three named units per chain. The pure parts (`build*Prompt`, `parse*Response`) extract into their sibling test surfaces; the effectful part (`call`) becomes the dispatch-table entry from Chapter 01. The chain file shrinks to ~30 lines per chain — a body that says "build, then call, then parse, then validate" — and the prompts become readable as data instead of code-mixed-with-fetch.

This is the natural pair to Chapter 01's Replace Conditional with Dispatch Table. Do them in order: the dispatch table first (smaller, mechanical), then the pure/effectful split (larger, opens testing). Doing the split without the dispatch table leaves the chain files still mixing provider-knowledge with prompt-knowledge. Doing the dispatch table without the split leaves the chain files smaller but still untestable.

**The tradeoff**

What you give up: more files. Currently every chain is one file you can hold in your head. After the split, every chain is a folder (or a file with three named sections, depending on how strict you want to be) — `summarize/index.ts` + `summarize/prompt.ts` + `summarize/parse.ts`. Three small files vs one medium file is a real navigation cost if you don't have a project-wide grep habit.

What you avoid: today there's no way to validate the prompts in isolation. If a prompt regression ships (the classifier prompt accidentally drops a few-shot example), the only signal is "model output got worse" — which surfaces in production usage, slowly. With the pure parts extracted, a fixture-based test ("given this entry text, the prompt contains these substrings") catches it at commit time.

The breakpoint where this stops being right: never — the split is strictly better-typed and better-tested, and it doesn't add runtime cost. The breakpoint where it stops being *worth doing*: when buffr stops adding AI chains and stops changing prompts. Both happen the day the product stops evolving the AI surface, which isn't this year.

**What I'd watch for**

The interpret chain is the trap again. It emits markdown, not JSON, so its "parse" phase is a no-op (return the response text as-is). The split has to honour that without forcing every chain into a `JSON.parse` shape. The right contract for the parse phase is `(rawText: string) => TResult`, where `TResult` is the chain-specific output type — interpret's `parse` returns the raw string typed as `InterpretMarkdown` and the four JSON chains' `parse` does the parse-and-validate.

The second trap: don't extract the validator into the parse phase. `validate.ts` is its own concern (round-trip schema for `ai_summaries.summary_json`); it deserves to stay separate. The chain orchestrates `parse` then `validate`, not parse-and-validate-in-one.

**Verdict:** *Worth doing eventually.* Do Chapter 01's dispatch table first; this builds on it. Don't do this if you're not also adding tests — separating pure from effectful and not testing the pure parts is half a benefit at full cost.

---

### Extract Module — `services/clips/`

**Where it shows up** (neutral)

Clip-handling logic lives in five places:

- **`src/services/fileManager.ts`** — the home for clip-related filesystem operations. `saveToDCIMBuffr()`, `transcodeToProxy()`, `pickAndCopyClip()`, `pickVideoAssets()`, `getMediaPath()`, `getExportPath()`, `getTempDir()`, `cleanTemp()`, `normalizeClipUriForStorage()`, `resolveClipUri()`. ~280 lines.
- **`src/services/clipMigration.ts`** — a one-pass migration that walks every entry's `clips_json`, checks whether each referenced file exists, and skips missing files (with the per-clip `console.warn` that produces the ~183 cold-start log lines flagged in `cleanup-2026-05-23.md`).
- **`src/services/database.ts` line 21 — `repairBareClipUris()`** — defensive repair for bare-filename clip URIs in `entries.clips_json` (a residue of deleted Notion sync code that occasionally overwrote full paths with bare filenames). Runs in background after `getDatabase()` opens the DB.
- **`src/services/sync/tables/entries.ts`** — the entries sync mapper, which handles round-tripping `clip_uri`, `clip_duration_ms`, and `clips_json` between local SQLite and cloud Postgres.
- **`src/services/sync/tables/projects.ts`** — the projects sync mapper, which round-trips `clips_json` plus `removed_clip_source_keys_json` (the editor's removed-clip-key tracking).

No single file owns "clips." The concept is split by what subsystem touches it (filesystem, DB-init, DB-write, sync), and each subsystem grew the clip-handling it needed where it needed it.

**Why it's like this** (neutral)

The clip pipeline grew in pieces. The transcode + filesystem code came first (`fileManager.ts`). The single-to-multi clip migration was its own one-time concern (`clipMigration.ts`). The bare-filename repair was reactive — a bug from Notion-era code that needed a defensive fix at DB-open time, so it landed where DB-open lives. The sync mappers landed in their per-table mapper files because that's where sync mappers go. Each landing was correct in isolation; no one was responsible for the shape of "clips" as a concept.

**Take**

Extract `src/services/clips/` and pull in everything that operates on clip URIs or clip file storage:

- `clips/storage.ts` (was: most of `fileManager.ts`'s clip-related exports — `saveToDCIMBuffr`, `transcodeToProxy`, `pickAndCopyClip`, `pickVideoAssets`, `getMediaPath`, `getExportPath`, `getTempDir`, `cleanTemp`)
- `clips/uri.ts` (was: `normalizeClipUriForStorage`, `resolveClipUri` — pure URI logic)
- `clips/repair.ts` (was: `database.ts:repairBareClipUris`)
- `clips/migration.ts` (was: `clipMigration.ts`)

`fileManager.ts` becomes the home for non-clip filesystem operations (none today; it'd be deletable, or kept as a thin re-export shim during transition). `database.ts` loses 30 lines. The two sync mappers stay where they are because that's the right place for mapper code, but they call into `clips/uri.ts` for the URI normalization they currently inline.

**The tradeoff**

What you give up: the existing organization-by-subsystem (filesystem code lives with filesystem code; DB code lives with DB code) is a real principle. Moving clip stuff out of `fileManager.ts` and `database.ts` breaks that principle for one specific concept. New contributors looking for "where does the codebase manage filesystem stuff" won't find it in `fileManager.ts` anymore — they'll find `clips/storage.ts` for clips and nothing for other file types (because there aren't any).

What you avoid: every time a new clip-related need lands, the question "where does this go?" gets answered by "wherever's closest." Without a `clips/` module, the answer in five years is the same as today — wherever's closest — and the sprawl grows.

The breakpoint where this stops being right: if buffr adds other media types (audio recordings, image annotations on the journal) and the right shape becomes `services/media/{clips,audio,images}/`, the extraction was premature. But the codebase has been Android-vlog-only for its lifetime and the planned features (multi-app schema consolidation, Phase B auth) don't touch media.

**What I'd watch for**

The repair function is the trap. `repairBareClipUris()` runs in background from `getDatabase()` because it needs the database connection. If you move it to `clips/repair.ts`, you have to expose either a "call this after the DB is ready" function (which `database.ts` then has to know about and call) or a "call this on first read" hook (which complicates the call sites). The cleanest shape is `clips/repair.ts` exposes `repairBareClipUris(db)` as a pure function-of-db and `database.ts` calls it directly — same shape it has today, just imported from elsewhere. Avoid the temptation to register it as a "DB ready" callback because that's an abstraction the codebase doesn't otherwise have.

**Verdict:** *Worth doing eventually.* Not worth doing standalone — wait until either (a) a new clip-shaped feature lands and you'd otherwise add a sixth file to the sprawl, or (b) you're in `database.ts` for the dead-column cleanup and the 30 lines of `repairBareClipUris` is in the way. Speculative module extraction is its own debt.

---

### Introduce Boundary — AI provider anti-corruption layer

**Where it shows up** (neutral)

The AI chains talk in two vocabularies: Anthropic SDK types (`messages.create()` request/response shape, `MessageParam`, `ContentBlock`) and OpenAI's chat-completions wire format (raw `fetch` against `/v1/chat/completions`, JSON request body with `messages: [{role, content}]`, JSON response with `choices[0].message.content`). Each chain file does the translation inline at call sites.

**Take + verdict**

The "boundary" angle on this is structural — formalize a `ProviderRequest` / `ProviderResponse` shape that's neither Anthropic-shaped nor OpenAI-shaped, and have the two provider callers translate to and from it. This is the Strategy refactor from Chapter 03 viewed through the boundary lens; the names differ but the diff is the same. Do it once when you do the Strategy, not as a second pass. *Worth doing as part of the Strategy refactor, not separately.*

---

## Chapter close

**Take:** the structural debt in this codebase is concentrated, not diffuse. Most modules have good cohesion — `services/todos/`, `services/threads/`, `services/sync/`, `services/habits/`, `services/nutrition/` each own their domain end-to-end and the dependencies between them are clean. The two structural opportunities are both in places where one concept refused to be owned: the AI chains never got a separation between prompt-shaping and provider-calling, and clips never got a module of their own. Both are the legacy of "land it where it's most convenient" being the default landing pattern. Neither is urgent; both compound. The pattern is recognisable — codebases that respect their data principles often haven't named their secondary concerns yet, because the primary concerns absorbed all the design attention.
