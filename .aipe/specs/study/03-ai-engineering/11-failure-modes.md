# Failure modes the codebase explicitly handles

**Industry name(s):** Failure modes, FMEA-lite for AI features
**Type:** Language-agnostic

> AI is best-effort. Every callsite makes sure that an AI failure leaves the canonical data (the prose, the todo, the entry) untouched. The worst outcome of any AI bug is "no AI annotation this time," never "lost data."

**See also:** → [08-validation-gate](./08-validation-gate.md) · → [10-user-overridden-type-lock](./10-user-overridden-type-lock.md)

---

## Why care

AI calls fail. They fail because the network dropped, because the provider is down, because the model returned malformed JSON, because rate limits hit, because the model refused the prompt, because the user's API key expired. Every one of those failures is going to happen, repeatedly, in production. The question is not "how do I prevent them" — you can't — but "what does the user lose when one of them happens at the wrong moment." If the answer is "their data," the architecture is wrong.

The principle here is graceful degradation: the AI layer is best-effort, and a failure in that layer must never damage the canonical data underneath it. It belongs to the family of "fail-soft" and "isolation" patterns — the same shape as circuit breakers around flaky services, write-ahead logs that survive crashes mid-transaction, and CDN fallbacks that serve stale content when the origin dies. You've already seen it in Stripe SDKs that retry idempotently on network errors, in OpenAI clients that surface a typed error instead of a half-parsed response, and in any production LLM stack that wraps every call in "if this throws, the user's record is unchanged." The table below lays out the shape it takes here.

---

## Failure modes — table

```
  ┌──────────────────────────────┬──────────────────────────────────────────────┐
  │ Failure                      │ How loopd recovers                            │
  ├──────────────────────────────┼──────────────────────────────────────────────┤
  │ No API key configured        │ all 5 services return early; UI shows banner │
  │ Network error                │ caller catches, returns null; row stays in   │
  │                              │ pre-AI state and is retried on next event    │
  │ Malformed JSON (model drift) │ expand: 1 retry with stricter prompt; others:│
  │                              │ skip and log warn                            │
  │ Missing required field       │ validate.ts returns errors[]; row ignored    │
  │ Caption-call fails inside    │ logged; structured summary still saves       │
  │  summarize                   │  (caption is independent — see summarize.ts:87)│
  │ User overrode type           │ next classifier write checks the lock and    │
  │                              │  refuses to overwrite                        │
  │ MAX_CONCURRENT exceeded      │ expandTodo returns { ok:false, reason:'in-flight-cap'} │
  │ Heuristic uncertain          │ deferred to async LLM; UI shows type='todo' │
  │                              │  in the meantime                              │
  │ Interpret: input < 20 chars  │ returns { ok:false, reason:'too-short' };    │
  │  (MIN_TEXT_LENGTH guard)     │ modal shows "entry too short"; no API call   │
  │ Interpret: input > 2000 chars│ truncateTail keeps the most-recent 2000;     │
  │  (MAX_INPUT_CHARS cap)       │ silent — no error, just bounded prompt       │
  │ Interpret: empty/whitespace  │ cleanMarkdown returns null →                  │
  │  model output                │ { ok:false, reason:'malformed' };             │
  │                              │ user sees error UI, can re-tap                │
  │ Interpret: clinical-language │ NOT caught — slips through. Prompt forbids   │
  │  drift                       │  it but no post-call filter. User dismisses   │
  │                              │  the modal.                                   │
  └──────────────────────────────┴──────────────────────────────────────────────┘
```

---

## How it works

Each failure mode has a defined recovery path. The principle: **the canonical data path (prose → SQLite) is never blocked by AI failures.**

1. **No API key** — every service starts with `if (!apiKey) return { error }`. The UI shows "configure your AI key" banner.
2. **Network error** — `fetch` rejects, caller catches, returns `null`. SQLite row stays in pre-AI state. Next event (next save, next user action) gets another shot.
3. **Malformed JSON** — `parseJson` returns `null`. expand retries once; others skip.
4. **Missing required field** — `validate.ts` rejects; the row ignored.
5. **Caption-call fails inside summarize** — caption is wrapped in its own try/catch (`summarize.ts:87`). Failure logs; the structured summary still saves.
6. **User overrode type** — `user_overridden_type` lock; classifier reads and skips.
7. **MAX_CONCURRENT exceeded** — `expand.ts:25` caps at 3 concurrent expansions; over-cap returns `{ok:false, reason:'in-flight-cap'}`.
8. **Heuristic uncertain** — async LLM scheduled; UI shows placeholder type until update.

