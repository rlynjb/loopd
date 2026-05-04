# Chapter 04 — AI product engineering

This chapter is about the engineering decisions *around* the AI calls — the parts that don't show up on the model card. Cost discipline, context budgets, evaluation strategy, fallback design, spec-driven development, the boundary between deterministic code and the model. If chapter 01 was *how the AI is wired*, this chapter is *how the wiring was decided*.

---

## 4.1 Cost-aware model routing (cheap classifier vs primary expander) · `foundational`

**What it is.** Every AI workflow in the app explicitly picks the cheapest model that meets the bar. Classification uses Haiku / GPT-4o-mini (~10× cheaper than the primary). Expansion and summarization use Sonnet 4.6 / GPT-4o. The choice is hard-coded per call site, not configurable per call.

**Where it lives.**
- `src/services/todos/classify.ts` — `claude-haiku-4-5-20251001` / `gpt-4o-mini`.
- `src/services/todos/expand.ts:20-21` — `claude-sonnet-4-6` / `gpt-4o` for the expander.
- `src/services/ai/summarize.ts:9-10` — same primary models for the structured summary.
- `src/services/ai/caption.ts` — uses the primary models too (caption needs phrasing quality).

**Why it exists.** The expander costs ~$0.04–$0.05 per call (`src/services/todos/expand.ts:24`). Classification is automatic for every todo on every commit — running expander-grade pricing across that volume would be financially irresponsible. The hard-coded routing per call site is the simplest way to enforce the discipline; making it configurable would invite mistakes.

**General rule.** AI cost is dominated by call frequency × model tier. High-frequency / low-stakes calls deserve the cheapest model. Low-frequency / high-stakes calls deserve the best. The routing decision belongs at the call site, not in a config file — config would let an operator silently raise the bill 10×.

---

## 4.2 Context-window budgeting via per-source caps · `intermediate`

**What it is.** When building the user message for an LLM call, every variable-length context source has a hard byte cap. The expander caps each recent entry at 1000 chars; the prompt builder caps the entry text at 1000 chars; the recent-captions cache is capped at 5 entries.

**Where it lives.**
- `src/services/todos/expandPrompts.ts:127-130` (`capText`):

```ts
function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '… (truncated)';
}
```
- Used at lines 104 and 121 (1000 chars each).
- Caption builder: `src/services/ai/summarize.ts:130-139` (last 5 cached captions only).
- Sibling todos in expansion context: capped at 5 in `expand.ts:163`.

**Why it exists.** Without caps, a heavy journaling day (5000-character entry) would balloon the prompt to tens of thousands of tokens — slower, costlier, more likely to hit context limits. The 1000-char cap is a practical "enough context to be useful, not enough to be expensive" line. The "… (truncated)" suffix is honest signaling to the model that it's seeing partial content.

**General rule.** Every variable-length input to a prompt needs a budget. Fail-loud truncation (with a marker) beats silent dropping. The cap is a tunable; pick it by measuring the p95 useful input size, not the worst case.

---

## 4.3 Spec-driven AI development · `intermediate`

**What it is.** Every AI feature in the app starts as a *written spec* in `docs/`, gets reviewed against architectural principles, then gets implemented. The relatable-caption feature is the cleanest example: `docs/relatable-caption-spec.md` defines the behavior; `src/services/ai/caption.ts` implements it line-for-line.

**Where it lives.**
- `docs/relatable-caption-spec.md` — full spec for the caption feature.
- `src/services/ai/caption.ts` — implementation that references the spec inline.
- The thinking-modes spec: `docs/loopd-thinking-modes-spec.md` defines the classifier + expander behavior; `src/services/todos/classify.ts` and `expand.ts` implement.
- `docs/loopd-cloud-sync-spec.md` is the spec for the entire sync layer.

**Why it exists.** AI features are easy to fudge: ship the prompt, eyeball the outputs, declare victory. That works for prototypes and rots in production. Writing the spec first forces you to articulate what "done" looks like (forbidden patterns, edge cases, fallback behavior) before you have a working prompt to anchor on. Then the spec becomes the test oracle when you tune the prompt later.

**General rule.** Treat AI prompts like code: spec, review, implement, evaluate, iterate. The spec is the single source of truth for "what should the model produce?" — the prompt is a *current best implementation*, not the spec.

---

## 4.4 Memory bank pattern: externalized context via `.aipe/` · `intermediate`

**What it is.** A directory of markdown files (`.aipe/project/context.md`, `rules.md`, `stack.md`) that capture project-specific context an AI assistant would otherwise have no way to know. Read on every assistant session start.

**Where it lives.**
- `.aipe/project/context.md` — project context.
- `.aipe/project/rules.md` — coding style, file naming, testing requirements, architectural non-negotiables (see lines 20–32 — the 11 architectural principles enumerated explicitly).
- `.aipe/project/stack.md` — pinned dependency versions.
- `.aipe/specs/` — per-feature specs.

**Why it exists.** The model has no memory between sessions. Without a memory bank, every conversation re-discovers the architecture, re-asks the same questions, re-makes the same wrong assumptions. The memory bank is "the context I'd otherwise have to type into every prompt" — captured once, read every time.

