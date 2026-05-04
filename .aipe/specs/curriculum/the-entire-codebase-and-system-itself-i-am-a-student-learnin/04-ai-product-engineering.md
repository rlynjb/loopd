# 04 — AI product engineering

This chapter is about the **product** side of building AI features: the design choices that determine whether a feature feels useful, fast, and trustworthy versus slow, expensive, and uncanny. Some of these overlap with the technical patterns in `01-agentic-ai.md` — but here the lens is **what the user feels**, not what the code does.

loopd is a single-user product where every AI call costs the user (their key, their bill, their time). That constraint makes AI-product tradeoffs unusually visible. In a B2B SaaS app where AI is "free for the user," many of these decisions could be made differently — but you'd be making them, you just wouldn't see them as obviously.

---

## 4.1 Cost-per-call as a first-class design constraint

**Difficulty:** foundational

**What it is.** A discipline of knowing — for every AI call your app makes — roughly what it costs in dollars per call, and using that number to make design decisions: when to call, how often, what model.

**Where it lives.** Every model choice in loopd is annotated with cost reasoning:

- Classifier: `'cheapest available models for classification — single-pass JSON out. Both are fast and ~$0.0001 per call at this prompt size.'` — `src/services/todos/classify.ts:6-8`.
- Expander: `'Each call is ~$0.04-0.05; stacking three is fine, more than that gets expensive fast.'` — `src/services/todos/expand.ts:24-25`. The `MAX_CONCURRENT = 3` cap is a **direct cost guardrail**.
- Summary + caption: pinned to primary models (Sonnet 4.6 / GPT-4o), implicitly ~$0.05/day per active user.

The classifier-vs-expander split (two-stage, see §1.3) exists *because* of cost. Cheap-model-everywhere would be lazy; expensive-model-everywhere would be unaffordable. The split is the design artifact of taking cost seriously.

**Why it exists.** Without cost awareness, AI features either silently overspend (until the user notices the bill) or under-deliver (because the team picked the cheapest model out of fear). Knowing the per-call cost lets you make informed tradeoffs: "is this $0.05 worth it for this user-perceived value?"

**General rule.** For every AI call site in your app, write down (in a code comment) the rough per-call cost and the trigger frequency. Compute the per-user-per-day cost. If it surprises you, redesign.

---

## 4.2 User-controlled triggers for expensive operations

**Difficulty:** foundational

**What it is.** A pattern where the system **never** runs an expensive AI operation automatically. Instead, the user explicitly taps a button to request it.

**Where it lives.**
- **Expansion** is manual. From `docs/spec.md` §6.4: *"Expansion (manual, never automatic)."* The view is at `app/todos/[id].tsx`; auto-triggers only on mount of the detail page when the row has no expansion AND has a non-todo type — meaning the user navigated there with intent.
- **Vlog summary** auto-runs on editor mount (see §4.6 below) — but only when the user opens the editor. They had to tap "Vlog" first.
- **Re-expand** at the detail page footer requires a confirm Alert before overwriting existing expansion.

Contrast with classification (auto, on every commit, $0.0001) — the cheap thing runs automatically; the expensive thing waits for a tap.

**Why it exists.** Auto-expanding every todo on commit would (a) cost ~$0.05 per todo when the user might not care about that todo, (b) introduce a slow loading state on every entry save, (c) make the AI feel intrusive. Waiting for an explicit tap aligns cost with intent: the user has already decided the expansion is worth their time.

**General rule.** Expensive AI operations should be **pull, not push.** The user signals "I want this now" by an action; the system runs the call; the result is cached. Anything cheap can be auto/eager. Drawing the line at "cost > some threshold" is the cleanest way to decide.

---

## 4.3 Spec-driven development (the spec is the source of truth)

**Difficulty:** intermediate

**What it is.** A discipline where a written specification document precedes implementation, and the implementation cites the spec inline (in comments) at decision points. The spec is the canonical reference for "why is it this way?"

**Where it lives.**
- The main spec: `docs/spec.md` (~50,000 chars, sections 1–10).
- Feature specs: `docs/loopd-cloud-sync-spec.md`, `docs/loopd-thinking-modes-spec.md`, `docs/loopd-today-habits-threads-spec.md`, `docs/relatable-caption-spec.md`.
- Plans (working documents that track implementation against spec): `docs/loopd-cloud-sync-plan.md`, `docs/loopd-today-habits-threads-plan.md`.

Inline citations to the spec are everywhere in the code — search for `spec §`:
- `src/services/todos/heuristicClassify.ts:6` — `'Per spec §5.2 the heuristic intentionally over-fires on null.'`
- `src/services/todos/classify.ts:11` — `'Per spec §5.3 — context-free for speed and cost.'`
- `src/services/sync/types.ts:3` — `'See docs/loopd-cloud-sync-spec.md §6.2.'`

