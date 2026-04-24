# Loopd — Drops Feature Spec

> **Purpose of this doc**: Context for Claude Code to produce an implementation plan. This is not the implementation prompt itself — it describes the feature, constraints, and open questions so Claude Code can propose a build order, ask clarifying questions, and surface risks before any code is written.

---

## 1. Context

Loopd is a personal daily productivity PWA built on the loop: **Plan → Live → Reflect → Improve**. It already has:

- A **journal** surface where the user writes free-form prose entries
- Two **hardcoded detectors** that scan journal text and compile structured data:
  - **Calorie tracker**: detects numeric values with a `kcal` suffix and compiles a nutrition view
  - **Todo tracker**: detects markdown checkboxes (`- [ ]`) and compiles a todos view
- **Notion API** as the sole persistence layer (no server DB, no Blobs, no Supabase)
- Stack: **Next.js 14 (App Router), TypeScript, Tailwind CSS, Notion API**, deployed on **Netlify**

The detector pattern works well. The user wants to generalize it.

---

## 2. Problem

Knowledge the user accumulates (decisions, learnings, workflow notes, reading notes) is scattered across curriculums, cheatsheets, and separate artifacts. The user already captures thoughts naturally while journaling but has no structured way to extract and organize them.

Hardcoding more detectors (`#learned`, `#book`, etc.) doesn't scale. The user should be able to **define their own drop types** — custom detectors that compile matching lines from journal entries into user-specified Notion tables.

---

## 3. Feature summary

A **drop type** is a user-defined rule with three parts:

1. **Trigger** — a pattern that identifies lines in journal prose
2. **Extraction** — which pieces of the matched line become fields
3. **Destination** — a Notion database and a mapping from extracted fields to Notion properties

When the user saves a journal entry, Loopd runs every enabled drop type against each line. Matches are written as rows to the configured Notion DBs. Existing hardcoded detectors (kcal, todos) are preserved as system drop types — visible but not editable.

---

## 4. User stories

1. As a user, I can create a new drop type that triggers on `#learned` and writes to my "Knowledge Drops" Notion DB.
2. As a user, I can map extracted fields (text, tags) to specific Notion properties in the destination DB.
3. As a user, I can preview how a sample line will be parsed and written before saving the drop type.
4. As a user, I can enable/disable drop types without deleting them.
5. As a user, I can see the system-provided drop types (kcal, todos) in the list, marked as system, but not edit their rules.
6. As a user, I see the drops produced by each journal entry when I re-open it, so I know what was compiled.
7. As a user, I can edit a journal entry and have drops stay consistent (no duplicates, stale drops removed).
8. *(Out of scope v1)* As a user, I can backfill a new drop type across old journal entries.

---

## 5. Data model

### 5.1 Drop Types (new Notion DB, auto-created by Loopd)

Loopd creates this DB on first run (bootstrap flow — see §11.6). The user does not manually create this one.

| Property | Type | Notes |
|---|---|---|
| Name | title | e.g., "Knowledge Drop" |
| Enabled | checkbox | default true |
| Is System | checkbox | true for kcal/todos, locks the row from UI edits |
| Trigger Type | select | `prefix` \| `suffix` \| `checkbox` |
| Trigger Value | rich_text | user-defined marker — `**`, `--`, `>>`, `#learned`, `kcal`, etc. Empty for checkbox. |
| Destination DB ID | rich_text | Notion database ID — **user-pasted** from the destination DB's URL |
| Destination DB Name | rich_text | fetched from Notion on save, cached for UI display |
| Field Mapping | rich_text | JSON blob, see 5.3 |
| Owner | rich_text | hardcoded "rein" for v1 — multi-user hook |
| Created | created_time | auto |
| Updated | last_edited_time | auto |

### 5.2 Destination DBs (user-created, one per drop type)

**Each drop type writes to its own destination Notion database.** The user creates this DB themselves in Notion — Loopd does not auto-create it. This gives the user full control over schema, naming, and where in their workspace it lives.

Setup flow:
1. User creates a new DB in Notion with whatever properties they want
2. User shares the DB with the Loopd integration
3. User copies the DB ID from the URL (`notion.so/<workspace>/<32-char-id>?v=...`)
4. User pastes the ID into the drop type config
5. Loopd fetches the DB schema via Notion API and surfaces its properties for field mapping (see §8.2)

