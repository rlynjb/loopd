# Prompts as code: versioning and observability

**Industry name(s):** Prompts as code, prompt versioning, prompt observability, prompt-version pairing
**Type:** Industry standard · Language-agnostic

> Prompts are source. Put them in git, review them in PRs, pair each one with the model version it was validated against, and log which prompt-version produced which production output.

**See also:** → [01-anatomy](./01-anatomy.md) · → [05-eval-driven-iteration](./05-eval-driven-iteration.md) · → [11-meta-prompting](./11-meta-prompting.md)

---

## Why care

### Move 1 — The grounded scenario

Your app's AI feature regressed on Tuesday. Outputs that used to be useful are now confidently wrong about 30% of the time. You check the deploy log: no code change since Friday. You check the model provider: yes, they bumped the underlying model on Monday. The new model gives subtly different responses to the same prompt your app has been sending since launch. You'd like to compare "the prompt as it was on Friday" with "the prompt as it is now" — and a sample of the actual responses both produced. Your prompt is a 200-line template literal inside `caption.ts`. It's been edited four times since launch. The responses were never logged with their prompt version.

### Move 2 — Name the question the pattern answers

That what-produced-what question is what prompts-as-code answers. Not "is the prompt good," not "is the model good" — just *which exact prompt text, paired with which exact model version, produced this specific output*. The pattern is two halves: prompts in git as first-class source (so the history is reconstructable), and observability that logs the prompt-version + model-version pairing alongside every production response (so you can attribute regressions to specific changes).

### Move 3 — Why answering that question matters

**What breaks without it:** the model upgrades on Monday and you have no way to A/B the new model against the old prompt vs the new model against the same prompt with different framing, because you don't know which prompt was running which day. In buffr, the 5 chain files in `src/services/ai/` have been edited dozens of times across the project's life; git knows the history of `caption.ts`, but no production output is tagged with the commit hash that produced it. The day Anthropic deprecates Sonnet 4.6 and the chain regresses, debugging starts at "let me grep the git log for caption.ts and try to remember which version was deployed when."

### Move 4 — Concrete before/after

Without prompts-as-code + observability:
- Model bump on Monday → 30% of caption variants now sound the same
- You check `caption.ts` git log: 17 commits, none labelled with "validated against Sonnet 4.6"
- You read the current prompt to remember what it does, lose 45 minutes
- You revert to last week's prompt to A/B-test: outputs still bad, so the prompt wasn't the regression — the model was
- You're back to debugging by intuition; no metric, no comparison

With prompts-as-code + observability:
- Every commit to `caption.ts` is labelled in its message with the model version it was validated against (`"validated: claude-sonnet-4-6"`)
- Every production output is logged with `{ prompt_commit_hash, model_version }` alongside the response
- Monday bump → you query the log: same prompt_commit_hash, new model_version, regression visible in 30% of outputs
- Diagnosis: model regression, not prompt regression; file an upstream issue and pin to previous model version
- 20 minutes start-to-finish

### Move 5 — The one-line summary

Prompts-as-code is the same discipline you already apply to database migrations: the change is in git, paired with the schema version it targets, and every production query is attributable to a specific migration history. Without that pairing, debugging a regression in either is guessing.

---

## How it works

### Move 1 — The mental model

