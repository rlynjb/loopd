# Chapter 7 — Developer Process

## Opening — what you're looking at

The repository is structured around a memory bank for an AI coding agent. The `.aipe/` directory at the root holds three project-context files (`context.md`, `rules.md`, `stack.md`) and a `specs/` directory with versioned plans, audits, and interview prep. The `docs/` directory holds the canonical design documents: `spec.md` (product + technical), `concepts.md`, per-feature specs (`loopd-cloud-sync-spec.md`, `loopd-thinking-modes-spec.md`, `relatable-caption-spec.md`), and the `dsa-study-guide.md`. Together these files are the contract between me and the AI assistants — Claude.ai for design conversations, Claude Code for implementation.

The workflow is spec-driven, not vibe-driven. Before I implement a non-trivial feature, I write a spec — usually in a Claude.ai conversation, sometimes from a brainstorming skill — that names the data model changes, the architectural principles it has to respect, the failure modes I expect, and the rollout (including any backfill). Once the spec exists in `docs/`, Claude Code is given the spec and told to implement against it, with the rules.md as guardrails. The split is deliberate: Claude.ai is the design partner (high-context conversation, no tool use), Claude Code is the implementation partner (tool-using, file-aware, runs in the repo). Treating them as one tool collapses the design step.

The codebase has no CI. No automated test suite. No PR review (solo dev). What it has instead: TypeScript strict mode that must pass before commit, manual end-to-end testing on a connected Android device after each meaningful change, an architectural rules document treated as non-negotiable, and a `docs/backlog.md` with everything I deliberately deferred. The discipline that replaces CI is *writing down what I decided and why* — every spec contains a "decisions" section, every rule in `rules.md` has a one-sentence reason, every backlog item has a "deferred because" note. That trail is what lets me come back six weeks later and remember why a piece of code is shaped the way it is.

### ASCII diagram — feature lifecycle

```
   Idea / problem to solve
         │
         ▼
   ┌─────────────────────────────┐
   │ Brainstorm (Claude.ai)      │
   │  - explore shape            │
   │  - identify failure modes   │
   │  - draft data model         │
   └────────────┬────────────────┘
                │
                ▼
   ┌─────────────────────────────┐
   │ Write spec (docs/<feat>.md) │  - human-edited markdown
   │  - data model               │  - lives in repo
   │  - rules it must satisfy    │  - referenced by name later
   │  - backfill plan            │
   │  - rollout                  │
   └────────────┬────────────────┘
                │
                ▼
   ┌─────────────────────────────┐
   │ Implement (Claude Code)     │
   │  - given spec + rules.md    │
   │  - writes code              │
   │  - I review every diff      │
   │  - manual test on device    │
   └────────────┬────────────────┘
                │
                ▼
   ┌─────────────────────────────┐
   │ Update spec to match shipped│   - drift detection
   │ Update CLAUDE-style memory  │   - .aipe/project/* refresh
   └────────────┬────────────────┘
                │
                ▼
   commit. tsc --noEmit must pass.
```

The lifecycle is enforced by convention. The penalty for skipping the spec step is paid weeks later when I (or the next agent session) can't reconstruct why a piece of code exists. The penalty for skipping the spec-update-after-shipping step is the spec drifts and stops being useful — same outcome, different path.

---

## Concepts (four-part structure)

### 1. The .aipe memory bank as project context

**Shape.** Three files compose the project's persistent context: `.aipe/project/context.md` (stack, data model, file structure, what must not change), `rules.md` (12 architectural principles + coding style + file naming), `stack.md` (pinned dependency versions). These are loaded into every AI agent session at the start.

**Rule.** Anything an AI agent needs to know about this codebase that isn't derivable from the source files belongs in one of the three. Anything derivable from source (file paths, function signatures, current behavior) belongs in source. The split keeps memory small and current. Updates happen when constraints change, not when implementation changes.

**Failure mode.** Without the memory bank, every session starts cold and the agent has to rediscover the rules by reading half the codebase. That's slow and error-prone — the agent might not find rule 5 ("never clear live refs in focus cleanup") until it reproduces the bug that rule prevents. The memory bank front-loads the constraints so the agent operates within them from the first message.

**Contrast.** The `docs/` specs are *not* the memory bank — they're the design archive. The memory bank is the active context loaded into every session; the design archive is the historical record of what was specced. The constraint that distinguishes them: the memory bank has to fit in a context window, the archive doesn't. Memory bank is policy; archive is history.

### 2. Spec-driven implementation

**Shape.** Three artifacts are produced for any non-trivial feature: a brainstorming document (often a Claude.ai chat saved as markdown), a formal spec in `docs/<feature>-spec.md`, and a working plan in `docs/<feature>-plan.md` for multi-phase work. The plan tracks which phases are done; the spec is the contract.