**Rationale for user-paste over Loopd-creates**: the user already knows their workspace structure — where the DB belongs, what to call it, icon, cover, whether it's a sub-page or top-level. Auto-creating imposes decisions. Paste-ID respects the workspace as the user's domain.

**No constraints on destination DB schema.** A drop type is valid as long as at least one extraction field maps to a compatible Notion property. Extra properties on the destination DB are untouched by Loopd — the user can have manual columns alongside auto-written ones.

### 5.3 Journal Entry → Drops link

The existing journal entry DB needs one new property:

| Property | Type | Notes |
|---|---|---|
| Drop Hashes | rich_text | JSON array of `{hash, dropTypeId, destRowId}` — used for dedup/cleanup on re-save |

### 5.4 Field mapping JSON shape

```json
{
  "text": "Title",
  "tags": "Tags",
  "source_entry": "Source",
  "created_at": "Date"
}
```

Keys are fixed extraction field names (see §6). Values are Notion property names in the destination DB. Unmapped extraction fields are skipped. If a required Notion property in the destination DB is not mapped, the drop type is invalid and should be flagged in the UI but allow save (with warning).

---

## 6. Detection philosophy and trigger types

### 6.0 Detection philosophy

There are three possible ways to detect a knowledge drop in journal prose. We are implementing **two of the three** — explicit tags as the default, AI inference as an optional augmentation. The middle option is deliberately skipped.

1. **Explicit tag** *(implementing as default)* — line-level markers like `#learned`, `kcal` suffix, or `- [ ]` checkbox. Zero ambiguity, user consciously flags it, cheap to implement. Cost: the user has to remember to use it. Matches the existing kcal/todo pattern in Loopd, so the user is already trained in this style.

2. **Block fence** *(out of scope, v1 or later)* — wrapping paragraphs in fences like `::: learned … :::` or fenced code blocks with tags. Captures multi-line thoughts, but heavier to type and pulls toward formal writing rather than natural journaling. Not building this.

3. **AI-inferred** *(opt-in augmentation, see §6.6)* — no markup. An LLM scans the entry for knowledge-like statements ("I realized that…", "turns out…", "the trick is…"). Magical when it works, unreliable, costs tokens per entry. Implemented as an **explicit user action on an entry**, not automatic on save. This keeps the default save path fast, free, and deterministic.

The explicit-tag layer runs **synchronously on entry save**. The AI-inferred layer runs **asynchronously on user request** ("Scan this entry for anything I didn't tag"). They write to the same drops pipeline and same destination DBs — inference is just a different *source* of matches, not a different kind of drop.

### 6.1 Trigger types (explicit-tag layer)

Three trigger types in v1. Each has a fixed set of extraction fields.

#### 6.1.1 Prefix

- **Matches**: line starts with the trigger value, case-insensitive, optional leading whitespace. The trigger value is a user-defined string marker — common examples: `**`, `--`, `>>`, `#learned`, `::`, `@note`. Not constrained to hashtag syntax.
- **Extraction fields**:
  - `text` — line content after the trigger marker, with trailing hashtags stripped
  - `tags` — array of trailing `#word` tokens at the end of the line (tag extraction always uses `#` regardless of the trigger marker — tags and triggers are separate concepts)
  - `source_entry` — relation or rich_text back-ref to the journal entry
  - `created_at` — entry's date (not drop-write time)

**Examples**:

- `>> Notion queries are slow because of default page size #notion #perf`
  - trigger: `>>`
  - `text` → "Notion queries are slow because of default page size"
  - `tags` → `["notion", "perf"]`

- `** finished reading The Pragmatic Programmer #book`
  - trigger: `**`
  - `text` → "finished reading The Pragmatic Programmer"
  - `tags` → `["book"]`

- `-- call the accountant back tomorrow`
  - trigger: `--`
  - `text` → "call the accountant back tomorrow"
  - `tags` → `[]`

**Marker validation**: trigger value must be 1–10 characters, non-whitespace at both ends. Conflicts with markdown syntax should be surfaced at save time (e.g., a user picking `- ` would collide with list items; `**` is bold markers and needs care around matching — see §6.1.6).

#### 6.1.2 Suffix

