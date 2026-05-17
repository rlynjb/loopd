# buffr — Feature Spec: Thinking Modes for Todos

Last updated: 2026-04-26 · revision 5

An expansion of buffr's existing `[]` todos feature. Every `[]` line in journal prose gets classified into one of seven thinking modes (lifted from [buffr § 5](./buffr-build-upon-agent-spec.md#5-prompt-library)). Plain action items stay as plain checkboxes; ambiguous lines get an "expand" affordance that opens a side-panel modal with structured AI output. The `/todos` page stays a single flat chronological list — categories are *visible* on each row but don't reorganize the list. Bidirectional Notion sync extends the existing `syncAllTodos` to push/pull the new fields.

This spec extends [`spec.md`](./spec.md). It assumes familiarity with the existing todos feature (Section 6.3), data model (Section 5), Notion sync (Section 6.8), and architectural principles (Section 10) of buffr.

---

## 1. Purpose & Origin

This is the fifth revision of how to bring buffr's [Build Upon thinking-agent feature](./buffr-build-upon-agent-spec.md) into buffr. Earlier revisions explored a separate `>>` marker, a separate `/drops` page, and a category-grouped accordion. This revision lands on the simplest shape: **one marker, one flat list, categories as labels not sections.**

The reasoning: grouping by category creates an organizational tax. Every glance at the page asks the user "where did the AI put my thought?" instead of "what did I capture today?" A flat chronological list keeps the journaling rhythm intact — recent captures are right there in order, and the category badge is information you can act on without restructuring the view.

**The shape:**

You write `[] something` in your journal. A heuristic guesses if it's a plain action ("do X", "fix Y", "send Z" → instant `'todo'`, free, no LLM call). If it's ambiguous, a cheap classifier LLM call assigns one of the six non-todo modes (idea, bug, question, decision, knowledge, content). On `/todos`, the row appears at the bottom of a flat chronological list, with a colored category badge. Tap "expand" to open a side-panel modal that runs the per-type prompt and shows the structured output. The `[]` line in journal prose is never modified — it stays canonical.

**What it isn't:**
- Not a chat. One thought in, one structured artifact out per expansion.
- Not a buffr clone. We port the prompt library and chain-of-thought design. We don't port the agent state machine, project/session model, or graph database.
- Not a new marker, not a new page, not a new bottom-nav tab. The whole feature lives inside the existing todos surface.
- Not category-grouped. A flat chronological list with category badges and a category filter chip row.

**Scope at v1:** all seven thinking modes, heuristic-first classification with AI fallback, manual side-panel expansion, full bidirectional Notion sync (including autosync). Multi-pass expansion (buffr § 5 technique 2) is a v2 toggle.

---

## 2. The Seven Thinking Modes

| Type | Mode | Expansion behavior |
|---|---|---|
| `todo` | plain action item | **No expansion.** The row is just a checkbox. No "expand" button. This is the default for action-verb starts. |
| `idea` | exploratory thinking | Expand → `{ what, why, conditions, firstStep }` |
| `bug` | diagnostic thinking | Expand → `{ observed, expected, suspectedCause, reproSteps[] }` |
| `question` | analytical thinking | Expand → `{ answer, confidence, followUps[], toVerify }` |
| `decision` | evaluative thinking | Expand → `{ decision, reason, tradeoff, revisitWhen }` |
| `knowledge` | crystallization thinking | Expand → `{ concept, whereUsed, whyItMatters, example }` |
| `content` | communication thinking | Expand → `{ hook, keyPoints[], format, draftOutline }` |