**Rule.** Code does not get written without a spec for any feature with more than two of: a new table, a new sync surface, a new AI call, a new architectural principle. The spec must name the failure modes and the migration path before implementation starts. Trivial features (one component, no schema change) skip the spec.

**Failure mode.** Vibe-driven implementation produces code that satisfies the immediate prompt but doesn't think about backfills, cross-device sync, or rollback. The relatable-caption feature is a counter-example to this failure: it has a 100+ line spec at `docs/relatable-caption-spec.md` that names forbidden patterns, theme enum boundaries, the fallback behavior when generation fails, and the per-LLM-call independence rule. Without the spec, the caption generator would have shipped without the fallback path and the editor would have broken on the first generation timeout.

**Contrast.** Bug fixes don't need specs — the spec was already written; the fix restores it. The constraint that distinguishes a feature from a bug fix is "does it change the rules?" New rule → spec. Existing rule, current code wrong → fix.

### 3. Manual test discipline as test substitute

**Shape.** Three things compose the manual test harness: a connected Android device running `npx expo run:android`, a fixed mental checklist of golden paths (type a sentence with `[]`/`**`/`#`, toggle from dashboard, open editor and export), and `adb logcat` for inspecting `console.warn` errors that wouldn't surface in the UI.

**Rule.** Every meaningful code change is exercised on the device through at least the three golden paths before commit. `npx tsc --noEmit` must pass. If the change touches a scanner, the test set expands to include in-place edits, line reorderings, and undo cases.

**Failure mode.** Without manual testing, type-checked code can still ship visual regressions, race conditions that only manifest on real devices, and FFmpeg behaviors that work in dev but fail on specific Android versions. The classifier toast positioning is an example — it's absolutely positioned and only looks right when tested with the keyboard open on a real screen. A simulator wouldn't catch it.

**Contrast.** The TypeScript type system catches the other class of regression — wrong field names, missing properties, null not handled. Type checking and manual testing cover different surfaces. Type checking is fast and complete on its surface; manual testing is slow and incomplete but catches the visual and runtime cases. Together they cover most of what an automated test suite would catch, except for property-based regression in the pure functions (the scanners, the rank function).

---

## Interview questions

### [mid] Walk me through how you'd add a new prose-derived feature — say `@person` for tagging contacts.

**Model answer.**

I'd write the spec first. The shape: `@person` is a new marker pattern in entry prose, like `#tag` for threads but with case-preserving display and no auto-create on save (typing `@randomstring` should not create a contact). The data model: a `contacts` table with `id`, `name`, `slug` (slug-from-name), and a `contact_mentions` junction with `contact_id`, `entry_id`, `todo_id`, `source_line`, `tag_text`. The scanner: `src/services/contacts/scanContacts.ts` with a `parseContacts` regex (`/(^|[^\w])@([a-zA-Z][a-zA-Z0-9-]*)/g`), code-span masking, and two-pass reconcile. The autocomplete: a sibling component to `TagAutocomplete` that fires when the cursor sits after `@xyz`.