Two artifacts move together through your deployment pipeline: the prompt source (a `.ts` or `.md` file in git) and the metadata-pair tag on every production response (the prompt's commit hash, the model version it was validated against). When something regresses, the pair tells you which side broke.

```
   prompt.md (commit a1b2c3d)         logged production response
   ┌──────────────────────┐           ┌──────────────────────────┐
   │ "Summarize today's   │  ───────► │ {                        │
   │ entry..."            │           │   prompt_hash: 'a1b2c3d',│
   │                      │           │   model: 'sonnet-4-6',   │
   │ validated: sonnet-   │           │   output: "Today felt …",│
   │ 4-6 on 2026-05-01    │           │   ts: '2026-05-24T...',  │
   └──────────────────────┘           │ }                        │
                                      └──────────────────────────┘
                                                ▲
                                                │  regression debugging
                                                │  groups by hash + model
```

The pair is what makes regression debugging tractable. Same prompt_hash + new model_version + regressed outputs = model regression. Different prompt_hash + same model_version + regressed outputs = prompt regression. Different hash AND different model = bisect carefully.

### Move 2 — The layered walkthrough

**Layer 1 — prompts live in version-controlled files.** Not inline strings inside React components, not database rows edited via an admin UI without a git trail, not Notion pages, not Slack snippets. A file per chain (buffr's current shape) is the minimum; a file per section (system / context / examples / user — see [01-anatomy](./01-anatomy.md)) is the structural ideal. The file is reviewed in PRs like any other source code; every change has an author, a timestamp, a reason in the commit message.

```
   buffr today                            mature prompt repo
   ───────────                            ──────────────────
   src/services/ai/caption.ts             prompts/caption/
     export async function caption(...) { │  system.md       (validated: sonnet-4-6)
       const prompt = `…200 lines…`;      │  context.ts      (per-call data shape)
       const result = await call();       │  examples.md     (4 few-shot pairs)
       return result;                     │  user.ts         (request template)
     }                                    │  README.md       (this chain's purpose,
                                          │                   model version, eval refs)
```

If you're coming from frontend, this is the same pattern as moving inline CSS into stylesheet files — the source-of-truth lives somewhere greppable, reviewable, diffable. The pattern's payoff scales with prompt complexity: for buffr's 5-chain codebase the inline shape is acceptable; for a 30-chain codebase or a multi-PM team, the file extraction becomes load-bearing.

**Layer 2 — every commit is tagged with the model version it was validated against.** The pairing is a convention in the commit message or a frontmatter field in the prompt file. The reason: a prompt that works on Sonnet 4.6 may regress on Sonnet 5; without the pairing, you can't tell from `git log` whether a prompt change shipped before or after the model bump.

```
   commit pattern
   ──────────────
   commit a1b2c3d                                      <─ hash referenced by logs
   Author: ...
   Date:   2026-05-01

       caption: rotate "As you reflect" out of variant 3
       
       Validated against: claude-sonnet-4-6 (2026-05-01)
       Eval set: tests/ai/caption-eval.jsonl
       Regression: none (passed 47/50 cases)
```

If you're coming from frontend, this is the same discipline as recording the React version in a component's compatibility comment when you've used a 19.0-specific feature — the artefact lives next to the change so future maintainers can attribute behaviour to a specific version.

**Layer 3 — production outputs log the prompt-hash + model-version pair.** Every LLM call's response is logged alongside the metadata. The log doesn't need to be heavyweight — a single JSON line per call to a file or a managed observability service. The fields that matter: prompt_commit_hash (or a versioned alias if you don't want to expose the SHA), model_version, latency_ms, output_token_count, schema_fail (true/false), input_token_count, optional retry_count.

```
   per-call log line (one per LLM request)
   {
     "chain": "caption",
     "prompt_hash": "a1b2c3d",
     "model": "claude-sonnet-4-6",
     "input_tokens": 1247,
     "output_tokens": 312,
     "latency_ms": 1840,
     "schema_fail": false,
     "ts": "2026-05-24T18:34:12.045Z"
   }
```

If you're coming from frontend, this is the same discipline as logging the build commit hash alongside every error report so Sentry can show "this error appeared in build X.Y.Z." Production observability is the part that makes the version pairing actionable rather than ceremonial.

### Move 2.5 — Current state vs future state

In buffr today, the prompt-as-code discipline is half-present: prompts ARE in git as TypeScript template literals (good); commit messages occasionally name the model (inconsistent); and zero production calls are logged with the prompt hash + model version pair (missing).

```
          Now (buffr)                          Later (instrumented)
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ prompts: inline in .ts       │  │ prompts: inline in .ts (no change)│
│ commits: sometimes mention   │  │ commits: tag "validated: <model>" │
│   model, sometimes not       │  │   in every prompt-touching commit │
│ logs: nothing                │  │ logs: {prompt_hash, model, …} per │
│                              │  │   call to a metrics file or       │
│                              │  │   surface in cloud-sync settings  │
└──────────────────────────────┘  └──────────────────────────────────┘
   discipline implicit                discipline explicit + queryable
```

What doesn't have to change between phases: the prompts can stay as inline template literals in `.ts` files for now. The version-pairing convention is a commit-message + log convention, not a file restructuring. Phase B (multi-user) is when extracting prompts into separate files starts paying off — because at that point PMs want to iterate prompt copy without filing engineering PRs.

### Move 3 — The principle

Prompts are source. Treat them with the same operational discipline you treat database schemas: version-controlled, reviewed, paired with the runtime version they were validated against, observable in production. Skipping any of those means the next regression is debugged by intuition instead of by query.

The full picture is below.

---

## Prompts as code — diagram

```
┌─ Authoring layer ───────────────────────────────────────────────────────┐
│  developer edits prompt + commits to git                                 │
│    commit message includes: "Validated: <model-version>"                 │
│    PR review treats prompt as code                                       │
└──────────────┬──────────────────────────────────────────────────────────┘
               │  deploy → APK
               ▼
┌─ Runtime layer (device) ────────────────────────────────────────────────┐
│  chain call                                                              │
│    pre-call: read prompt source + model version constant                 │
│    LLM call to provider                                                  │
│    post-call: emit log line { chain, prompt_hash, model,                 │
│                input_tokens, output_tokens, schema_fail, latency }       │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼  log line via Supabase / Sentry / file write
┌─ Observability layer ───────────────────────────────────────────────────┐
│  aggregator                                                              │
│    query: group by (prompt_hash, model) → success rate, latency p99      │
│    query: filter (model = 'claude-sonnet-5') → regression detection      │
│    query: replay (prompt_hash) → reconstruct production behavior         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Buffr's 5 chain files:**

**File:** `src/services/ai/summarize.ts` / `caption.ts` / `expand.ts` / `classify.ts` / `interpret.ts`
**Function / class:** the 5 chain functions
**Line range:** the prompt template literals run roughly L40–L150 in each file

Prompts are in git as part of the source. The model version constants (`CLAUDE_MODEL`, `OPENAI_MODEL`) are defined at the top of each chain file but not logged with calls.

**Aipe's prompt assets:**

**Files:** `/Users/rein/Public/aipe/specs/*.md` (the skill specs — `study.md`, `refactor.md`, etc.) and `/Users/rein/Public/aipe/prompts/*.md` (one-off templates like `pr-review-protocol-v2.md`, `frontend-story-checklist.md`)

Aipe is the cleanest example in the portfolio of prompts-as-code at scale. Every spec is a markdown file in git; every iteration goes through a PR. The frontmatter on `pr-review-protocol-v2.md` (note the `-v2` in the filename) carries the version explicitly in the name — the v1 still exists in git history for reference. This is the structural shape buffr would converge toward if its prompt count grew.

---

## Elaborate

### Where this pattern comes from

The "prompts as code" framing was popularised by Hamel Husain, Eugene Yan, and the LangChain academy materials from 2023–2024. The pattern is a direct translation of database-migration discipline (versioned, reviewable, deployable) onto LLM prompts; the move from "edit the system prompt in the admin UI" to "ship prompt changes through the same PR pipeline as code" is what separated production LLM teams from prototypes in the 2023 window. Observability tooling (LangSmith, Helicone, OpenAI's own logs) started shipping later in 2024 to make the version-pairing actually queryable.

### The deeper principle

The artefact must be reconstructable. Whatever was running in production at time T — the prompt text, the model version, the SDK version — has to be reconstructable from git or from logs, ideally both. Without reconstructability, every regression debug starts with guesswork.

### Where this breaks down

When prompts are intentionally user-editable (admin UIs for non-engineer-tweakable prompts), the prompts-as-code discipline becomes prompts-as-database-rows — which is fine if the database has the same audit trail (who changed what when, paired with model version). The discipline isn't "always use git"; it's "always have an audit-trail equivalent."

### What to explore next

- [05-eval-driven-iteration](./05-eval-driven-iteration.md) — the eval set is what makes "validated against model X" mean something concrete instead of "I eyeballed it."
- [11-meta-prompting](./11-meta-prompting.md) — when an LLM generates prompts for another LLM call, the prompts-as-code discipline applies recursively: the generated prompt also needs versioning and validation.

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬───────────────────────────┐
│ Cost dimension   │ Prompts-as-code           │ Prompts-as-vibes          │
├──────────────────┼───────────────────────────┼───────────────────────────┤
│ Setup            │ Convention + per-call log │ Zero                      │
│ Regression debug │ Query: hash × model       │ Re-read git log + guess   │
│ PM iteration     │ Requires PR + engineer    │ Same (if prompts in code) │
│ Model bump risk  │ Quantifiable from logs    │ Anecdotal user reports    │
│ Audit trail      │ Git log + production log  │ Git log only              │
│ Onboarding       │ Convention to learn       │ "Find the prompts"        │
└──────────────────┴───────────────────────────┴───────────────────────────┘
```

### What we gave up

Treating prompts as code costs you the convention everyone has to learn: commits that touch prompts need the `Validated: <model>` tag in the message; every chain needs to emit a log line per call; the observability layer needs somewhere to land the logs. In buffr the cost is: one new convention (~5 minutes per commit), one helper function (`logChainCall()`, ~30 lines), one decision about where logs land (SecureStore is the wrong choice; a local SQLite table is the right choice; a Supabase table is the right choice when Phase B ships). Total cost: a half-day to set up, then ongoing convention adherence forever.

### What the alternative would have cost

Not having the discipline costs you every regression debug as it happens. The Sonnet 4.6 → 5 bump (when it comes) without prompts-as-code: 2 days of guesswork per chain, multiplied by 5 chains, equals a week of debugging that produces no general answer (next bump, same week of guesswork). With prompts-as-code: 30 minutes to query "which chains regressed after the model bump," followed by targeted prompt iteration on the ones that did. The breakeven is the first model bump after instrumentation lands.

### The breakpoint

Fine to defer until you've shipped a feature whose AI output is consumed by code (not just shown to a user as prose). The moment another code path depends on the AI output's shape or content, the regression-debugging cost compounds: a regression that shifts the distribution of `classify` outputs doesn't just look bad, it changes which downstream branches fire. Buffr's `classify` chain crossed that breakpoint when `todo_meta.type` started gating the `expand` schema selection — at that point the cost of NOT having instrumentation is one cascading regression bug away from being load-bearing.

---

## Tech reference (industry pairing)

### Git as the prompt store

- **Codebase uses:** every `.ts` file under `src/services/ai/` is git-versioned; commit history is the prompt history.
- **Why it's here:** the source-of-truth for what prompt was running at any commit hash. Without it, "what did our caption chain look like 6 months ago" is unanswerable.
- **Leading today:** Git + GitHub (or equivalent) — `adoption-leading` for source-of-truth versioning, 2026.
- **Why it leads:** ubiquitous, no setup, PR review is free, blame is free. Nothing else competes for "where do prompts live."
- **Runner-up:** Notion / Linear / database-as-prompt-store — only when non-engineers must edit prompts without an engineer in the loop, and only with a matching audit-trail mechanism.

### Observability layer (per-call logging)

- **Codebase uses:** Not implemented in buffr today. The closest thing is the `sync_meta.last_error` column that captures sync errors; no analogous structure for AI call telemetry.
- **Why it's here:** the production-log half of prompts-as-code; without it, the version pairing is ceremonial.
- **Leading today:** LangSmith — `innovation-leading` for LLM-specific observability, 2026. Tracks per-call prompt, model, latency, cost, and supports replay.
- **Why it leads:** purpose-built for the LLM debugging shape (prompt + model + response). Provides UI for grouping by prompt-version, comparing outputs, A/B testing.
- **Runner-up:** Helicone (`innovation-leading`, proxy-based instead of SDK-based — lower setup, lower fidelity); Sentry with custom breadcrumbs (`adoption-leading` for non-LLM-specific observability, sufficient for small scales like buffr).

---

## Project exercises

### B3.5 — Add per-chain call logging in buffr

- **Exercise ID:** `[B3.5]`
- **What to build:** add a helper `logChainCall(chain: string, meta: { promptHash: string; model: string; inputTokens?: number; outputTokens?: number; latencyMs: number; schemaFail: boolean })` that writes a row to a new local SQLite table `ai_call_log`. Call it from each of the 5 chains after the LLM response. Surface aggregate counts (calls per chain per day, latency p99, schema-fail rate) on the cloud-sync settings screen.
- **Why it earns its place:** the production-log half of prompts-as-code. Until this exists, every model bump is a guesswork debug. Once it exists, regression detection is a query.
- **Files to touch:** new `src/services/ai/metrics.ts` for the helper, `src/services/database.ts` for the table + migration, each of the 5 chain files for the call, `app/settings/cloud-sync.tsx` for the surface.
- **Done when:** open the settings screen on the device, see a row per chain showing calls today, latency p99, schema-fail %, and a 7-day chart.
- **Estimated effort:** 1–2 days.

### B3.6 — Establish a commit-message convention for prompt changes

- **Exercise ID:** `[B3.6]`
- **What to build:** write a one-page convention doc at `.aipe/project/prompt-version-convention.md` describing: every commit that touches a file under `src/services/ai/` must include a `Validated: <model-version> on <date>` line in the message body. A pre-commit hook (or just a CI check) verifies the line is present. Backfill the convention onto recent prompt-touching commits (the last 10) so the rule starts retroactively.
- **Why it earns its place:** zero-tooling, full benefit. Cost is one line per commit; payoff is git-log queryability for prompt-vs-model attribution.
- **Files to touch:** new `.aipe/project/prompt-version-convention.md`, optionally `.husky/commit-msg` or `.github/workflows/prompt-commit-check.yml`.
- **Done when:** convention doc exists; one or two recent prompt-touching commits have been edited (via `git rebase -i`) to demonstrate the format.
- **Estimated effort:** <1hr (doc only) or 1–4hr (with pre-commit hook).

---

## Summary

### Part 1 — concept recap

Prompts are source: they live in git, get reviewed in PRs, and pair with the model version they were validated against, while production calls log the prompt-hash + model-version pair so regressions are debuggable by query rather than by intuition. Buffr today has half the pattern — prompts ARE in git as `.ts` files — but no production logging and no version pairing in commit messages; regression debugging on the next model bump will start with guesswork. The constraint forcing this concept is that LLM behaviour changes under the codebase's feet whenever the provider bumps the model; without an audit trail, that change is indistinguishable from a prompt regression. The cost being paid for the current shape is that the first model bump that affects buffr's `classify` chain (which now gates downstream behaviour via `todo_meta.type`) will require manual debugging of every chain.

### Part 2 — key points to remember

- Prompts in git is the floor, not the ceiling. The ceiling is observability — production logs paired with prompt-hash + model-version per call.
- Without the version pairing, "what was running on Monday" is unanswerable; with it, regression debugging is a query.
- The pattern doesn't require extracting prompts into separate files — inline `.ts` template literals are fine until prompt count or PM-edit pressure forces extraction.
- Hamel Husain's writing is the canonical reference for this discipline.
- The first model bump after instrumentation lands pays back the entire setup cost; subsequent bumps are free.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "how do you debug an LLM regression," they're testing whether you've ever had a production LLM regression. The answer that names per-call logging with prompt-hash + model-version, plus the convention that prompts ship in git with model-validation tags, is the answer of someone who has been on call for an AI-feature incident. The answer that says "I'd add more logging" is the answer of someone who hasn't.

### Likely questions

**Q [mid]:** Where do you put prompts in your codebase?

**A:** In git, as code, reviewed in PRs. The shape can be inline template literals (buffr's current pattern — 5 chains, 5 `.ts` files, each holds its own prompt) or extracted into per-section files (`prompts/<chain>/system.md`, `examples.md`, etc.) when prompt count or PM-edit pressure justifies the extraction. The key isn't the file shape; the key is that the prompt is greppable, diffable, and has a commit history. Inline-in-Notion or stored-in-a-database-without-audit-trail are the patterns that break — at that point you've lost reconstructability.

```
   acceptable shapes              broken shapes
   ─────────────────              ─────────────
   inline template in .ts/.py     Notion page (no commit history)
   per-section .md files          DB row edited via admin UI
   YAML/JSON with frontmatter     Slack message someone copy-pasted
                                  in-app A/B test variants with
                                  no source-of-truth file
```

**Q [senior]:** Buffr's prompts are in `.ts` files. Why haven't you extracted them into markdown so the PM can edit?

**A:** Same answer as the anatomy file: buffr is solo-developer, the PM is the developer, the cost of extraction (~15 extra files for 5 chains, plus a composition function per chain) hasn't been paid for because the benefit hasn't been needed. Phase B (multi-user, real PM) is the breakpoint where the cost-benefit flips. Until then, inline template literals with commit-message version tags is enough discipline. The bigger gap right now isn't prompt-extraction — it's production logging. Without per-call logs, the next Sonnet bump is debugged by intuition regardless of where the prompts live.

```
   what extraction buys             what logging buys
   ─────────────────────            ───────────────────
   PM iteration without engineer    regression detection by query
   per-section diffability          A/B testing prompt variants
   ─────                            ─────
   needed at: multi-author teams    needed at: first model bump
   cost: 1 day                      cost: 1–2 days
   buffr: defer until Phase B       buffr: do now (B3.5)
```

**Q [arch]:** What's the cost of NOT having prompt observability when you scale to 100× the call volume?

**A:** Per-call cost is fine; the problem is incident response. At 100×, a regression that affects 0.5% of calls (50 cases at single-user scale, 5,000 at 100×) is the difference between "the developer notices in their personal use" and "5,000 angry users." Without observability, the diagnostic loop is: read user reports (anecdotal, biased), try to reproduce locally (which model? which prompt? which input shape?), eventually hotfix without confidence. With observability: query the log for the regression timeframe, group by prompt-hash and model, see the change-point exactly, attribute. The architecture cost at 100× isn't the logging itself (one row per call is sub-millisecond); it's the storage and query layer. At buffr's eventual scale, that's a Postgres table with appropriate indexes — same shape as `sync_meta`.

```
   today (single user)               100× (10k users)
   ─────────────────                 ───────────────
   call volume: ~30/day              call volume: ~300k/day
   regression detection: notice it   regression detection: query the log
   in your own use                   group by hash × model, see change
   ─────                             ─────
   storage: trivial                  storage: ~1MB/day, partition by day
   breaks first: detection latency   breaks first: aggregate query speed
```

### The question candidates always dodge

**Q:** Your prompts are inline template literals in TypeScript. That means every prompt change requires a full mobile-app rebuild. How is that defensible at all?

**A:** It isn't, fully. The cost is that fixing a typo in a prompt requires the full `expo run:android --variant release` + `adb install -r` cycle (~3 minutes warm cache, 15+ minutes cold). For a hosted web app the equivalent cost is a 30-second deploy. The benefit is type-safe composition (the chain function and the prompt template share a TypeScript scope; renaming a context field is a typed refactor, not a string-search-and-replace). For buffr specifically, the right move when EAS Update ships (it's configured but unused) is to keep prompts in `.ts` (type safety) but ship prompt changes as OTA updates so the deploy cost drops to ~30 seconds. The architecture decision isn't "prompts as code vs prompts as data" — it's "match the deploy cadence to the iteration speed you need."

```
   what was picked              what the OTA world looks like
   ───────────────              ─────────────────────────────
   inline .ts + APK rebuild     inline .ts + EAS Update push
   3min deploy per change       30sec deploy per change
   type-safe composition kept   type-safe composition kept
   ─────                        ─────
   cost: high iteration latency cost: setup ~30min one-time
   benefit: type safety         benefit: same + fast iteration
                                blocker: EAS Update never published
```

### One-line anchors

- Prompts are source. Treat them with database-migration discipline.
- The version pair (prompt-hash + model-version) is what makes regression debugging a query instead of a guess.
- Inline template literals in `.ts` are fine until you have a real PM or you cross 30 prompts; then extract.
- Hamel Husain on evals is the canonical reference.
- Per-call logging is the floor of LLM observability. Without it, every model bump is a re-debug.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw the three-layer flow: authoring (developer + git + PR), runtime (chain call + per-call log), observability (aggregator + queries). Label every box and arrow.

### Level 2 — Explain it out loud

Explain prompts-as-code to a colleague. Under 90 seconds.

Checkpoints — did you:
- Name git as the source-of-truth?
- Name the version pair (prompt hash + model version)?
- Name per-call observability as the production half?

### Level 3 — Apply it to a new scenario

A new requirement lands: buffr should support per-user prompt overrides — a "verbose" toggle that switches the `summarize` chain to a longer prompt variant.

Without looking at the code: how do you structure this so the prompt-as-code discipline still holds? Where does the variant prompt live? How does production logging tell you which variant produced which output?

Sketch your answer in 3–5 sentences.

### Level 4 — Defend the decision you'd change

The current "model versions named in chain-file constants but not logged with calls" approach is debt. Defend or oppose: "ship `B3.5` (per-call logging) before any other prompt-engineering improvement in buffr."

### Quick check — code reference test

Without opening files:
- Which file owns the model version constants for buffr's caption chain?
- Where would per-call AI call logs land if they existed?
- What does aipe's `pr-review-protocol-v2.md` filename tell you about its versioning convention?