**Why it exists.** Specs are how a single developer (or a small team) keeps multi-month features coherent. Writing the spec **first** forces the question "do I actually understand what I want this to do?" before any code is written. Citing the spec **in the code** turns the spec into a load-bearing reference document — it's not "the doc the team wrote and forgot," it's "the doc the code points to when explaining itself."

The .aipe/ directory (the one this curriculum is in) is the same idea applied to *AI agents*: when an agent works on the codebase, it reads the project context first.

**General rule.** Write the spec first. Cite it in the code at every decision point. Update both when the design changes. Spec-as-load-bearing-doc is a discipline worth holding even when you're a solo dev — your future self has no memory of why you made decisions, and the spec is the cheapest way to give it back.

---

## 4.4 Memory bank patterns (.aipe + project context)

**Difficulty:** intermediate

**What it is.** A pattern where AI agents working on a codebase have a **memory layer** they read before doing work — files outside the codebase that describe project context, rules, stack, and prior decisions.

**Where it lives.**
- `.aipe/project/context.md`, `.aipe/project/rules.md`, `.aipe/project/stack.md` — project-level context the agent loads before starting work.
- `.aipe/specs/` — saved specs (curriculum, refactor plans, audit reports) that persist across sessions.
- Global `~/.config/aipe/global/` — user-level identity, rules, stack preferences that apply across all projects.

The same pattern exists in `~/.claude/projects/-Users-rein-Public-loopd/memory/` for the Claude Code agent specifically (a more granular per-conversation memory layer, but conceptually identical: the agent has no in-built memory; you build the memory layer yourself).

**Why it exists.** LLMs have no memory of what they did yesterday or of the project's invariants. Without a memory bank, every session starts cold — the agent re-derives context from grep'ing the codebase, often missing nuance that wasn't in the code (the *why*, the *don't-do-this*, the *we-tried-that-and-it-failed*).

The .aipe pattern externalizes that nuance. When the agent reads `rules.md` and sees `'Strict TypeScript. npx tsc --noEmit must pass before any commit'`, it now knows a hard constraint without having to discover it via a failed PR.

**General rule.** When a tool has no memory of its own, **build the memory layer yourself**. Externalize project context, rules, and lessons-learned into files the tool reads at session start. The memory layer is to AI agents what `CONTRIBUTING.md` is to human contributors — the difference between expensive re-derivation and quick onboarding.

---

## 4.5 Tonal continuity via prior-output context

**Difficulty:** advanced

**What it is.** Passing the **last N outputs** of a generative AI feature back into the next call as context — to prevent repetitive phrasing, maintain a consistent voice, and let the model *avoid* what it already said.

**Where it lives.** Caption generation pulls the last 5 cached captions:

- `src/services/ai/summarize.ts:130-139`:
  ```ts
  const recentRows = await getRecentAISummaries(date, 5);
  const recentCaptions: string[] = [];
  for (const row of recentRows) {
    try {
      const parsed = JSON.parse(row.summaryJson) as Partial<AISummary>;
      if (parsed.caption) recentCaptions.push(parsed.caption);
    } catch { /* skip malformed */ }
  }
  ```

- The caption prompt at `src/services/ai/caption.ts:74-78` uses these:
  ```
  Recent captions (avoid repeating phrasing or formula):
  <last 5 captions joined by ---->
  ```

- The system prompt at `caption.ts:42-46` calls out three formulas to rotate across days, and reminds the model to "check recent captions to avoid repetition."

**Why it exists.** Without this, every day's caption would be subtly the same — the model has a strong default voice, and unrelated daily entries would still produce captions with similar opening words and similar shapes. Including the recent captions explicitly tells the model "don't do these again." The result is a more varied, more human-feeling output stream over time.

**General rule.** For repeated generative output (daily captions, weekly summaries, scheduled posts), pass the last few outputs as anti-repetition context. Cap the count to manage tokens (loopd uses 5). The model will naturally diversify, and you get tonal continuity *plus* freshness without doing per-feature de-duplication logic.

---

## 4.6 Auto-generation on intent surfaces (vlog editor mount)

**Difficulty:** intermediate

**What it is.** A pattern where AI generation runs automatically when the user reaches a surface that **specifically requests** the AI feature — but only when there's no cached output already.

**Where it lives.** The vlog editor at `app/editor/[date].tsx`:
- On mount, if no `AISummary` exists for the date, calls `summarize(date)`.
- If a summary exists, hydrates from `ai_summaries` cache instead.
- Re-running the AI requires the explicit "REGENERATE WITH AI" button in the TEXT tab.

`app/todos/[id].tsx` does the same for expansion: auto-triggers on mount when the row has no `expanded_md` AND has a non-todo type.