- **Matches**: line contains a number immediately followed by the trigger value as a unit (e.g., `450 kcal`, `12 reps`), case-insensitive
- **Extraction fields**:
  - `value` — the number (stored as number)
  - `unit` — the matched suffix string
  - `context` — the rest of the line (everything except the matched number+unit)
  - `source_entry`, `created_at` — as above

**Example**: `had oatmeal, 320 kcal, plus coffee`
- `value` → 320
- `unit` → "kcal"
- `context` → "had oatmeal, plus coffee"

#### 6.1.3 Checkbox

- **Matches**: line starts with `- [ ]` or `- [x]` (markdown checkbox), optional leading whitespace
- **Extraction fields**:
  - `text` — content after the checkbox
  - `done` — boolean, true if `[x]`
  - `source_entry`, `created_at` — as above

**Example**: `- [x] email the accountant`
- `text` → "email the accountant"
- `done` → true

#### 6.1.4 Multiple matches per line

A single line can match at most one drop type trigger. If multiple drop types would match (e.g., two `prefix` drops both matching), the first-created enabled drop type wins. Document this in the UI.

#### 6.1.5 Multi-line blocks, regex, conditions

**Out of scope for v1.** Not building a rule engine.

#### 6.1.6 Markdown-conflicting markers

Triggers like `**`, `__`, `>` collide with markdown syntax (bold, italic, blockquote). Handling:

