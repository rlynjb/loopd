# Heuristic before LLM

**Industry name(s):** Heuristic-before-LLM, fast-path / slow-path, deterministic short-circuit
**Type:** Industry standard

> Filter the predictable cases with rules; only pay the LLM for the ambiguous ones. In measured systems, 60–90% of inputs resolve via heuristic — that's a 60–90% cost cut on that chain. Heuristics drift; log routed cases and sample through the LLM occasionally to detect drift.

**See also:** → [06-token-economics](./06-token-economics.md) · → [01-what-is-an-llm](./01-what-is-an-llm.md) · → [`ai-features-in-this-codebase`](../ai-features-in-this-codebase.md)

---

## Why care

### Move 1 — The grounded scenario

You're typing in buffr: `[] book flight to LAX`. The classifier needs to label this `todo` — it's a plain action item, not a thought to sit with. Easy case — it opens with an imperative verb (`book`), and lines that open that way are nearly always `todo`. But if the system sent every line through a Haiku 4.5 LLM call regardless, that's a 200ms latency hit and ~$0.0001 per call for input the cheapest regex could route in 100 microseconds. Across thousands of lines, you've paid hundreds of API calls for "this opens with an imperative verb like 'book', 'call', or 'fix'" — a job rules can do free.

### Move 2 — Name the question the pattern answers