Six expansion prompts at v1 (todo doesn't expand). All shapes are direct ports from buffr § 5.

---

## 3. The `[]` Marker — unchanged

The existing capture syntax in [spec.md § 2](./spec.md#2-drops--the-inline-marker-idiom) doesn't change. `[]`, `[ ]`, and `[x]` continue to behave exactly as today — line-start, optional bullet, two-pass scanner matching, dashboard round-trip on toggle.

What changes is what happens *after* a row is registered: it gets a type attached, and (for non-todo types) gains an expand affordance.

---

## 4. Data Model

### New SQLite table — `todo_meta`

Mirrors the `nutrition` table pattern (separate table tied to its parent by id). Holds all the new fields without bloating `entries.todos_json`.

| Column | Type | Notes |
|---|---|---|
| `todo_id` | TEXT PK | matches `TodoItem.id` from `entries.todos_json` |
| `entry_id` | TEXT | FK → `entries.id`; denormalized for join speed |
| `entry_date` | TEXT | denormalized for query speed |
| `type` | TEXT | one of seven; CHECK enforces. Default `'todo'`. |
| `expanded_md` | TEXT | nullable; structured markdown (see § 7) |
| `expanded_at` | TEXT | nullable ISO timestamp |
| `model` | TEXT | nullable; expansion model id |
| `classifier_confidence` | TEXT | `'high' \| 'medium' \| 'low' \| 'heuristic'`; the source of the type assignment |
| `classifier_model` | TEXT | nullable; null when classified by heuristic |
| `user_overridden_type` | INTEGER | 0 or 1; flips to 1 when user manually changes the type. Locks from re-classification. |
| `notion_page_id` | TEXT | nullable; populated by Notion sync. **Distinct from the existing `TodoItem.notionPageId`** — see § 11.1. |
| `notion_last_synced` | TEXT | nullable ISO timestamp |
| `created_at` | TEXT | ISO timestamp — used as the **primary sort key on `/todos`** |
| `updated_at` | TEXT | ISO timestamp |

**CHECK constraints:**
```sql
CHECK (type IN ('todo','idea','bug','question','decision','knowledge','content'))
CHECK (classifier_confidence IN ('high','medium','low','heuristic') OR classifier_confidence IS NULL)
```

**Indexes:**
- `todo_meta(entry_id)`
- `todo_meta(entry_date)`
- `todo_meta(type)` — used by the category filter
- `todo_meta(notion_page_id)`
- `todo_meta(updated_at)` — used by the Notion sync push
- `todo_meta(created_at)` — used by the page's primary sort

**Lifecycle invariant:** every `TodoItem` in `entries.todos_json` has exactly one row in `todo_meta`. The scanner enforces this — when it inserts a new todo into `todos_json`, it inserts a paired `todo_meta` row in the same transaction. When it deletes a todo, it deletes the meta row. There is never a todo without a meta row.

### Updates to existing tables

`sync_deletions.entity_type` already includes `'todo'` — no schema change needed for deletion sync.

### TypeScript types — extends [`src/types/`](../src/types/)

```typescript
// src/types/todoMeta.ts (new)
export type TodoType = 'todo' | 'idea' | 'bug' | 'question'
                     | 'decision' | 'knowledge' | 'content';

export type ClassifierConfidence = 'high' | 'medium' | 'low' | 'heuristic';

export interface TodoMeta {
  todoId: string;
  entryId: string;
  entryDate: string;
  type: TodoType;
  expandedMd: string | null;
  expandedAt: string | null;
  model: string | null;
  classifierConfidence: ClassifierConfidence | null;
  classifierModel: string | null;
  userOverriddenType: boolean;
  notionPageId?: string;
  notionLastSynced?: string;
  createdAt: string;
  updatedAt: string;
}

// Per-type expansion JSON shapes (LLM output, before serialization to markdown)
export interface IdeaExpansion {
  what: string; why: string; conditions: string; firstStep: string;
}
export interface BugExpansion {
  observed: string; expected: string; suspectedCause: string; reproSteps: string[];
}
export interface QuestionExpansion {
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  followUps: string[];
  toVerify: string;
}
export interface DecisionExpansion {
  decision: string; reason: string; tradeoff: string; revisitWhen: string;
}
export interface KnowledgeExpansion {
  concept: string; whereUsed: string; whyItMatters: string; example: string;
}
export interface ContentExpansion {
  hook: string;
  keyPoints: string[];
  format: 'post' | 'video' | 'thread' | 'tutorial' | 'vlog';
  draftOutline: string;
}

export type TodoExpansion =
  | { type: 'idea';      data: IdeaExpansion }
  | { type: 'bug';       data: BugExpansion }
  | { type: 'question';  data: QuestionExpansion }
  | { type: 'decision';  data: DecisionExpansion }
  | { type: 'knowledge'; data: KnowledgeExpansion }
  | { type: 'content';   data: ContentExpansion };
```

The existing `TodoItem` type is **not modified**.

---

## 5. Classification (heuristic-first, AI fallback)

Per the user-stated requirement: free path for the obvious 80%, smart path for the ambiguous 20%.

### 5.1 The two-stage flow

For each new todo at scan time:

1. **Heuristic pass** — run `heuristicClassify(text)`. Returns `'todo'` | `null`.
2. **If heuristic returned `'todo'`** — set `type = 'todo'`, `classifier_confidence = 'heuristic'`, `classifier_model = null`. Done. No LLM call.
3. **If heuristic returned `null`** (ambiguous) — fire the classifier LLM call. Returns one of the seven modes (the classifier may decide it's a `'todo'` even when the heuristic was unsure, e.g. unusual verbs). Set `type`, `classifier_confidence ∈ {high, medium, low}`, `classifier_model`.

### 5.2 Heuristic — [`src/services/todos/heuristicClassify.ts`](../src/services/todos/heuristicClassify.ts)

A small, fast, free function. No network. Returns `'todo'` only when confident.

Patterns that trigger `'todo'` (illustrative — final list during build):

- Starts with a common imperative verb: `do`, `fix`, `send`, `review`, `reply`, `call`, `email`, `submit`, `merge`, `deploy`, `update`, `delete`, `add`, `remove`, `rename`, `move`, `pick up`, `book`, `order`, `pay`, `renew`, `cancel`, `schedule`, `confirm`, `check`, `test`, `write`, `read`, `finish`, `start`, `clean`, `prep`, `buy`, `sell`, `text`, `dm`, `ping`, `push`, `pull`, `commit`.
- Starts with a possessive imperative: `gotta X`, `need to X`, `should X`, `have to X`, `must X`.
- Contains a deadline pattern: `by <date>`, `before <date>`, `today`, `tomorrow`, `this week`, `eod`, `eom`, `q[1-4]`.

Anything else returns `null`. Specifically, lines starting with question words (`why`, `how`, `what`, `when`, `is`, `are`, `does`, `should we`), conditional starts (`what if`, `maybe we`, `it would be cool if`), past-tense observations (`noticed that`, `realized`, `figured out`), or anything ending in `?` should return `null`.

The heuristic intentionally over-fires on `null`. False negatives (sending an obvious todo to the classifier) cost one cheap LLM call. False positives (mis-classifying an idea as a todo) cost a manual user override. Better to over-spend a tiny amount of LLM budget than to mis-categorize.

### 5.3 Classifier — [`src/services/todos/classify.ts`](../src/services/todos/classify.ts)

Cheapest available model (default: GPT-4o-mini if OpenAI configured, Claude Haiku if Anthropic configured — falls back to the configured primary). Single-pass, ~50 tokens out.

System prompt (sketch):

```
You classify short developer thoughts into one of seven thinking modes.
Read the thought. Pick the mode that matches the kind of thinking it
needs. Output ONLY a JSON object — no preamble, no markdown.

Modes:
- todo: a plain action item the writer intends to do.
- idea: a possibility, a "what if", an unproven direction.
- bug: something is broken or behaving unexpectedly.
- question: an unresolved question, often ending with "?" but not always.
- decision: a choice that has been made or is being committed to.
- knowledge: an observation or insight worth remembering.
- content: a thing the writer wants to publish, post, or share.

Respond with: {"type": "<mode>", "confidence": "high|medium|low"}
```

User message: just the todo text. **No surrounding context** — classification is intentionally context-free for speed and cost. Context comes back in at expansion time.

### 5.4 When classification runs

- **On first scan** of a new `[]` line (insert into `todos_json` + `todo_meta`).
- **Not on text-match** (Pass 1 of the two-pass scanner) — type preserved.
- **Not on line-index match** (Pass 2) — type preserved. Edits are treated as refinement.
- **Not when `user_overridden_type = 1`** — once corrected, never re-classified.

### 5.5 Confidence and the override path

| Confidence | UI signal |
|---|---|
| `'heuristic'` | none |
| `'high'` | none |
| `'medium'` | small "?" tucked inside the category badge (see § 8.3) |
| `'low'` | same as medium |

**No sort priority change** for low-confidence rows in this revision — the list is strict chronological. The user can find low-confidence rows by skimming for the "?" mark in badges. (Earlier revisions sorted low-confidence rows to the top of their category; with no category grouping, that mechanism doesn't apply.)

Manual type change (§ 8.6) flips `user_overridden_type` to 1 and locks the row from re-classification forever. Tapping the category badge opens the type picker directly.

### 5.6 Cost discipline

1. **Heuristic catches plain todos for free.** Expected to handle the majority.
2. **Cheapest model only** for the LLM fallback.
3. **Skip if no provider configured.** Ambiguous todos default to `type = 'todo'` and a banner appears on `/todos`: "AI classification disabled — configure in settings to categorize ambiguous todos."

---

## 6. Backfill

Every existing `[]` line in journal entries needs a `todo_meta` row. SecureStore-gated one-time migration: `todo_meta_backfill_v1_done`.

The backfill walks all existing todos in `entries.todos_json`. For each:
1. Insert a `todo_meta` row with `type = 'todo'` and `classifier_confidence = null` initially.
2. Run the heuristic. If it returns `'todo'`, set `classifier_confidence = 'heuristic'` and move on.
3. If it returned `null`, queue the row for batched classifier calls (5–10 per batch) using the cheap model.

Backfill batches run in the background after boot, not blocking app startup. Progress UI: a small banner at the top of `/todos` ("classifying 23 ambiguous todos…") that disappears when done. Failure is non-fatal — failed rows keep `type = 'todo'`.

---

## 7. Expansion (per-type prompts)

### 7.1 When it runs

Explicit user tap on the "expand" button on a row in `/todos`. Never automatic, never on commit.

The "expand" button is **hidden for `type = 'todo'` rows**. A plain todo doesn't need expansion.

### 7.2 Provider

Configured primary model (Claude Sonnet 4.6 or GPT-4o), via the existing AI service layer in [`src/services/ai/`](../src/services/ai/). Reuses credentials from `ai/config.ts`. If no provider configured, the "expand" button becomes a "configure AI" link.

### 7.3 Per-type prompts — [`src/services/todos/expandPrompts.ts`](../src/services/todos/expandPrompts.ts)

Six system prompts (todo doesn't expand). Stored as functions keyed by type, mirroring buffr § 5's `getSystemPrompt(type)` pattern:

```typescript
export function getSystemPrompt(type: Exclude<TodoType, 'todo'>): string;
export function getUserMessage(todo: TodoItem, meta: TodoMeta, context: ExpansionContext): string;
```

**Reasoning preambles** are lifted directly from buffr § 5:

| Type | Reasoning preamble |
|---|---|
| `idea` | "Before structuring this idea, think about: Is this solving a real problem or just interesting? What's the simplest version of this? What existing patterns relate to it? What would make this a bad idea?" |
| `bug` | "Before writing the report, reason through: What component or layer is this likely in, given the stack? What recent changes from the day's entries could have caused this? Are any sibling todos related? What would you check first if debugging this?" |
| `question` | "Before answering, consider: Does the user's recent context constrain the answer? Is there a common misconception here? What assumptions am I making? What would change the answer?" |
| `decision` | "Before recording this decision, think about: What were the alternatives? Why were they rejected? What's the strongest argument against this decision? Under what circumstances would this become the wrong choice?" |
| `knowledge` | "Before crystallizing this knowledge, consider: What's the essential insight here, stripped of context? Where else could this apply beyond the current situation? What would someone need to know to use this effectively? What's the most minimal, reusable example?" |
| `content` | "Before shaping this for an audience, think about: Who would care about this and why? What's the one thing they should take away? What makes this more interesting than a generic take? What format would reach them best?" |

### 7.4 Output schemas — direct port of buffr § 5

- **`idea`** → `{ what, why, conditions, firstStep }`
- **`bug`** → `{ observed, expected, suspectedCause, reproSteps[] }`
- **`question`** → `{ answer, confidence, followUps[], toVerify }`
- **`decision`** → `{ decision, reason, tradeoff, revisitWhen }`
- **`knowledge`** → `{ concept, whereUsed, whyItMatters, example }`
- **`content`** → `{ hook, keyPoints[], format, draftOutline }`

### 7.5 Context shape

Adapted from buffr § 4 to buffr's data model:

```typescript
interface ExpansionContext {
  entryDate: string;
  entryText: string;          // surrounding prose

  recentEntries: {            // last 3 days (excluding current), newest first
    date: string;
    text: string;
    aiSummary?: string;       // from ai_summaries cache if present
  }[];

  siblingTodos: {             // other todos in the same entry, max 5
    text: string;
    type: TodoType;
    done: boolean;
  }[];
}
```

### 7.6 Output: `expanded_md`

LLM returns JSON. Expander serializes to markdown via per-type templates. One template per type lives in [`src/services/todos/expandSerialize.ts`](../src/services/todos/expandSerialize.ts).

After successful expansion: `expanded_md`, `expanded_at`, `model`, `updated_at` all set.

### 7.7 Re-expansion

Manual only. Tap "re-expand" inside the modal:
1. Confirm via Alert ("Replace the existing expansion?")
2. On confirm, re-run. Overwrites `expanded_md`, updates `expanded_at` and `model`.

No expansion history at v1.

---

## 8. The `/todos` Page — flat chronological list

The existing `/todos` page restructures into a flat chronological list with a category filter row. **No category grouping, no accordion, no sectioning.**

### 8.1 Layout

```
─────────────────────────────────────
todos
8 total · oldest first
─────────────────────────────────────
[all] [open] [done]                              ← status filter
─────────────────────────────────────
[all] [☐ todo 3] [◊ idea 2] [? question 1] →    ← category filter (scrolls horizontally)
─────────────────────────────────────
☐  reply to design review thread
   ☐ todo                              fri · 5d ago
─────────────────────────────────────
☐  elbow flare on pull-ups shifts load to shoulders
   ≡ knowledge        ● expanded       mon · yesterday
─────────────────────────────────────
☐  going with notion-only sync, dropping supabase plan
   ⊕ decision         [expand]         mon · yesterday
─────────────────────────────────────
...
☐  build a thought tracker view next to nutrition
   ◊ idea             [expand]         tue · just now
─────────────────────────────────────
```

- **Header:** `todos` title + count subtitle (`"28 total · oldest first"`)
- **Status filter row:** existing `ALL` / `OPEN` / `DONE` chips. Unchanged behavior.
- **Category filter row:** new. `ALL` chip plus one chip per type with a count. **Scrolls horizontally** — eight chips don't fit in 380px.
- **Flat list:** every todo, **chronological by `created_at`, oldest at top, newest at bottom.** New captures append to the bottom of the list — you scroll down to see what's new.
- **Empty state:** unchanged from existing.

### 8.2 Sort order

**Strictly chronological by `created_at` ASC** (oldest first, newest last). No ranking, no carryover priority, no done-items-sunk-to-bottom. Done items strikethrough in place.

This is a significant behavior change from the existing `/todos` page, which uses [rank.ts](../src/services/todos/rank.ts)'s carryover/AI-gen/journal-origin priority. **The existing rank.ts is removed from `/todos`** but stays for the dashboard's `SmartTodoList` (per § 9 — actually, see § 9, the dashboard also flattens).

### 8.3 Row anatomy

```
☐  vlog mode that auto-detects format from clip count
   ◊ idea ?           [expand]         tue · 5h ago
```

- Existing checkbox (round-trips into prose via the existing `rewriteTodoLine` helper)
- Todo text (existing display, untruncated)
- **Category badge** (new): colored pill with the type icon and label. Tappable — opens the type picker (§ 8.6).
- **"?" mark** (new): rendered inside the category badge for `medium` / `low` confidence. Tap opens the type picker (same target as the badge itself).
- Expand button (new): only for non-todo types, only when `expanded_md IS NULL`. Tappable, opens the side-panel modal (§ 8.5).
- "● expanded" indicator (new): replaces the expand button when `expanded_md IS NOT NULL`. Tappable, opens the modal to view the existing expansion.
- Date · relative time (existing, unchanged): tappable, jumps to source entry.

For `type = 'todo'` rows: no expand button, no "● expanded" indicator. The badge still shows ("☐ todo") so the visual rhythm of the list is consistent.

### 8.4 Filter combinations

Status and category filters combine. Examples:

- `ALL` status + `ALL` category = every todo (default view)
- `OPEN` status + `idea` category = open ideas only
- `DONE` status + `ALL` category = all completed todos
- `ALL` status + `bug` category = all bugs (including resolved)

Subtitle updates to reflect the active filter: `"5 shown · ideas only"` or `"12 shown · open"`.

### 8.5 Side-panel expansion modal

Tapping `[expand]` or `● expanded` on a row opens a bottom-sheet modal that slides up over the page. The page underneath stays interactive (visible but dimmed).

Modal anatomy (unchanged from rev 4):
- Drag handle at top
- Header: type label + close (×) button
- Quote of the original todo text (italic, muted, on a slightly tinted background)
- Body: rendered `expanded_md` with section headers
- Footer: `[change type]` on the left, `[re-expand]` and `[close]` on the right

Dismissal: `[close]`, backdrop tap, swipe-down on handle, hardware back (Android). Returns to scroll position on `/todos`.

### 8.6 Manual type change

Two entry points:
1. **Tap the category badge** on any row — primary discovery path, always visible
2. **Long-press the todo text** — fallback for muscle memory

Both open the same bottom-sheet picker:

```
─────────────────
change type
"vlog mode that auto-detects format from clip count"
─────────────────
○ ☐ Todo
● ◊ Idea          ← current
○ ? Question
○ ⊕ Decision
○ ≡ Knowledge
○ ! Bug
○ ▸ Content
─────────────────
your choice locks this row from future AI re-classification    [cancel]
```

On confirm:
- Row's `type` updates, `user_overridden_type = 1`, list re-renders (the row stays in chronological position; only the badge color changes).
- Existing `expanded_md` is **kept but flagged stale** if the type changed away from a non-todo type — the row's `[expand]` button reads `[re-expand for new type]` and re-expand uses the new type's prompt.
- Switching to `'todo'` hides the expand button, but the existing `expanded_md` is preserved (in case the user switches back).
- `updated_at` bumps so the next sync pushes the new type to Notion.

### 8.7 No `+ new` button

Capture is journal-only. The `+ new` per-category button from rev 4 doesn't apply here (there are no category sections to scope it to). This is a deliberate simplification — capture happens in the journal, the todos page is for review.

### 8.8 Loading and error states

- Per-row expand: button → `thinking…` with spinner while modal opens. Modal shows a centered spinner until LLM responds.
- Network failure: toast + close modal + leave row alone.
- Malformed JSON: re-prompt once with stricter instruction. If still bad, error toast in the modal with `[try again]`.
- Provider not configured: button reads `configure AI`, links to `/settings/ai`.

Cap 3 in-flight expansions across the app.

---

## 9. Dashboard — flat chronological top 5

The home screen's `SmartTodoList` flattens to the **most recent 5 todos by `created_at` DESC** across all categories and all entries. No ranking. No category grouping. Newest at top (which is the inverse of `/todos`, intentionally — the dashboard answers "what's recent?", the page answers "what's been captured over time?").

Each row shows the same category badge as on `/todos`. Plain `'todo'` rows show the badge for visual consistency.

Tapping a non-todo row opens the side-panel modal (same modal as `/todos`). Tapping a plain todo continues to toggle done as today.

[`src/services/todos/rank.ts`](../src/services/todos/rank.ts) is **no longer used** by either the dashboard or `/todos`. The file can be deleted (or kept as dead code if you want a quick rollback path; mark it deprecated). The dashboard's display layer becomes a simple `getRecentTodos(limit: 5)` SQL query joining `todos_json` rows with `todo_meta` and ordering by `created_at` DESC.

This is a bigger behavior change than the rest of the spec — the existing rank logic (carryover yesterday → AI-generated → journal-origin) is loop-bearing in your current daily workflow. **Worth confirming before build:** are you sure you want to lose the carryover-from-yesterday priority on the dashboard? An alternative is to keep the dashboard ranked even when `/todos` flattens. See § 16 open question.

---

## 10. Navigation — unchanged

The existing five-tab bottom nav stays exactly as it is. No new tab. No journal toolbar change.

| Tab | Route | Icon |
|-----|-------|------|
| Home | `/` | `house` |
| Record | (modal) | red dot |
| Journal | `/journal/[date]` | `penLine` |
| Todos | `/todos` | `listTodo` |
| Nutrition | `/nutrition` | `utensils` |

---

## 11. Notion Sync

Bidirectional, extends the existing `syncAllTodos` orchestrator.

### 11.1 Mapping strategy

The existing Todos Notion DB (per [spec.md § 6.8](./spec.md#68-notion-sync)) gets new properties added. Sync is backwards-compatible (treats missing properties as defaults).

**Single Notion page per todo.** Both `TodoItem` data and `TodoMeta` data map to the same Notion page. The existing `TodoItem.notionPageId` and the new `TodoMeta.notionPageId` always reference the **same Notion page id**.

Updated property schema:

| Notion property | Type | Maps to | Notes |
|---|---|---|---|
| Text | Title | `TodoItem.text` | Existing |
| Done | Checkbox | `TodoItem.done` | Existing |
| Source Date | Date | `entry_date` | Existing |
| **Type** | Select | `TodoMeta.type` | **New.** Seven options. |
| **Expanded** | Rich text | `TodoMeta.expandedMd` | **New.** Holds the structured markdown. |
| **Model** | Select | `TodoMeta.model` | **New.** Optional. |
| **Confidence** | Select | `TodoMeta.classifierConfidence` | **New.** Four options. |
| **User Overridden** | Checkbox | `TodoMeta.userOverriddenType` | **New.** |

Existing Notion DBs without the new properties continue to work — sync detects missing properties and skips them on push, treats them as defaults on pull.

### 11.2 Source-of-truth rules

Buffr is **prose-canonical** — the `[]` line in `entries.text` is the source for `text`. Notion is a sync mirror.

| Field | Source of truth | Pull-down behavior on conflict |
|---|---|---|
| `text` | Local (prose) | **Ignore** Notion edits to Title. Log a warning in dev mode. The user shouldn't edit the title in Notion; if they do, it gets overwritten on next push. |
| `done` | Bidirectional | Standard `last_edited_time` merge per buffr's existing pattern. |
| `type` | Local | Notion changes pull down (treated like a manual override → sets `user_overridden_type = 1`). |
| `expanded_md` | Local (when present) | Notion changes pull down. |
| `model`, `classifier_confidence`, `user_overridden_type` | Local | Notion changes pull down. |
| `created_at` | Local | Never overwritten. |
| `updated_at` | Compared via Notion's `last_edited_time` | Standard merge. |

### 11.3 The sync orchestrator — `syncAllTodos()` extension

The existing function in [`src/services/notion/sync.ts`](../src/services/notion/sync.ts) extends to:

1. On pull: for each Notion page, look up both the `TodoItem` and the `TodoMeta` row. Merge per § 11.2 rules. Update both in a single transaction.
2. On push: read `TodoItem` joined with `TodoMeta`. Push the union to Notion as a single page update.
3. New row from Notion (created in Notion, no local match): create both `TodoItem` and `TodoMeta` together. Append the `[] ` line to today's entry text. Set `user_overridden_type = 1`, `classifier_confidence = null`.

### 11.4 Autosync wiring

Existing autosync in [`app/_layout.tsx`](../app/_layout.tsx) is unchanged structurally — `syncAll()` then `syncAllTodos()`. Internal behavior of `syncAllTodos` now handles the new fields.

### 11.5 Manual sync triggers — unchanged

Existing buttons in [`app/settings/notion-sync.tsx`](../app/settings/notion-sync.tsx) cover the new fields automatically.

### 11.6 Notion guide update

[`app/settings/notion-guide.tsx`](../app/settings/notion-guide.tsx)'s existing Todos DB section gets updated guidance for the new properties and a note that Title shouldn't be edited in Notion.

### 11.7 Migration for users with existing Todos DBs

First sync after this feature ships: if the user's existing Todos DB lacks the new properties, the sync code logs a one-time toast: "Your Notion Todos DB is missing the new fields. See the updated guide in Settings to add them." Sync continues to work without the new fields.

---

## 12. Service Layer — extends [spec.md § 7](./spec.md#7-service-layer--srcservices)

| Path | Purpose |
|---|---|
| `todos/heuristicClassify.ts` | Free heuristic: text → `'todo' \| null` |
| `todos/classify.ts` | Classifier LLM call: text → `{ type, confidence }`. Cheapest configured model. |
| `todos/expandPrompts.ts` | Six system prompts + shared user-message builder |
| `todos/expandSerialize.ts` | Per-type JSON → markdown templates |
| `todos/expand.ts` | Expansion orchestrator |
| `todos/typeMeta.ts` | Type metadata: icon, label, color, ordering — single source for UI |
| `todos/migrateMeta.ts` | One-time backfill of `todo_meta` rows. SecureStore-gated `todo_meta_backfill_v1_done`. |
| `todos/getRecentTodos.ts` | New: simple chronological query for the dashboard (replaces rank.ts use) |

**Updates to existing files:**

- `database.ts` — schema for `todo_meta`, CRUD, migrations
- `services/todos/scanTodos.ts` — when inserting a new todo into `todos_json`, also insert paired `todo_meta` row in the same transaction. Triggers heuristic + classifier inline.
- `services/todos/crud.ts` — Notion page id writes/reads cascade across both `TodoItem` and `TodoMeta`. Deletes cascade.
- `services/todos/rank.ts` — **deprecated.** Not called from anywhere after this feature ships. Mark as such; remove in a follow-up.
- `services/notion/sync.ts` — `syncAllTodos` extended per § 11.3.
- `services/notion/todosMapper.ts` — extended for the new properties with safe handling for missing properties.
- `app/_layout.tsx` — adds the `todo_meta` backfill check.
- `app/todos.tsx` — full restructure: flat list, status filter row, category filter row (horizontal scroll), expand modal, type-change picker. **No accordion, no category sections.**
- `app/index.tsx` — `SmartTodoList` switches to chronological top 5 with category badges.

---

## 13. Architectural Principles — adherence checklist

| Principle | How this feature honors it |
|---|---|
| 1. DB is the single source of truth | `/todos` and the dashboard read from `entries.todos_json` joined with `todo_meta`. No frontend filtering of "stale" data. |
| 2. Prose is canonical for drops | `[]` lines in entry text are the source. `todos_json` and `todo_meta` are derived. **Notion never edits source prose** — § 11.2's `text` rule enforces this. |
| 3. Save to DB on every keystroke; scanners only at commit | Scanner runs from `editEntry`, never on keystroke. The heuristic runs free at commit; the classifier LLM call adds latency only when the heuristic returned null. |
| 4. Always read DB before deleting | Expand, re-expand, type-change, delete all re-fetch from DB before mutating. |
| 5. Never clear live refs in focus cleanup | N/A. |
| 6. Don't auto-delete during sync | Todo deletions queue via `sync_deletions`; sync orchestrator never deletes locally. |
| 7. Two-pass matching is the way | Existing `[]` two-pass scanner unchanged. Type preserved on both passes. |
| 8. Backfills are SecureStore-gated, one-time | § 6 — `todo_meta_backfill_v1_done`. |

A new principle this feature suggests, worth promoting to [`CLAUDE.md`](../CLAUDE.md):

> **9. Classifier output is editable; user override is permanent.** Any AI-assigned attribute on a derived row must be overridable by the user, and the override must lock that attribute from future AI mutation. The `user_overridden_type` flag pattern is the template.

> **10. Heuristic before LLM.** When a feature needs classification, scoring, or routing, try a deterministic heuristic first. Only fall through to an LLM call when the heuristic is uncertain. Cheaper, faster, and more debuggable.

---

## 14. Implementation Order

| Step | What | Est. |
|------|------|------|
| 1 | Migration: `todo_meta` table + indexes | 1–2h |
| 2 | Types: `todoMeta.ts` (TodoMeta + 6 expansion shapes); database.ts CRUD | 2h |
| 3 | typeMeta.ts (icons, labels, colors, badge styling per type) | 1h |
| 4 | Heuristic: `heuristicClassify.ts` + unit tests on 30+ real examples | 2h |
| 5 | Classifier: `classify.ts` + cheapest-model selection logic + tests | 2–3h |
| 6 | Update `scanTodos.ts` to write paired `todo_meta` rows + run heuristic + classifier | 3–4h |
| 7 | Backfill: `migrateMeta.ts` with batched classifier calls + wire into `_layout.tsx` | 2–3h |
| 8 | Expansion prompts: `expandPrompts.ts` with all six system prompts + reasoning preambles | 3–4h |
| 9 | Serializer: `expandSerialize.ts` with six per-type markdown templates | 1–2h |
| 10 | Expander: `expand.ts` (context loader + LLM call + JSON parse + serialize + write back) | 3–4h |
| 11 | `/todos` page restructure: flat list, status filter row, **horizontal-scroll category filter row** | 2–3h |
| 12 | Per-row UI: existing checkbox preserved, **inline category badge with type icon and confidence "?"**, date, expand button, expanded indicator | 2–3h |
| 13 | Side-panel expansion modal: layout, loading state, re-expand, change type, dismissal | 3–4h |
| 14 | Manual type change picker (tap badge or long-press text) | 1–2h |
| 15 | Loading/error states (in-flight cap, malformed JSON retry, no-provider banner) | 1–2h |
| 16 | Dashboard `SmartTodoList`: switch to chronological top 5 with category badges; deprecate rank.ts use | 1–2h |
| 17 | Notion mapper extension: new properties, missing-property tolerance | 2–3h |
| 18 | `syncAllTodos` extension: read/write the new fields, dual notion_page_id storage | 2–3h |
| 19 | Notion guide: updated Todos DB section with new properties | 1h |
| 20 | Test pass: heuristic accuracy, classifier accuracy, edit-after-expand preservation, type-override persistence, **filter combination correctness**, Notion bidirectional including text-edit-rejection | 3–4h |

**Total: ~33–50h.** Slightly smaller than rev 4 (~37–55h) because the page is simpler — no accordion logic, no `+ new` modal, no per-category state management.

---

## 15. What This Spec Does NOT Cover

- **Multi-pass expansion** (buffr § 5 technique 2) — v2 toggle.
- **Cross-entry context** — analog to buffr's Tier 4 Memgraph. Out of scope.
- **Sharing or exporting expansions outside Notion** — out of scope.
- **Conversational follow-up** — out of scope.
- **Round-trip back into prose** — explicitly rejected. Prose stays clean, expansion lives in the modal.
- **Auto-expansion on commit** — explicitly rejected. Manual tap only.
- **Auto re-classification when text is edited** — once classified, type is sticky unless the user manually changes it.
- **A separate `>>` marker** — explicitly rejected. One marker, one scanner, one page.
- **Category-grouped view** — explicitly rejected in this revision. Flat list with category filter chips instead.
- **Ranked ordering** — explicitly rejected. Strict chronological, oldest first on `/todos`.
- **Done items sunk to bottom** — explicitly rejected. Done items strikethrough in chronological place.
- **Expansion history** — re-expand overwrites.
- **Search across todos** — v1.1 candidate.
- **Notion editing of source `text`** — § 11.2 explicitly drops these edits.

---

## 16. Open Questions

- **Final heuristic verb list** — 50–80 verbs covering Rein's actual capture patterns. Build from a real export of recent `[]` lines before locking it.
- **Classifier model fallback chain** — if neither GPT-4o-mini nor Haiku is configured, do we (a) fall through to the configured primary, (b) skip classification with a banner, or (c) refuse? § 5.6 currently picks (b).
- **Backfill batch size** — 5–10 todos per classifier call. Need to design the batch prompt.
- **Notion `text` edit silent-overwrite vs warn-and-skip** — § 11.2 currently says ignore-and-overwrite. Pick one.
- **Where does a Notion-originated todo attach?** Today's entry (simpler) vs preserve-Source-Date (more correct). Default: today.
- **Dashboard ranking — confirm.** § 9 flattens the dashboard to chronological top 5, removing the carryover-from-yesterday priority. **This is a big behavior change for your daily flow.** Worth a real test before committing — alternative is to keep the dashboard ranked even when `/todos` flattens. Specifically: a todo that's been open for 3 days will keep falling lower on the dashboard as new captures push it down. Is that desired?
- **Done items sort behavior** — § 8.2 leaves done items in chronological place with strikethrough. Alternative is "sink to bottom of the visible list." Pick one.
- **Category badge color on `'todo'` rows** — should plain todos get a neutral/no badge to reduce visual noise (since they're 60%+ of the list)? Or keep the badge for consistency? Prototype shows the badge; § 8.3 keeps it.