**Why it exists.** The user navigated to the vlog editor specifically to see their vlog. Making them tap a "Compose with AI" button before the AI runs would be redundant — the navigation **is** the request. But once it ran, re-running on every revisit would be wasteful and would produce subtly different output each time. The cache-or-generate pattern makes the first visit fast-feeling and subsequent visits instant.

**General rule.** When a screen exists *specifically* to display AI output, generating on first visit is the right default. Cache the output. Treat regeneration as an explicit user action — never re-run on revisit.

---

## 4.7 Anti-repetition + voice rules in system prompts

**Difficulty:** intermediate

**What it is.** Encoding **what the model should never do** as explicit prohibitions in the system prompt, alongside what it *should* do. "Never start with 'Today I…'" is just as load-bearing as "Use first-person present-progressive."

**Where it lives.** The caption system prompt at `src/services/ai/caption.ts:33-46`:

```
NEVER:
- Start with "Today I…"
- List more than 2 actions
- Use hustle language ("crushed", "shipped", "executed", "locked in")
- Use motivational closers or hashtags
- Use self-help phrasing ("the journey", "trust the process")
- Overexplain the lesson
```

Each of these is a **specific failure mode the team observed** during prompt iteration. They got captured as explicit prohibitions because writing "make it sound natural" doesn't carry that information.

**Why it exists.** Models default to common phrasings. Common phrasings have accumulated a recognizable "AI wrote this" feel. Listing the prohibited phrasings is the most direct way to push the model away from them. Combined with the "FORMULAS" section (which gives three rotation patterns), the model has both **what to avoid** and **what to reach for**.

The "EDGE CASES" section at `caption.ts:48-53` does the same thing for input shapes — "empty rawLog → caption based purely on mood; do not fabricate actions" is a learned response to "the model invented work the user didn't do."

**General rule.** Your system prompt should encode lessons learned from prior outputs. When the model produces something bad, ask "what's the rule it violated?" and add that rule. Over time, the prompt accumulates a defense against the failure modes you've actually seen — much more useful than aspirational positive instructions alone.

---

## 4.8 The AI feature gracefully degrades (no-key path)

**Difficulty:** intermediate

**What it is.** Every AI feature in loopd has a "no AI configured" path where the rest of the app keeps working. Nothing crashes, nothing nags repeatedly, and the affected UI shows a clear, single-time prompt.

**Where it lives.**
- `classifyTodo()` returns `null` when no key is configured (`src/services/todos/classify.ts:91-93`). Caller leaves `type='todo'`, `classifier_confidence=null`, retries on next boot.
- `expandTodo()` returns `{ ok: false, reason: 'no-ai' }` (`src/services/todos/expand.ts:221-222`). UI catches the typed reason and shows "configure AI to expand."
- `summarize()` returns `{ summary: null, error: 'No API key configured' }` (`src/services/ai/summarize.ts:45`). Editor falls back to non-AI composition.
- `/todos` page shows a persistent "AI not configured" banner only when ambiguous rows exist (per spec §4 todos screen): the prompt appears in context, not as a top-level nag.

**Why it exists.** Some users won't have an AI key. Some will have one provider configured but not the other. The product must work — at reduced fidelity — without AI at all. Any feature that *requires* AI must surface that requirement at the moment the user would benefit from configuring it, not as an upfront wall.

**General rule.** AI features should degrade, not crash. Define the "no AI" behavior upfront — what the feature looks like, what it tells the user, when it nags vs. stays silent. The degraded path isn't a bug; it's a real user state.

---

## 4.9 Cost vs. capability tradeoff (when to escalate models)

**Difficulty:** advanced

**What it is.** The deliberate decision of *which* model tier handles *which* job, based on whether the job needs reasoning quality (use the expensive model) or just structured output (use the cheap one).

**Where it lives.** The split is encoded in module constants:

| Job | Cheap path | Expensive path | Why this side |
|---|---|---|---|
| Classify todo type | `gpt-4o-mini` / `claude-haiku-4-5-20251001` | — | Single-pass JSON, ~50 tokens out, no reasoning needed |
| Expand non-todo into structured form | — | `gpt-4o` / `claude-sonnet-4-6` | Chain-of-thought + structured generation needs better reasoning |
| Compose vlog summary | — | `gpt-4o` / `claude-sonnet-4-6` | Multi-field structured output with semantic constraints |
| Generate caption | — | `gpt-4o` / `claude-sonnet-4-6` | Tonal nuance + edge-case handling, defensible output |
| Test connection | `gpt-4o-mini` / `claude-sonnet-4-6` | — | Just need to verify the key works |

The pattern is: **cheap when the answer space is small and well-defined; expensive when nuance matters.** Note that `testConnection()` at `summarize.ts:164-187` uses different models for OpenAI vs Anthropic — `gpt-4o-mini` is OpenAI's cheapest reliable model, but Anthropic's Haiku doesn't accept arbitrary system prompts in some paths, so testConnection uses Sonnet (the primary). That's a per-provider quirk, captured in code rather than papered over.