---

## In this codebase

**Caption isolation:**    `src/services/ai/summarize.ts` → `summarize()` L42–L105 wraps the caption call in its own try/catch at L87–L96 (caption can fail; structured summary still saves)
**Concurrency cap:**      `src/services/todos/expand.ts` → `MAX_CONCURRENT = 3` at L25 — over-cap returns `{ ok:false, reason:'in-flight-cap'}`
**Interpret guards:**     `src/services/ai/interpret.ts` → `MIN_TEXT_LENGTH = 20` (L16) + `MAX_INPUT_CHARS = 2000` (L17) + `truncateTail()` L58–L61 + `cleanMarkdown()` L98–L108. `InterpretResult` (L52) discriminates `'no-ai' | 'too-short' | 'malformed' | 'network'`.
**One-retry pattern:**    `src/services/todos/expand.ts` → `expandTodo()` L191+; the inner `callOnce` invocation pair re-fires with a stricter prompt on validation failure
**All validators:**       `src/services/ai/validate.ts` → `validateSummary()` L12+ + `parseAndValidate()` for caption in `caption.ts` L169–L199 + `validateExpansion()` in `expand.ts` L77–L142 + `cleanMarkdown()` for interpret in `interpret.ts` L98–L108
**Key gate:**             `src/services/ai/config.ts` → key getters L18–L40 (whole file is L1–L50); every chain returns an error reason on early-return when these come back empty

---

## Elaborate

### Where this pattern comes from
"Best-effort with explicit failure modes" is the standard pattern for any side service. Caching layers, analytics, indexing — they're allowed to fail; the main path isn't.

### The deeper principle
**The model is one of many possible failure points. The user's canonical data path must not depend on its success.** Treat AI exactly like an external API that might be down — your app survives the outage.