**General rule.** When a tool has no memory, build the memory layer yourself. For AI coding agents specifically: a `rules.md` listing your non-negotiables is the highest-leverage file in your repo. The same idea, internal to the app's own AI (cached AI summaries as caption context), shows up in chapter 01 §1.7.

---

## 4.5 Graceful degradation around model failures · `intermediate`

**What it is.** Every AI call has a defined fallback for when it fails. The summarizer's caption call is wrapped in try/catch (`src/services/ai/summarize.ts:85-95`) — if it fails, the structured summary still ships and the editor falls back to `summary.summary` for the overlay text. The classifier returns null on no-AI-configured rather than throwing. The expander returns a typed `{ ok: false, reason }` discriminated union rather than throwing.

**Where it lives.**
- Caption fallback: `src/services/ai/summarize.ts:85-95`.
- Expander result type: `src/services/todos/expand.ts:201-203`:

```ts
export type ExpandResult =
  | { ok: true; expandedMd: string; model: string }
  | { ok: false; reason: 'no-ai' | 'in-flight-cap' | 'wrong-type' | 'malformed' | 'network' | 'not-found'; message?: string };
```

- The "AI not configured" UI banner: `app/todos.tsx` shows it persistently when ambiguous rows exist and no AI key is set.

**Why it exists.** AI calls fail. Networks drop, models hallucinate, rate limits hit. A production app cannot let any of those failures user-facing-crash. The discriminated `ExpandResult` is type-driven: the caller is forced to handle every failure reason because TypeScript exhaustiveness will fail compilation otherwise.

**General rule.** Model the failure space as a closed enum (`reason: 'no-ai' | 'malformed' | ...`) and force the caller to handle each case. Falling back to a less-good experience (caption fails → use summary) is dramatically better than crashing — and the user usually doesn't notice.

---

## 4.6 Boot-time catch-up vs. live-write reconciliation · `intermediate`

**What it is.** Two complementary code paths that converge on the same goal. Live: every entry commit fires `reconcileTodoMetaForEntry` (which classifies new ambiguous todos). Boot: a one-pass `classifyAmbiguousMeta()` walks every meta with `classifier_confidence IS NULL`, skips done-or-overridden rows, and runs the cheap classifier. Self-quiet when no AI is configured.

**Where it lives.**
- Live reconcile: `src/services/todos/reconcileMeta.ts`.
- Boot catch-up: `src/services/todos/migrateMeta.ts` (`classifyAmbiguousMeta`, `countAmbiguousNotDone`).
- Triggered from app boot in `app/_layout.tsx` (see `docs/spec.md:80`).

**Why it exists.** Live-only reconcile leaves rows behind: any todo that pre-dated the classifier shipping never gets classified. Boot-only would never classify newly-typed rows until the next restart. The two paths together guarantee convergence: every existing-but-stale row gets cleaned up at boot; every new row gets handled at write time.

**General rule.** When a feature requires "every row eventually has property X," you typically need both a live trigger (for new rows) and a sweep (for old rows the live trigger missed). Migrations are the one-time version of the sweep; boot-time catch-up is the recurring version.

---

## 4.7 User-overridable AI output with permanent lock · `foundational`

**What it is.** Every AI-assigned attribute is overridable by the user, and the override permanently locks that attribute from future AI mutation. Implementation: a boolean column (`user_overridden_type`) that the AI classifier checks before writing.

**Where it lives.**
- The principle: principle 9 in `docs/spec.md:460`.
- The lock column: `todo_meta.user_overridden_type` (see `docs/spec.md:199`).
- Enforced in: `src/services/todos/classify.ts` (the classifier skips locked rows) and `src/services/todos/migrateMeta.ts` (the boot catch-up skips them too).

**Why it exists.** Users will disagree with the model. If the user picks "idea" and the next classifier run flips it back to "todo", the user feels overridden by the machine and stops trusting any AI output. The lock makes user agency permanent: once the user has opinion-ed, the AI defers forever.

**General rule.** Any AI-assigned attribute on user data needs a "user has opinion-ed" flag that locks future AI mutation. The flag is cheap (one boolean per row); the trust it preserves is priceless. This is the engineering form of the design rule "never overwrite user intent."

---

## 4.8 Two-call chain with structured handoff · `intermediate`

**What it is.** The vlog-summary feature is two LLM calls chained by data: call 1 produces the structured `AISummary` (mood, headline, clip order, etc.); call 2 (`generateCaption`) consumes the `mood` field plus other context to produce the relatable caption. The structured-summary mood is *translated* (`good` → `'good'`, `flat` → `'flat / low energy'`) so the caption prompt sees natural-language strings.

**Where it lives.** `src/services/ai/summarize.ts:144-153` — the `moodLabel` translation:

```ts
const moodLabel = (() => {
  switch (mood) {
    case 'flat': return 'flat / low energy';
    case 'ok': return 'steady';
    // ...
  }
})();
```

Then line 155–161 packages it into `CaptionInput`.