**Why it exists.** Using Sonnet for classification would cost ~50× more per call. Using Haiku for vlog composition would produce visibly worse output that the user would notice and reject. The split is the result of saying "this job's quality bar is X; this is the cheapest model that meets X."

**General rule.** Match model tier to job tier. For each AI call site, ask: "what's the smallest cheapest model that passes this bar?" That's the right model. Re-evaluate when new models ship — both sides of the cost/capability frontier move.

---

## 4.10 Evaluation by hand, not by metric

**Difficulty:** advanced

**What it is.** loopd has **no automated evaluation suite** for its AI features. Quality is judged by the developer's own experience using the app daily, plus the spec's explicit prohibitions and formulas. No regression tests, no eval harness, no LLM-as-judge.

**Where it lives.** Implicit. The spec at `docs/relatable-caption-spec.md` is the closest thing — it's a behavioral spec with examples of good and bad output. The "FORMULAS" and "NEVER" sections in the caption system prompt (`src/services/ai/caption.ts:42-46`) capture what was learned by hand.

**Why it exists.** Loopd is a single-user app where the developer **is** the user. They can judge quality directly by running the app. An eval suite would (a) cost time to build, (b) cost API budget per run, (c) only approximate the lived-experience signal. For a product at this scale, hand-evaluation is the right tool.

That said: this is a real limitation. As soon as a second person uses the app, "the developer's judgment" stops scaling. The first eval you'd want is an LLM-as-judge for caption quality (does it follow the formulas? does it use forbidden language?). That would be a great learning project on this codebase.

**General rule.** Match evaluation rigor to product surface area. Solo dev + small surface = hand eval is fine. Multi-user + multi-feature = build an eval harness, even a crappy one. The harness's job is to catch *regressions* you couldn't catch by trying things by hand.

---

## 4.11 Latency budget vs. perceived performance

**Difficulty:** intermediate

**What it is.** A discipline of knowing how long each step in a user-perceived flow takes, and engineering accordingly. Some flows can absorb 5 seconds; others can't tolerate 200ms.

**Where it lives.**
- **Entry commit (typing):** zero AI in the foreground. Save is sync to SQLite (~5ms), scanners run after, classifier fires fire-and-forget. The user perceives instant.
- **Vlog editor mount:** 3–8 seconds for AI composition is acceptable because the user just tapped a "compose vlog" affordance — they're prepared to wait. Loading state is shown.
- **Expand button tap:** 5–10 seconds is acceptable for the same reason. The full-page detail view at `app/todos/[id].tsx` shows a loading state.
- **Cloud sync:** debounced 5 seconds (`schedulePush.ts`). User doesn't see the push directly; latency budget is "before the next user action that depends on it."

**Why it exists.** Users have radically different patience for different flows. Typing is sub-100ms or it feels broken. "Generate me a vlog" is a button I tapped knowing it would take a moment. Cloud sync is invisible — its latency budget is "before I open the app on my other device."

**General rule.** Map your AI call sites to latency budgets. Foreground / on-keystroke calls → zero LLM. Tap-to-trigger calls → seconds is fine, show a loading state. Background / sync calls → minutes is fine if it doesn't block anything visible. **Mismatched budgets are the single biggest UX bug in AI products.**

---

## 4.12 The product principle: AI augments the user, doesn't replace them

**Difficulty:** foundational

**What it is.** A philosophical commitment, encoded throughout the architecture: every AI output is an editable suggestion, never an authoritative decision.

**Where it lives.**
- **Classifier output is editable.** `user_overridden_type` (Principle 9 in `docs/spec.md` §10) is set when the user manually picks a type via the picker. Once set, the row is locked from future re-classification.
- **Expansion is overridable.** The user can tap "re-expand" (with a confirm Alert) or change the type and trigger a fresh expansion. Old expansion is overwritten, but the user is in control.
- **Caption variants.** The vlog editor TEXT tab exposes three variants (PRIMARY / ALT / SUMMARY) and lets the user pick — even the AI-feeling output isn't forced.
- **All summaries cache the model name.** Every `ai_summaries` row stores `model`, every `todo_meta` row stores `classifier_model`. The user can audit which model produced what — implicit acknowledgment that the AI is fallible and the user can decide whether to trust it.

**Why it exists.** AI output is probabilistic. A classifier gets it wrong sometimes; an expansion misses the user's intent sometimes; a caption might land flat. If the system *committed* to the AI's output, those misses would be permanent. By making every output editable and respecting the override permanently, the user stays in control.

**General rule.** Every AI output should have (a) an edit affordance, (b) a regenerate affordance, and (c) an override-respect rule that prevents the AI from clobbering the user's correction. This isn't just a UX principle — it's the only way a probabilistic system can be a trustworthy product.