- **Match rule**: a line "starts with" the marker only if the marker is followed by a space or non-marker character. `** hello` matches trigger `**`. `**hello**` does not (it's bold).
- **Preservation**: the trigger marker is stripped from extracted `text`. If the user wrote `>> something **important** here`, the extraction gets `something **important** here` with bold preserved.
- **Validation at save**: when the user creates a drop type with marker `**`, `__`, `>`, or `-`, show a warning explaining the disambiguation rule so they know what will and won't match.

### 6.2 AI-inferred drops (opt-in augmentation)

A second detection path that complements the explicit-tag layer. Runs on user action, not on save.

#### 6.2.1 User flow

- On any journal entry, the user taps **"Scan for drops"** (or equivalent)
- The full entry body is sent to an LLM along with a list of the user's enabled drop types and their trigger intents
- The LLM returns a list of proposed drops: each has a source text span, a suggested drop type, and extracted field values
- The user sees the proposals in a review UI: each proposal shows the original text highlighted, the target drop type, and the fields that would be written
- User accepts, edits, or rejects each proposal individually
- Accepted proposals flow through the same writer used by explicit tags and are written to the destination Notion DB

Nothing is written without explicit user acceptance. This is a review step, not an auto-compile.

#### 6.2.2 Why not auto-run on save

- **Latency** — every journal save would block on an LLM round-trip
- **Cost** — tokens per entry, per save, add up
- **Trust** — silent AI writes into Notion DBs are hard to audit and undo
- **Determinism** — the same entry might produce different drops on different saves if the model is nondeterministic

Keeping it manual-scan preserves the default save path as fast, free, and deterministic, and lets the user treat inference as a deliberate review pass.

#### 6.2.3 Prompting approach (high level, for planning)

The LLM prompt includes:

- The entry body
- The list of enabled drop types for this user, with their trigger values and extraction fields — e.g. `"#learned — captures knowledge insights; fields: text, tags"`
- Instruction to return structured JSON: array of `{sourceText, dropTypeId, extracted: {...fields}}` with a confidence score per proposal
- Instruction to skip content already explicitly tagged (the synchronous detector already caught those — avoid duplicates)

Detailed prompt engineering is left to implementation, but the spec-level commitment is: **inference proposes drops against existing drop types; it does not invent new drop types.**

#### 6.2.4 Marking inferred drops

Every drop row written to a destination DB records its source:

- `Source Method` (select in destination DB, if mapped): `explicit` \| `inferred`
- If the destination DB doesn't have this property, the drop is still written; the `Source Method` field is skipped like any other unmapped extraction field

This lets the user filter their Notion DBs to see which knowledge came from explicit tags vs AI inference.

#### 6.2.5 Dedup between explicit and inferred

If a line was already matched explicitly and written as a drop, the inference pass should not re-propose it. Approach: before calling the LLM, strip lines that already match any enabled explicit-tag trigger, or include them in the prompt with an instruction to skip. Prefer the first — simpler, avoids depending on prompt compliance.

#### 6.2.6 Out of scope for v1

- Background/scheduled inference passes
- Per-drop-type inference enable/disable (all enabled drop types are candidates)
- Learning from user accept/reject decisions to improve future proposals
- Multi-line / paragraph-level inferred drops that span more than a sentence — v1 stays line-ish for consistency with explicit layer

---

## 7. Compile loop (explicit-tag, synchronous)

This covers the explicit-tag detector only. AI-inferred drops follow a separate flow — see §7.3.

Triggered on journal entry save (create or update).

```
on entry save:
  1. Load all enabled drop types for the current owner
  2. Parse entry body into lines
  3. Load existing Drop Hashes from this entry
  4. new_drops = []
  5. for each line (with line index):
       for each drop type (ordered by created_at asc):
         if trigger matches:
           extract fields per trigger type
           hash = sha1(dropTypeId + lineIndex + normalizedLineContent)
           new_drops.push({ dropType, extracted, hash })
           break  # first-match wins
  6. existing_hashes = set of hashes from Drop Hashes property
  7. new_hashes = set of hashes in new_drops
  8. to_create = new_drops where hash not in existing_hashes
  9. to_delete = existing entries where hash not in new_hashes
  10. For each to_create: write row to destination DB, record {hash, dropTypeId, destRowId}
  11. For each to_delete: archive the destination row (Notion "archived" flag)
  12. Update Drop Hashes property on entry with the union of surviving + newly created
```

### 7.1 Dedup philosophy

Hash is `(dropTypeId, lineIndex, normalizedLineContent)`. This means:

- Editing a line → old hash gone, new hash created → old drop archived, new drop written
- Re-ordering lines → hashes change → full rewrite. Acceptable; journal entries don't typically get re-ordered.
- Saving the entry unchanged → all hashes match → zero writes

### 7.2 Performance

- Compile runs on entry save, not on every keystroke. Debounce save if not already.
- Notion API has rate limits (~3 req/s). A journal entry producing 10 drops = 10 writes. Should be fine for single-user, solo-journal scale.
- If a destination DB write fails: log, surface in UI (non-fatal), retry is manual. The entry itself must save even if drops fail.

### 7.3 Inference loop (AI-augmented, on user action)

Triggered by the user tapping **"Scan for drops"** on a journal entry. Never runs automatically.

```
on user action "scan entry":
  1. Load enabled drop types for the current owner
  2. Load entry body
  3. Strip lines that already match any explicit-tag trigger (dedup vs sync layer)
  4. Send remaining body + drop-type catalog to LLM
  5. Receive proposals: [{ sourceText, dropTypeId, extracted, confidence }]
  6. Render review UI with all proposals
  7. For each proposal the user accepts:
       - Extract fields per the drop type's shape
       - Compute hash = sha1(dropTypeId + "inferred" + normalizedSourceText)
       - Write row to destination DB with Source Method = "inferred"
       - Append hash + destRowId to the entry's Drop Hashes property
  8. Rejected proposals are discarded (no state kept for v1)
```

### 7.4 Interaction between explicit and inferred hashes

Both paths write to the same Drop Hashes property on the journal entry. The hash formula differs so they never collide:

- Explicit: `sha1(dropTypeId + lineIndex + normalizedLineContent)`
- Inferred: `sha1(dropTypeId + "inferred" + normalizedSourceText)`

When the explicit compile loop runs on a re-save, it only touches hashes it produced (entries with matching line-index shape). Inferred hashes are left alone. This means: if the user edits a journal entry after accepting inferred drops, the inferred drops are not auto-updated — they stay as-written. The user can delete them manually in Notion or re-scan.

**Rationale**: inferred drops came from a user-reviewed act. Silently rewriting them on every subsequent save would undo the user's editorial judgment.

---

## 8. UI surfaces

### 8.1 Drop types list screen

- Entry point: Settings → Drops, or a dedicated nav slot (TBD — see open questions)
- Lists all drop types for the user
- Each row shows: name, trigger summary (e.g., "prefix: #learned → Knowledge Drops"), enabled toggle, system badge if applicable
- Tap a row → edit (or view-only if system)
- Button: **+ New drop type**

### 8.2 Create / edit drop type flow

Step 1: **Trigger**
- Radio select: prefix / suffix / checkbox
- Input field for trigger value (hidden for checkbox). Placeholder shows examples: `** — >> #learned kcal`. Accepts any non-whitespace marker 1–10 chars.
- Inline example of what will match, updated live as the user types the marker
- Warning if marker conflicts with common markdown (`**`, `__`, `>`, `-`)

Step 2: **Destination**
- Instruction text: *"Create a database in Notion, share it with the Loopd integration, then paste the database ID below."*
- Link: *"How to find your database ID"* → opens a small help sheet with screenshots
- Input field: paste Notion database ID (32 chars with or without dashes, Loopd normalizes)
- On paste, Loopd hits Notion API to:
  - Verify the ID is valid and accessible to the integration
  - Fetch the DB title (shown for confirmation: *"Connecting to: Knowledge Drops"*)
  - Fetch the DB's properties (feeds into step 3)
- Clear error messaging on failure: not found, no access, invalid ID format

Step 3: **Field mapping**
- For each extraction field (from §6), a dropdown of destination DB properties matching the field's expected type
- `text` / `context` → rich_text or title props
- `value` → number props
- `tags` → multi_select props
- `created_at` → date or created_time props
- `done` → checkbox props
- `source_entry` → relation or rich_text props
- Unmapped fields are skipped; user can leave them blank

Step 4: **Preview**
- A textarea where the user pastes a sample line
- Below it: the extracted field values and a rendered preview of the Notion row that would be created
- Save button (disabled if no extraction fields are mapped to any destination property)

### 8.3 Entry view integration

- When viewing a journal entry, show a collapsed panel: "X drops from this entry" with per-drop-type counts
- Expanding shows each drop's text, destination, and a link to open in Notion
- Drops from the inferred path are visually distinguished (subtle tag or icon) from explicit drops
- This is read-only. Edits happen in the journal prose.

### 8.4 Scan-for-drops flow (AI inference UI)

Entry point: a **"Scan for drops"** button on the entry view (secondary action, not primary).

1. User taps scan → loading state
2. Results render as a review list, each proposal shows:
   - Highlighted source text from the entry
   - Suggested drop type (with destination DB name)
   - Extracted field preview
   - Confidence indicator (low/med/high)
   - Accept / Edit / Reject buttons
3. **Edit** opens an inline form with the extracted fields, pre-filled, so the user can correct extraction before accepting
4. **Accept all** bulk action at the top for high-confidence proposals
5. On accept, the drop writes to the destination DB and the proposal disappears from the list
6. Empty result state: "No new drops found in this entry" — important to handle gracefully
7. The scan button is disabled if no drop types are enabled (nothing to match against)

### 8.5 Unified Drops page (the in-app scan surface)

**The primary consumption surface for drops, and a key differentiator of this feature.** Without it, the user has to open Notion to see their drops — which defeats the "scannable knowledge" goal.

Entry point: a dedicated **Drops** nav slot (see §11.1 for nav placement decision).

The page queries every destination DB the user has configured and shows a unified, filterable, reverse-chronological feed.

**Layout**:

- **Filter bar (top, sticky)**: chips for each enabled drop type — "All · Knowledge · Book · Todo · Calorie · …". Tapping a chip filters the feed to that drop type. Multi-select allowed.
- **Secondary filters**: search input (text match across drop content), date range (today / this week / this month / all).
- **Feed (reverse chrono)**: each row shows:
  - Drop type badge (colored chip, matches the filter chip)
  - The drop's primary text (from `text` or `context` extraction field)
  - Tags as inline chips
  - Date of the source journal entry
  - Source method icon if inferred
  - Tap row → opens the drop in detail view (see below)
- **Empty states**:
  - No drop types configured yet: CTA to create first drop type
  - Drop types configured but no drops yet: "Start journaling with your trigger marker to see drops here"
  - Filter returns nothing: "No drops match these filters"

**Detail view** (tap a drop in the feed):
- Full extracted content
- Source entry excerpt with the trigger line highlighted
- Link: "Open source entry" → jumps back to the journal
- Link: "Open in Notion" → opens the row in the destination DB

**Query strategy**:

Querying across multiple Notion DBs simultaneously has cost and latency implications. Approach:

1. On page load, query each enabled drop type's destination DB in parallel, filtered by Owner, sorted by created_at desc, paginated (default 20 per DB)
2. Merge results client-side, sort by created_at desc, render
3. "Load more" paginates further — fetches next page from each DB, merges

**Caveat**: this scales poorly past ~10 destination DBs. For v1 user (solo, few drop types), acceptable. Revisit if the user hits 20+ drop types.

**No writes from this page.** Drops page is read-only. To modify a drop, user opens it in Notion.

---

## 9. Non-goals for v1

- Regex or multi-line triggers (block-fence detection style, option 2 from §6.0)
- Conditional logic ("only if tag X present")
- Transformations (uppercase, trim-specific)
- Visual rule builder / no-code IDE
- Backfill across existing entries (add a button later)
- Cross-drop-type coordination (e.g., "one drop cancels another")
- User-editable system drop types (kcal, todos remain hardcoded visible)
- Drop analytics ("you made 47 learnings this week")
- **Automatic AI inference on save** — inference is user-triggered only (see §6.2.2)
- **Learned/adaptive inference** — no feedback loop from accept/reject in v1

---

## 10. Constraints and invariants

- **No server DB.** Notion API only. No Netlify Blobs, no Supabase, no PlanetScale.
- **Frontend-only Next.js app.** API routes allowed for Notion calls and LLM calls (keep tokens server-side), but no stateful backend.
- **Multi-user hook.** Every Notion row we write has an `Owner` property, hardcoded to `"rein"` for v1. Every query filters on it. This is non-negotiable — the multi-user rewrite must be a value swap, not a refactor.
- **Existing detectors must keep working.** Kcal and todos compilation cannot regress. Ideal: they become system drop types internally so there's one code path.
- **Journal save must not fail due to drop errors.** Drops are best-effort. Entry save is authoritative.
- **No Notion page writes to properties that don't exist.** If the destination DB changed (user renamed a property), surface an error on that drop type, don't crash compile.
- **LLM calls are synchronous-to-user-action, never to save.** The save path must never call the LLM. This is a hard architectural boundary.
- **No silent AI writes.** Every AI-inferred drop requires explicit user acceptance before it is written to Notion.

---

## 11. Open questions for Claude Code to surface or decide

1. **Nav placement.** Two surfaces need nav decisions now:
   - **Drops page** (§8.5) — the unified scan surface. Needs a primary nav slot since it's a daily-use destination. Current nav is Journal / Habit / Record / Clip / Edit. Proposal: replace one of Record/Clip/Edit with Drops, or add as 6th slot. Design decision — Claude Code should not assume.
   - **Drop types config** (§8.1) — settings-style, less frequently used. Can live under Settings or as a sub-nav of the Drops page (e.g., a gear icon in the top-right of the Drops page).
2. **System drop types internalization.** Should the existing kcal and todo detectors be rewritten as system drop types in the unified pipeline, or kept as separate code paths with the new custom drops pipeline alongside? Recommendation: unify in v1 if refactor cost is low, defer if not — but a design decision either way.
3. **Destination DB property creation.** When mapping, if the destination DB is missing a useful property (e.g., no "Tags" multi_select), do we offer to create it via Notion API, or require the user to add it in Notion first? Recommendation: require manual for v1, revisit.
4. **Hash stability on whitespace/punctuation changes.** What counts as "the same line" for dedup? Proposal: trim + collapse internal whitespace + lowercase for hash input. Confirm.
5. **Error surfacing.** Where do drop compile failures appear — toast, entry footer, a dedicated log? Proposal: entry footer panel + Settings → Drops health view.
6. **Drop Types DB bootstrap.** On first run for a new user, create the Drop Types DB in their Notion workspace + seed it with the kcal and todo system entries. How do we handle the workspace selection / initial auth flow? This may already be solved in existing Loopd onboarding — verify.
7. **Prefix trigger collision.** If two drop types both trigger on `#learned` (user mistake), first-created wins. Is that the right policy, or should we disallow duplicate triggers at save time?
8. **LLM provider for inference.** Anthropic (existing API) vs OpenAI vs user-configurable. Recommendation: Anthropic for v1 to match existing buffr patterns, with a `BaseChatModel`-style interface so provider is swappable.
9. **Inference cost exposure.** Do we show the user token cost / request count per scan, or silently absorb? Solo personal tool probably silent, but worth naming.
10. **Edit-then-re-scan behavior.** If the user edits an entry after running inference, should the scan button be re-enabled (offering a fresh pass), or should we auto-invalidate prior inferred drops? Proposal: scan is always re-enabled, prior inferred drops stay until user deletes them in Notion.
11. **Destination DB access loss.** User pastes an ID, configures a drop type, then later unshares the DB from the integration or deletes it in Notion. What's the behavior?
    - Proposal: on write failure, mark the drop type as `error` state in the list with a clear message ("Destination database no longer accessible — re-share or re-connect"), stop attempting writes until user resolves. Never crash compile for other drop types.
12. **Destination DB ID validation.** Notion DB IDs can be pasted in multiple formats (with dashes, without dashes, as full URL). Proposal: Loopd normalizes all three on paste. Confirm input formats to accept.
13. **Unified Drops page query scaling.** §8.5 fans out a query per destination DB on every page load. Acceptable for v1. When does this need caching — at 5 drop types? 10? Proposal: no caching in v1, add when measured pain.
14. **Trigger-marker ambiguity on save.** If the user types `**` for their marker and then writes `** *and* also **bold text**`, the detector has to distinguish the trigger from markdown bold. §6.1.6 proposes a "marker followed by space or non-marker" rule. Confirm this handles the common cases or flag if more nuance is needed.

---

## 12. Build order (proposed — Claude Code should critique)

**Phase 1 — Plumbing**
- Drop Types Notion DB: create schema, bootstrap logic, CRUD API routes
- Refactor (or add alongside) the existing kcal/todo detectors to fit a common `DropTypeRunner` interface
- Dedup hash layer on journal entry save

**Phase 2 — Custom drops core (explicit layer)**
- Prefix trigger with arbitrary marker support (`**`, `--`, `>>`, `#`, etc.)
- Destination DB paste-ID flow with schema fetch
- Drop types list screen (read-only first)
- Create/edit form without preview
- End-to-end test: user creates `**` drop pointing at a Notion DB they pre-created, journals, sees row in that DB

**Phase 3 — Unified Drops page**
- Drops nav entry (placement per §11.1)
- Fan-out query across all enabled destination DBs
- Filter chips by drop type
- Search and date-range filters
- Drop detail view with source-entry link
- Empty states

**Phase 4 — Remaining explicit UI**
- Preview step in create/edit flow
- Suffix and checkbox triggers
- Entry view drops panel
- Enable/disable toggle
- Markdown-conflicting marker warnings (§6.1.6)

**Phase 5 — Polish (explicit layer)**
- Error surfacing (including destination DB access loss, §11.11)
- System drop types shown as read-only in list
- Empty states, onboarding for the feature

**Phase 6 — AI inference layer**
- LLM provider abstraction (or reuse from buffr if applicable)
- Scan-for-drops API route: takes entry body + drop-type catalog, returns proposals
- Review UI: proposal list with accept/edit/reject
- Inferred-drop writer path (shares writer with explicit, different hash formula)
- Source Method tagging on destination rows
- Dedup against explicit drops before LLM call

Phase 6 is explicitly last so the explicit layer proves itself before adding LLM dependency, cost, and latency to the product. Phase 3 (unified page) comes before the rest of the UI polish because without it there's no in-app consumption surface — the feature is just "writes to Notion for you," which is worth less than "writes and lets you scan."

---

## 13. Success criteria

- User can create a custom drop type with any marker (`**`, `--`, `>>`, etc.) in under 2 minutes without reading docs.
- Pasting a Notion DB ID validates and fetches schema within 2 seconds, or shows a clear error.
- Writing `** X #tag` in a journal entry produces a row in the configured Notion DB within one save cycle.
- Editing that line updates the destination row (via archive + create) with no duplicates.
- Kcal and todo tracking still work exactly as before.
- Zero journal save failures caused by drop compile errors or destination DB access loss.
- Unified Drops page loads and renders merged results from all destination DBs within 3 seconds for a user with up to 10 drop types.
- **No LLM calls occur on journal save, ever.** (Verifiable via network inspection.)
- *(Phase 6)* User can scan an entry and see at least one reasonable drop proposal for knowledge-like content that wasn't explicitly tagged.

---

*End of spec. Claude Code: please produce a planning response covering build order critique, clarifying questions on the open items in §11, any invariants or edge cases you think are missing, and a rough estimate of phase 1 scope before any code is written.*