The architectural rules I have to respect: prose is canonical (Principle 2), two-pass matching (Principle 7), backfill is SecureStore-gated (Principle 8). The auto-create deviation that threads use (#tag auto-creates a thread) does *not* apply to contacts — typos to people's names are worse than typos to project names, so unknown `@person` is a no-op until the user explicitly creates the contact via the autocomplete chip.

After the spec, I'd implement against it: create the table in the database migration, write the scanner, wire it into `useEntries.editEntry` after the existing scanners, write the autocomplete component, add the backfill migration with a SecureStore gate (`contact_mentions_backfill_v1_done`), add the cloud sync adapter under `src/services/sync/tables/contactMentions.ts` and `contacts.ts`, and add the tables to the orchestrator's push and pull order arrays. Manual test on device: type `@alice`, see autocomplete, tap to register; type a journal entry mentioning `@alice`, verify the mention shows on her contact detail page. Update spec to match shipped behavior. Commit.

### [senior] How do you decide what goes in `docs/spec.md` versus a feature-specific spec versus the rules document?

**Model answer.**

`docs/spec.md` is the project's identity document. It answers "what is loopd, what does it do, how is it shaped?" The 12 architectural principles in §10 are the load-bearing rules — they're the things a reader needs to understand before any feature spec makes sense. New principles get added to spec.md only when a pattern appears for the second time across two unrelated features (e.g., "every prose-derived feature has a SecureStore-gated backfill" became Principle 8 after both todos and nutrition shipped one).

A feature-specific spec under `docs/<feature>-spec.md` is everything that's *only* about that feature: the marker pattern, the prompts, the validator shapes, the migration. Once the feature ships and stabilizes, the high-level shape goes into spec.md (e.g., the `#tag` thread system has a one-paragraph summary in spec.md §6.6 and the full design in `loopd-thinking-modes-spec.md` and the cloud-sync version in `loopd-cloud-sync-spec.md`). Long-form rationale stays in the feature spec so spec.md doesn't become unreadable.

`.aipe/project/rules.md` is the tightest layer — the things an AI agent needs to enforce on every code change. Coding style ("strict TypeScript, hooks-first, Pressable over TouchableOpacity"), file naming patterns, and the architectural non-negotiables. Anything in rules.md is binary: code either satisfies it or doesn't. Anything that needs nuance or context-dependent judgment lives in spec.md or a feature spec, not in rules.md. The split keeps the rules document scannable — it's a checklist the agent can run mentally on each diff.

### [arch] How would you onboard a second engineer to this codebase?

**Model answer.**

Day one is the spec, not the code. I'd hand them `docs/spec.md` first — read it cover to cover, ~30 pages. The 12 principles in §10 are the test: if they can recite the rationale for principle 7 (two-pass matching) without looking at code, they understand the codebase. Then `.aipe/project/rules.md` for the coding style and the non-negotiables. Then the feature-specific specs for any subsystem they'll touch. Roughly a half-day of reading.

Day one afternoon is the codebase tour. Open `src/services/database.ts` — there are eleven tables, walk through the schema and migration runner. Open `src/services/todos/scanTodos.ts` — read the two-pass scanner, this is the load-bearing pattern. Open `src/services/sync/orchestrator.ts` — the sync layer. Open `app/journal/[date].tsx` — the keystroke contract. Four files, four hours, and they've seen the spine of the system.

Day two is a small change. I'd give them a backlog item of contained scope — maybe the `docs/backlog.md` entry to add a "soft-deleted row count" indicator on the cloud sync settings screen. The work touches: a DB read, a settings UI component, no schema change, no scanner, no AI. They'd write the spec for it themselves (one paragraph), implement it, commit it, demo it on a device. The point is to learn the lifecycle, not to ship something hard.

The thing I'd warn them about explicitly: the prose-canonical invariant is invisible. It's easy to write code that mutates `todo_meta.type` from a UI handler and feel like it worked, until the next entry edit reverts it because the source prose hadn't been touched. Every UI affordance that changes a typed record's user-facing state must round-trip into prose. I'd point them at `rewriteTodoLine` in `src/services/todos/crud.ts` as the canonical example. Internalizing that pattern is the difference between adding a feature that satisfies the codebase and adding a feature that *fights* it.

---

## The hard question

### "You're effectively pair-programming with an AI on most of this. What do you actually do that the AI can't?"

**Model answer (≥200 words).**

I write the rules. The AI implements against them; I decide what they are. That's the load-bearing distinction. When I added `user_overridden_type` to lock the classifier, the AI didn't propose that — I proposed it because I'd seen the failure mode (classifier flipping the user's choice on the next commit). When I split the relatable caption into a separate LLM call with its own try/catch, the AI didn't propose the firewall — I proposed it because I'd seen the structured summary fail when caption generation timed out. The architectural principles in `docs/spec.md` §10 are observations I made; the AI executed on them.

I also do the integration thinking. The AI is good at writing a scanner; it's bad at noticing that the new scanner has to fire after the existing scanner because the new one needs the old one's output for tag attribution (the `scanThreadsForEntry`-after-`scanTodosFromText` order). That's the kind of thing that doesn't surface from reading any single file — you have to hold the whole commit lifecycle in your head and ask "what depends on what?" The AI can do it when prompted with the question; it doesn't do it spontaneously.

I do the failure-mode forecasting. When I read a proposed implementation, the question I ask is "what breaks?" — not "does this satisfy the prompt?" Most of my edits to AI-generated code are edge cases the prompt didn't enumerate: "what if the user backgrounds the app between this line and the next," "what if the model returns malformed JSON," "what if this scanner fires twice in fast succession." That's pattern recognition from past bugs; the AI doesn't have that pattern library yet.

What the AI does that I won't: typing speed, syntactic correctness, breadth of API knowledge, willingness to write the boring boilerplate (the per-table sync adapters, the fixture data for testing, the JSDoc comments I'd skip). I'm strictly faster with the AI than without it for everything in this list. But every architectural decision in this codebase — every principle, every spec, every constraint — was made by me. The interview question's framing ("what do you do that the AI can't") implies a contest. The honest answer is they're complementary: the AI is faster than I am at writing; I'm better than the AI at deciding *what* to write. When a recruiter asks "is this AI-assisted code or your code," the answer is "both, and the boundary is the rules document." That's defensible because the rules document exists, in this repo, with my fingerprints all over it.