**Why it exists.** Each call has one job. Call 1's job is structured composition (clip ordering, overlays). Call 2's job is short-form anti-cliché copywriting. Forcing one call to do both would compromise both prompts. The handoff via a typed `CaptionInput` makes the chain testable — you can construct a `CaptionInput` by hand and exercise just the caption prompt.

**General rule.** AI chains pass *typed data* between calls, not raw text. Each call's output is parsed/validated before becoming the next call's input. The translation step (mood enum → mood label) is the seam — it's where call 1's output schema meets call 2's input schema.

---

## 4.9 Tonal-continuity context injection · `intermediate`

**What it is.** The caption call receives the **last 5 cached captions** (from `ai_summaries`) as `recentCaptions`, telling the model: "you wrote these recently — don't repeat their structure or vocabulary." Anti-repetition by example.

**Where it lives.** `src/services/ai/summarize.ts:130-139` (the read), and the spec at `docs/relatable-caption-spec.md` (the use). The cached row reader is `getRecentAISummaries(beforeDate, limit)` — see `docs/spec.md:197`.

**Why it exists.** Without recent context, every day's caption sounds like every other day's. With it, the model can self-vary. The 5-row window is a balance: too few and continuity is weak; too many and tokens run away.

**General rule.** When sequential AI outputs need stylistic continuity (or anti-repetition), inject recent outputs as examples. The model interprets them as "here's the shape and tone I should match (or vary from)." Cheaper than fine-tuning and works in one prompt.

---

## 4.10 Provider-agnostic config storage · `foundational`

**What it is.** AI keys and provider choice live in `expo-secure-store`. The `getProvider()` and `getAnthropicKey()` / `getOpenAIKey()` helpers abstract the storage. Call sites read the provider, branch on it, and pick the right key.

**Where it lives.** `src/services/ai/config.ts`. Used by every AI service file. The settings UI at `app/settings/ai.tsx` is the only writer.

**Why it exists.** Keys must not be in code (security). Hard-coded provider choice would prevent users from picking the model they prefer. SecureStore is the standard mobile credential store on Android (Keystore-backed), so keys are encrypted at rest.

**General rule.** Secrets and user preferences belong in OS-level secure storage on mobile (Keystore on Android, Keychain on iOS). Provider choice is a user preference; keys are secrets; both belong in SecureStore. Never check a key into source.

---

## 4.11 Evaluation by inspection (no automated AI evals) · `advanced`

**What it is.** The honest gap. There is no automated eval suite for any of the AI calls. Evaluation happens by manual inspection — the developer reads the model output in dev, tunes the prompt, ships. The classifier confidence field (`'high' | 'medium' | 'low' | 'heuristic'`) is the closest thing to a self-reported eval.

**Where the gap lives.** Conceptually, in any place where an automated eval would catch regressions:
- A held-out set of 100 todos with known correct types — would catch classifier prompt regressions.
- A scoring rubric over caption outputs (forbidden-word checks, length constraints) — would catch caption regressions.
- Golden-output fixtures for the structured summary — would catch prompt drift.

**Why it doesn't exist (yet).** The app is solo-dev, no test suite anywhere (`.aipe/project/rules.md:17`), and the eval infrastructure cost would dwarf the feature work. The classifier_confidence enum is a meaningful self-eval signal; the validate-and-retry path is a meaningful structural eval. Both are honest tradeoffs.

**General rule.** AI evaluation has three tiers: (1) shape/schema validation (cheap, you should always do this), (2) automated rubric scoring (medium cost, do this when prompts are mature), (3) human eval against held-out data (expensive, do this for high-stakes apps). Even shape validation alone catches a lot.

> **Go deeper.** The simplest eval you could add tomorrow: dump the last 50 classifications to a CSV, label them by hand, compute precision/recall, store as a baseline. Re-run after any prompt change and compare. No framework needed — just `console.log` and a spreadsheet.

---

## 4.12 Surfacing AI uncertainty to the user · `intermediate`

**What it is.** When the classifier returns `'medium'` or `'low'` confidence, the UI shows a `?` indicator on the type badge. When no AI is configured but ambiguous rows exist, a banner prompts the user to set a key. The user always knows when the model is unsure.

**Where it lives.**
- The confidence enum: `ClassifierConfidence = 'high' | 'medium' | 'low' | 'heuristic'`.
- The badge: `app/todos.tsx` (see `docs/spec.md:131`) — *"Confidence '?' appears on medium/low rows."*
- The banner: `app/todos.tsx` (see `docs/spec.md:137`) — *"AI-not-configured banner — persistent inline prompt when ambiguous rows exist and no AI key is set."*

**Why it exists.** Hiding model uncertainty is a trust failure. Users who see `?` on a low-confidence row know to verify; users who don't see it assume confidence and get burned. Showing uncertainty also makes the override-and-lock pattern (§4.7) feel natural — the row asked you to weigh in.

**General rule.** Surface model uncertainty to the user when it's actionable. A `?` next to a low-confidence label invites the user to correct it; an invisible low-confidence label sits there silently being wrong.