### Where this breaks down
- Features where AI output IS the canonical data (e.g., the editor's structured composition reads from `ai_summaries.summary_json`). Mitigation: cache prior runs, fall back through `variants.clean → caption → summary.summary`.
- Silent failures the user can't see — a steady stream of AI rejection, none flagged. Mitigation: `/todos` banner, dev-mode logs.

### What to explore next
- [08-validation-gate](./08-validation-gate.md) → the validator step.
- [10-user-overridden-type-lock](./10-user-overridden-type-lock.md) → another protection layer.

---

## Tradeoffs

- **Best-effort AI** — gives: user's data never blocked. Costs: AI features may silently not run; user wonders why.
- **Per-failure recovery** — gives: each mode has a specific behaviour. Costs: more code than "throw and bubble."
- **MAX_CONCURRENT cap** — gives: cost ceiling on expand burst. Costs: power user trying to "expand all" hits the cap.

---

## Quick summary

Graceful-degradation for AI features is the "fail-soft + isolation" pattern — every AI failure mode has a defined recovery path that leaves the canonical data (prose, todo, entry) untouched. In this codebase that shows up as a per-failure-mode table across all 5 chains: `summarize.ts:87` wraps the caption call in its own try/catch so caption failure doesn't kill the structured summary; `expand.ts:25` caps concurrency at `MAX_CONCURRENT = 3`; `interpret.ts` adds 4 new failure surfaces (too-short, malformed-markdown, network, no-ai) via the `InterpretResult` discriminated union; `validate.ts` rejects malformed JSON before any SQLite write. The constraint that drove it is "canonical data is never blocked by AI" — the worst outcome of any AI bug is "no annotation this time," never "lost data." The cost is silent failures: a flaky network leaves classifications stuck at `type='todo'` and at single-user phase A the only signal is the `/todos` banner via `getClassifyInFlight()`.

Key points to remember:
- Every chain has a defined recovery path; nothing throws past the AI boundary.
- The canonical SQLite write happens before or independently of the AI write — always.
- Retry budget tracks user intent: expand retries with a stricter prompt; classify doesn't.
- `MAX_CONCURRENT = 3` caps expand cost; classify has no cap because heuristic gating bounds volume.
- Silent-failure modes are the gap at scale — at one user the dev is the alarm; at 1000 users a per-failure-mode counter and "AI degraded" banner become necessary.

---

## Interview defense

### What an interviewer is really asking
"What happens when AI fails?" tests whether I have a recovery story or just a happy path. The interviewer wants to hear the principle "canonical data is never blocked by AI" backed by code references — `summarize.ts:87` caption try/catch, `expand.ts:25` MAX_CONCURRENT, the one-retry pattern. The candidate who can only describe the success path fails this question.

### Likely questions

[mid] Q: Trace what happens end-to-end when the user has no API key set.
      A: Every AI service starts with `if (!apiKey) return { error: 'no API key' }` — the early return lives in `ai/config.ts` at the key-getter site. The chain never makes a network call. The caller propagates the error or surfaces it via a UI banner pointing to settings. The canonical data path is unaffected: prose still saves to SQLite, todos still parse out, the editor still commits. The user just doesn't get AI annotations until they configure a key. This is the cleanest of all the failure modes because it's a synchronous gate before any side effects.

[senior] Q: Why one retry on malformed JSON in `expand.ts` and zero retries in caption/summarize/classify?
         A: Because expand's expected output is high-information per call (a typed JSON object filling 4-6 required fields like `observed`, `expected`, `suspectedCause`, `reproSteps[]` for 'bug') and the user explicitly fired the expand action. Failing silently after one network call would be a bad UX — the user pressed "expand", saw nothing happen, doesn't know why. The retry with a stricter prompt ("Your previous output was not valid JSON for the schema. Re-emit ONLY a single JSON object…") rescues the borderline cases. Caption, summarize, and classify run automatically — no user intent — and they have other recovery paths (caption skipped means structured summary still saves; summarize surfaces error in `ai_summaries.error`; classify stays at heuristic-or-null). The retry budget tracks user intent, not technical possibility.

[arch] Q: At scale — say 1000 users — how would this failure-mode list change?
       A: Most of it stays the same, but the silent-failure modes become real problems. Today a user with consistently-failing classification sees `type='todo'` on every row and might not notice. At 1000 users I'd need server-side aggregate visibility — a metric for "classification failure rate per provider per model", alarms when it spikes (model upgrade ate the schema), and a per-user diagnostic. I'd also tighten `MAX_CONCURRENT` from a per-user cap to a global cost ceiling, and probably add exponential backoff on 429s. The recovery shapes don't change; the observability and cost-control do.

### The question candidates always dodge
Q: You list eight failure modes, but the table reads like "we log it and move on." What's a failure that would actually make you want a user-visible alarm — and why don't you have one today?

A: Fair — the silent-failure modes are the gap. The one that would justify a real alarm is "classification consistently failing for this user across multiple entries" — meaning either their key is bad, the model upgrade broke the schema, or they're rate-limited. Today the only signal is the `/todos` banner showing in-flight count via `getClassifyInFlight()` which doesn't drop, and dev-mode logs no real user reads. The reason I haven't built it is the cost-benefit at single-user phase A: an alarm system means deciding what counts as "consistently failing" (3 in a row? 10 in 5 minutes?), how to surface it (toast, banner, settings badge?), and how to recover (button to retry? auto-retry?). At one user with sporadic use, the developer (me) is the alarm — I notice when my own todos stop classifying. The day this app has more users, the first observability investment is a per-failure-mode counter and a "AI is degraded" banner with a retry action. Until then, "log and move on" is the honest behaviour.

### One-line anchors
- "Canonical data is never blocked by AI. The worst outcome is 'no annotation this time'."
- "Retry budget tracks user intent. Expand retries; classify doesn't."
- "Silent-failure modes are the visible gap at scale. At one user, the dev is the alarm."
- "Every failure path leaves the canonical SQLite row untouched."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the failure-mode table from memory. Label every row.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain "AI is best-effort, canonical data is never blocked" to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → at least one of `summarize.ts:87` or `expand.ts:25` or `expand.ts:234`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

The user has been on a flaky train for 30 minutes. They've committed 4 entries with 12 todos total — 8 ambiguous (need LLM classify), 2 expand button presses, 1 caption-after-summary day. Every network call has been failing with timeouts. Walk what the user sees: which AI annotations are missing, which canonical data is intact, what does `/todos` show as in-flight, and what happens when the network returns at minute 31?

Write your answer. 3–5 sentences minimum. Then open `src/services/ai/summarize.ts` L87–L96, `src/services/todos/expand.ts` L25 + L211–L266, and `src/services/todos/classify.ts` L90–L120 to verify the recovery shapes.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/ai/summarize.ts:87` (the silent-log behaviour) to support what exists
→ Point to where a per-failure-mode counter + a UI banner would land (likely a new `src/services/ai/telemetry.ts` plus an `/todos` banner state) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — added 4 new interpret-specific failure modes (too-short / over-cap / malformed-markdown / clinical-drift); bumped service count from 4 to 5. See `14-interpret.md`.
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block.
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