That do-I-need-the-LLM-here question is what heuristic-before-LLM answers. Not "how do I build a perfect rule engine" (you don't); just *for any LLM call, what fraction of inputs are unambiguous, and can rules cover them while the LLM handles the rest*. The answer: build rules for the obvious cases, route only the ambiguous remainder to the model.

### Move 3 — Why answering that question matters

**What breaks without the discipline:** every chain runs the LLM on every input, including the 70% that didn't need it. Costs and latency scale with traffic; "cheap model" is not the optimization — "no model" is. In buffr today, the classifier chain has a hand-rolled regex pass in `src/services/todos/heuristicClassify.ts` that short-circuits roughly 70% of todos before the LLM call. The LLM only runs on inputs that don't match any regex — the genuinely ambiguous ones.

### Move 4 — Concrete before/after

Without the heuristic short-circuit:
- 100 todos per user per day = 100 Haiku calls
- 100 × $0.0001 = $0.01/user/day
- 100 × 200ms = 20 seconds of cumulative API time
- 100% of calls go through the LLM

With the heuristic short-circuit (buffr's current shape):
- 100 todos → 70 resolved by regex, 30 by LLM
- 30 × $0.0001 = $0.003/user/day (70% cost cut)
- 30 × 200ms = 6 seconds of API time (perceived latency drops too because regex is sub-ms)
- 100% accuracy on the heuristic path (regex is deterministic); LLM accuracy on the remaining 30%

### Move 5 — The one-line summary

Most inputs are predictable; rules handle them; only the ambiguous remainder pays the LLM tax. Heuristics drift; log routed cases and re-validate occasionally.

---

## How it works

### Move 1 — The mental model

```
   Input
     │
     ▼
   ┌─────────────────────┐
   │ Heuristic check     │  fast, free, deterministic
   │ (regex, rules)      │  e.g. imperative "book|call|fix" → 'todo'
   └─────────┬───────────┘
             │
        ┌────┴────┐
        │ match?  │
        └────┬────┘
             │
        ┌────┴─────┐
        │          │
        ▼ yes      ▼ no
    Return        ┌────────────────┐
    directly      │  Call LLM      │  expensive, slow,
                  │  (fallback)    │  but smarter
                  └────────────────┘
```

### Move 2 — The layered walkthrough

**Layer 1 — what the heuristic looks like.** Regex patterns matched against the input string. The key point: the heuristic only ever emits `'todo'` or `null` — it detects *definitely-an-action* lines and abstains on everything else. It never picks `idea`/`knowledge`/`study`/`reflect`; those are the LLM's job on the abstain path. For buffr's classifier in `heuristicClassify.ts`:

```
   ┌─ buffr's classifier heuristic (heuristicClassify.ts, approximate) ──┐
   │   imperative verb at line start                                     │
   │     /^(call|book|buy|fix|send|email|pick up|finish)\b/i  →  'todo'  │
   │   deadline pattern                                                  │
   │     /\b(by|before|due)\s+(eod|tomorrow|fri|\d)/i         →  'todo'  │
   │   speculative / modal / question starts                            │
   │     /^(maybe|should we|what if|i wonder|reflect on)/i    →  null    │
   │     (defer to LLM — likely idea / study / reflect, not 'todo')      │
   │   no signal                                              →  null    │
   └─────────────────────────────────────────────────────────────────────┘
```

It's a binary gate (`'todo'` vs abstain), not a multi-class router. Returning `'todo'` wrongly costs the user trust (a checkbox they have to clear); returning `null` only costs an LLM call — so the gate is biased toward abstention.

**Layer 2 — when the heuristic doesn't fire.** Some inputs are genuinely ambiguous: `[] thing about the project` has no imperative signal. Some are thinking-mode phrasings the regex deliberately abstains on: `[] noodle on the auth design` (likely `reflect` or `idea`), `[] the Raft paper` (likely `study`). For those, the LLM call runs as a fallback and picks among `idea`/`knowledge`/`study`/`reflect`. The regex pass is fast (sub-millisecond); the model call is the slow path. Most inputs hit the fast path; the slow path is what the LLM is for.

```
   buffr's classifier dispatch
   ───────────────────────────
   heuristicClassify(text) →  'todo' | null
         │
    ┌────┴────┐
    │  null?  │
    └────┬────┘
         │
    ┌────┴─────┐
    │          │
    ▼ no       ▼ yes
   return     classifyWithLLM(text)
   'todo'        │
                 ▼
              idea | knowledge | study | reflect | todo  (Haiku 4.5)
```

**Layer 3 — drift is the failure mode.** A regex written today catches today's phrasings. Six months from now, users have invented new ways to write todos that the regex doesn't catch — those now go to the LLM (cost goes up; latency on those inputs goes up). Worse: a regex might fire on a phrasing whose meaning has shifted, returning the wrong label. The mitigation: log every heuristic-routed case; periodically (weekly, monthly) sample some of them through the LLM and compare. If divergence exceeds a threshold, update the regex set.

```
   Drift detection pattern
   ───────────────────────
   log every heuristic match → table { input, heuristic_type, date }
                                 │
                                 ▼
   weekly sample (random 5%)  →  re-run via LLM
                                 │
                                 ▼
   compare heuristic_type vs llm_type
                                 │
                                 ▼
   if divergence > threshold  →  update regex set
```

### Move 3 — The principle

The cheapest LLM call is the one you don't make. Rules handle the predictable cases; the model handles the residue. The pattern compounds: heuristic-routed cases are deterministic, debuggable, and free.

The full picture is below.

---

## Heuristic-before-LLM — diagram

```
┌─ Hybrid classification pipeline ───────────────────────────────────────┐
│                                                                        │
│   User input: "[] book flight to LAX"                                  │
│         │                                                              │
│         ▼                                                              │
│   ┌──────────────────────────────────┐                                 │
│   │ heuristicClassify.ts (regex set)│   ~70% of inputs resolve here    │
│   │   imperative "book|call|fix" →   │   sub-millisecond, deterministic │
│   │     'todo'                       │                                  │
│   │   deadline "by EOD" →  'todo'    │                                  │
│   │   default:             null      │                                  │
│   └──────────┬───────────────────────┘                                 │
│              │                                                         │
│         ┌────┴────┐                                                    │
│         │  null?  │                                                    │
│         └────┬────┘                                                    │
│              │                                                         │
│         ┌────┴─────┐                                                   │
│         │          │                                                   │
│         ▼ no       ▼ yes                                               │
│      return       ┌─────────────────────────────┐                      │
│       type        │ classify.ts (Haiku 4.5)     │  ~30% of inputs     │
│                   │                              │  ~200ms, $0.0001    │
│                   └──────────────┬──────────────┘                      │
│                                  │                                     │
│                                  ▼                                     │
│                              type + confidence                         │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Case A — buffr's classifier uses the heuristic-first pattern.**

**Files:**
- `src/services/todos/heuristicClassify.ts` (~L20–L80) — the regex set. Each pattern maps to a `ThinkingMode`. First match wins. Returns `null` if no pattern matches.
- `src/services/todos/classify.ts` (~L30–L70) — the LLM fallback. Checks if `heuristicClassify` returned non-null; if so, returns that type. Otherwise calls Haiku 4.5 with the todo text.
- `src/services/todos/reconcileMeta.ts` — when reconciling `todo_meta`, calls `classify` for newly-created todos; doesn't re-classify ones with `user_overridden_type = true`.

Currently: no logging of heuristic-routed cases (no `heuristic_log` table). Drift detection is manual — when a user reports a misclassification, the engineer checks whether it hit the heuristic or the LLM, and updates the regex if heuristic-caused. The buildable next step is the `B1.5` curriculum item: document the heuristic coverage in the file's header comment with the false-negative cases that need testing.

---

## Elaborate

### Where this pattern comes from

Hybrid heuristic-plus-ML systems predate LLMs by decades — every classical NLP system used hand-rolled rules for the obvious cases and a statistical model for the rest. The LLM era brought the same pattern back with new urgency because LLM calls are expensive.

### The deeper principle

When you have a cheap path that handles most cases and an expensive path that handles the rest, route to the cheap path by default. The cost ratio between paths (regex: free; LLM: $0.0001 per call) is what makes the routing worth building.

### Where this breaks down

When the heuristic coverage is low (under ~30%), the routing logic adds complexity without much savings. When the input space is genuinely unstructured (free-form prose with no recognizable patterns), the heuristic can't fire reliably and you're paying the cost of dispatch with no return. The pattern earns its keep when there's a structural signal in the input (verb prefixes, file extensions, content-type hints).

### What to explore next

- [06-token-economics](./06-token-economics.md) — heuristic routing is the biggest cost lever for chains it applies to
- [01-what-is-an-llm](./01-what-is-an-llm.md) — the cheapest LLM call is no call
- [`04-agents-and-tool-use/04-tool-routing`](../04-agents-and-tool-use/04-tool-routing.md) — the production pattern is heuristic first, LLM as fallback router

---

## Tradeoffs

```
┌──────────────────┬──────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Heuristic-first          │ LLM-always                   │
├──────────────────┼──────────────────────────┼──────────────────────────────┤
│ Cost per input   │ ~30% × LLM cost          │ 100% × LLM cost              │
│ Latency p50      │ Sub-millisecond          │ ~200ms (Haiku)               │
│ Accuracy on      │ 100% (deterministic)     │ ~95% (LLM error rate)        │
│ heuristic hits   │                          │                              │
│ Accuracy on      │ Same as LLM-always       │ Same                         │
│ heuristic misses │                          │                              │
│ Drift risk       │ Real; heuristics go stale│ None (model is general)      │
│ Maintenance      │ Regex set needs review   │ Zero                         │
└──────────────────┴──────────────────────────┴──────────────────────────────┘
```

### The breakpoint

Use heuristic-first when (a) you can write rules that catch >30% of inputs unambiguously, (b) the LLM cost is meaningful at scale (not rounding error), and (c) you have a feedback signal (user corrections) to detect drift. Skip when the input space is genuinely unstructured.

---

## Tech reference (industry pairing)

### JavaScript RegExp (case-insensitive word-boundary matching)

- **Codebase uses:** `RegExp` with `/i` and `\b` for word boundaries in `src/services/todos/heuristicClassify.ts`.
- **Why it's here:** native, fast, no dependency. Adequate for buffr's input shape.
- **Leading today:** native RegExp covers buffr's needs. For complex pattern languages, libraries like `chevrotain` (parser combinators) or simple state machines.

---

## Project exercises

### B1.5 — Document heuristic coverage + false-negative cases

- **Exercise ID:** `B1.5`
- **What to build:** add a header comment in `src/services/todos/heuristicClassify.ts` documenting the regex coverage, with a `// false-negatives:` block listing input phrasings that currently fall through to the LLM. Optionally add a test fixture with both positive and negative cases.
- **Why it earns its place:** makes drift visible. When the file accumulates "I had to add a regex for this" history, the engineer can see what categories of input the rules miss.
- **Files to touch:** `src/services/todos/heuristicClassify.ts`, possibly a new test fixture.
- **Done when:** the header comment names every regex pattern and the input shapes it covers; the false-negative block lists examples that fall through.
- **Estimated effort:** 1 hour.

### B-future — Add heuristic-routed logging for drift detection

- **Exercise ID:** `B-classifier-logging`
- **What to build:** new `classifier_log` table (`{ input, heuristic_match, llm_result, date }`); log every classify call's route. Weekly random sample re-runs heuristic-routed cases through the LLM and reports divergence.
- **Why it earns its place:** turns drift detection from manual ("a user complained") into automated.
- **Files to touch:** new migration, `src/services/todos/classify.ts` instrumentation, a new background job.
- **Done when:** divergence reports surface in `app/settings/ai.tsx`.
- **Estimated effort:** 6 hours.

---

## Summary

### Part 1 — concept recap

Heuristic-before-LLM routes the predictable cases through rules (regex, deterministic) and only pays the LLM for the ambiguous remainder. In buffr's classifier, ~70% of todos match the regex set in `heuristicClassify.ts` and skip the Haiku call entirely; only ~30% hit the LLM fallback. The pattern compounds across cost and latency. The failure mode is drift — regexes go stale as input phrasings evolve — mitigated by logging heuristic-routed cases and periodic re-sampling through the LLM.

### Part 2 — key points to remember

- The cheapest LLM call is the one you don't make.
- Rules catch the predictable cases; the model handles the residue.
- Pattern compounds: cost down, latency down, deterministic-on-fast-path.
- Drift is real; log routed cases for periodic re-validation.
- Buffr's classifier uses this (heuristicClassify.ts → classify.ts); other chains don't, because their inputs aren't structurally signalled.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "how do you optimise LLM cost," the heuristic-first answer is the senior answer. "We use a cheaper model" is the junior answer; "we don't call the model when we don't need to" is the senior one.

### Likely questions

**Q [mid]:** When does heuristic-first apply and when doesn't it?

**A:** Applies when there's a structural signal in the input you can recognise with rules — verb prefixes in buffr's todos, file extensions for routing tools, content-type hints for moderation. Doesn't apply when the input space is genuinely unstructured (free-form prose) or when the heuristic coverage is too low (<30%) to justify the routing complexity. For buffr's classifier, ~70% of todos have a recognizable verb-of-action; for the `interpret` chain, the input is a whole day's prose and no rules could meaningfully short-circuit it.

**Q [senior]:** How do you handle heuristic drift?

**A:** Log every heuristic-routed case to a table; periodically sample (5% weekly) and re-run through the LLM; compare. If divergence exceeds a threshold (~5% disagreement), update the regex set or add a new rule. The signal that drift has hit critical mass is when users start reporting "the AI is misclassifying my todos" — at that point the heuristic has slipped behind the input distribution. For buffr today, drift detection is manual (engineer fixes regex when a user complains); the build target is the automated version.

### One-line anchors

- Cheapest LLM call is no call.
- Rules for predictable; model for ambiguous.
- ~70% short-circuit in buffr's classifier today.
- Drift is real; log + re-sample weekly.
- Pattern doesn't apply to unstructured prose chains.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the heuristic-first dispatch: input → regex check → return-or-fallback → LLM call, with timing labels.

### Level 2 — Explain it out loud

Explain in under 60 seconds why heuristic-first beats "switch to cheaper model" as the first cost optimisation.

### Level 3 — Apply it to a new scenario

A new requirement: buffr should auto-tag entries with topics like `work`, `personal`, `health`. Would you use heuristic-first? What rules would fire reliably?

### Level 4 — Defend the decision you'd change

Defend or oppose: "Buffr should remove the regex set in `heuristicClassify.ts` because Haiku is cheap enough now." Why or why not?

### Quick check — code reference test

Without opening files:
- What file owns the regex set?
- What fraction of todos hit the heuristic path today?
- What's the symptom of heuristic drift?

---
