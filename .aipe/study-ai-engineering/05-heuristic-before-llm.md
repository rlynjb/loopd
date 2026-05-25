# Heuristic before LLM (the cost gate)

**Industry name(s):** Cascading classifier, cheap-first / expensive-second
**Type:** Industry standard · Language-agnostic

> Every new todo runs through `heuristicClassify` first (regex-only, no network). The LLM classifier is fired only when the heuristic returns `null`.

**See also:** → [02-dsa/10-heuristic-first-classifier](../02-dsa/10-heuristic-first-classifier.md) · → [09-async-classification](./09-async-classification.md)

---

## Why care

You're writing a function that needs to return a value, and there are two paths to the answer: a cheap synchronous one (a regex match, a hash lookup, a quick comparison) and an expensive asynchronous one (a network call, an LLM inference, a database round-trip). Most inputs are easy — you can recognise them with a regex or a quick branch and return immediately. Some inputs need real work — they cost hundreds of milliseconds and a few cents to resolve. Option one: call the expensive path for every input. Option two: try the cheap path first; if it returns a confident answer, use it; if it returns `null`, fall through to the expensive path. The second option is the same shape as a `useMemo` that returns a cached value on key match and recomputes only on a miss, or a CDN `Cache-Control` header that lets a request short-circuit at the edge and only hit origin when the edge misses.

Two stages, asymmetric cost — that's the shape of heuristic-before-LLM. Not "use rules instead of AI," not "always use AI" — a cheap deterministic gate that returns a confident answer or abstains, and an expensive intelligent fallback that only fires when abstention happens. Naming the cascade this way is what keeps both the bill and the keystroke path honest.

**What breaks without it:** the keystroke latency budget and the monthly AI bill, simultaneously. Every new `[]` line in a journal entry calls `heuristicClassify(text)` first — a synchronous regex pass that returns `'todo'` (high confidence) or `null` (don't know). On `null`, the codebase inserts the `todo_meta` row with `type='todo'` `classifier_confidence=null` and fires `scheduleClassify(todoId, text)` async — a Haiku 4.5 call that returns ~600ms later and updates `type` + `classifier_confidence='haiku'`. Drop the heuristic and every `[]` line pays for inference whether or not it needs to; a user adding three todos in five seconds sees the cursor stutter through three 300-800ms round-trips. The cost win is real ($0.0004 per Haiku call × 100 todos/day × 30 days ≈ $1.20/month avoided) but the UX win is bigger — typing never waits on a network.

Without heuristic-before-LLM:
- Every `[]` line calls Haiku synchronously
- Three todos in five seconds = three 300-800ms cursor stutters
- Bill scales linearly with journaling volume; offline mode degrades to "AI features unavailable"

With heuristic-before-LLM:
- `[] call mom` hits the imperative regex; `classifier_confidence='heuristic'`, no network
- `[] thinking about onboarding redesign` returns `null`; row lands with default `type='todo'`, async Haiku updates it ~600ms later
- The dashboard renders at typing speed; `scheduleClassify` trickles updates in over the next few seconds

Cascade by cost — the cheap path returns on the easy cases, the expensive path handles the rest. Same shape as a `useMemo` cache hit vs miss.

---

## How it works

A typed guard followed by an async fallback. `heuristicClassify(text)` returns `'todo' | null` synchronously in microseconds. On `'todo'`, the codebase uses the answer immediately and stops. On `null`, it inserts a placeholder row with `classifier_confidence=null` and fires `scheduleClassify(todoId, text)` async — a Haiku 4.5 call that resolves ~600ms later and updates the row. Same shape as a `useMemo` that returns a cached value on key match and recomputes on miss, or a CDN serving from the edge cache and falling back to origin only when the edge misses.

The cascade in one picture:

```
   new todo: '[] call mom'
              │
              ▼
   heuristicClassify(text)             ◄── cheap, synchronous,
              │                              ~microseconds
        ┌─────┴─────┐
        ▼           ▼
   returns         returns
   'todo'           null
   (confident)      (abstain)
        │           │
        │           ▼
        │   insert row with               ◄── placeholder
        │     classifier_confidence=null   placeholder
        │           │
        │           ▼  scheduleClassify(todoId, text)
        │           │  ~600ms later
        │           ▼
        │   updateTodoMeta(id,
        │     type='idea',
        │     classifier_confidence='haiku')
        ▼
   classifier_confidence='heuristic'
   no LLM call needed
```

The three sub-sections below trace the cheap path, the async fallback, and why the asymmetry is a UX argument before it's a cost argument.

### The cheap path — heuristic regex

`heuristicClassify(text)` runs a series of ordered regex tests (see [02-dsa/10](../02-dsa/10-heuristic-first-classifier.md) for the algorithm). The tests look for obvious markers — verbs in the imperative, action-word patterns, common todo phrasings — and return either `'todo'` (high confidence) or `null` (don't know). The function is synchronous, runs in microseconds, costs zero dollars. Concrete consequence: a user types `[] call mom`. The heuristic regex hits the imperative pattern (`call <object>`), returns `'todo'`. The codebase inserts a `todo_meta` row with `type='todo'` and `classifierConfidence='heuristic'`. The LLM is never called. Boundary: the heuristic is precision-tuned — it returns `'todo'` only when it's sure. False positives (calling something a todo when it isn't) corrupt the data; false negatives (not knowing) just defer to the LLM. Bias toward abstention.

The function signature and what it does to a few sample inputs:

```
   heuristicClassify(text: string): 'todo' | null
   ──────────────────────────────────────────────────

   input                                      output
   ──────────────────────────────────────     ──────────
   "call mom"                                 'todo'        ◄── imperative verb
   "ship the feature"                         'todo'        ◄── imperative verb
   "book dentist"                             'todo'        ◄── imperative verb
   "thinking about how to redesign onboarding" null         ◄── abstain (not obvious)
   "the team should focus on retention"       null         ◄── abstain (not obvious)

   the regex bias: precision-tuned to return 'todo' only
   when confident. False negatives are cheap (defer to LLM);
   false positives corrupt the data.
```

A row labelled `'todo'` by the heuristic skips the LLM call entirely — the row is correctly typed at insertion time.

### The fallback — async LLM classifier

When the heuristic returns `null`, the codebase inserts the meta row with `classifierConfidence=null` (acknowledged unknown) and fires `scheduleClassify(todoId, text)` — an async background task that calls `claude-haiku-4-5` with the todo text and gets back a typed mode (`todo` / `idea` / `knowledge` / `study` / `reflect`). When the call returns, the codebase updates the row with the new `type` and `classifierConfidence='haiku'`. Think of it like a deferred React Query mutation — fire it, let the UI render with stale (null) data, update when the response lands. Concrete consequence: a user writes `[] thinking about how to redesign the onboarding flow`. Heuristic returns `null` (no imperative match). Meta inserted with `type='todo'` (the default), `confidence=null`. Async classify runs ~600ms later, returns `idea`. The row updates; the UI re-renders. The user sees the type shift from default-todo to idea in under a second, without ever waiting on the LLM. Boundary: if the LLM call fails (network, rate limit, malformed response), the row stays at `type='todo'` `confidence=null`. A future periodic sweep could retry; the codebase doesn't currently have one. The acknowledged-unknown state is the safety net.

Walking the async path on the ambiguous input:

```
   user types: '[] thinking about how to redesign onboarding'
                       │
                       ▼  heuristicClassify returns null
                       ▼
   ┌───────────────────────────────────────────────────────┐
   │ INSERT INTO todo_meta (                                │
   │   todoId,                                              │
   │   type = 'todo',                  ◄── safe default      │
   │   classifier_confidence = null    ◄── acknowledged      │
   │ )                                       unknown        │
   └────────────────────┬──────────────────────────────────┘
                        │
                        ▼  scheduleClassify(todoId, text)
                        │  (async, fire-and-forget)
                        │
                        ▼  ~600ms later
   ┌───────────────────────────────────────────────────────┐
   │ Haiku 4.5 returns: 'idea'                              │
   │                        │                                │
   │                        ▼                                │
   │ UPDATE todo_meta                                       │
   │   SET type = 'idea',                                   │
   │       classifier_confidence = 'haiku'                  │
   │ WHERE id = todoId                                      │
   └────────────────────┬──────────────────────────────────┘
                        │
                        ▼
   UI re-renders; user sees type shift from 'todo' → 'idea'
   in <1 second, never waited on the LLM
```

If the LLM call fails, the row stays at `(type='todo', confidence=null)` — the acknowledged-unknown state is the safety net.

### Why typing never waits — the UX argument over the cost argument

The cost win is real ($0.0004 per Haiku classify × 100 todos/day × 30 days = ~$1.20/month avoided), but the UX win is bigger. If the LLM ran inline on every `[]` line, every typing burst with new todos would stutter for 300-800ms while the network round-trip resolved. The user's input would lag. By routing through the heuristic synchronously and the LLM async, the codebase guarantees that the keystroke path never waits on a network. If you've worked with optimistic UI in React Query, this is exactly that pattern — commit local first, show the optimistic state, reconcile with the server result later. Concrete consequence: a user adds three todos in five seconds. All three meta rows land instantly with their heuristic types (or default + null confidence). The dashboard renders without lag. The Haiku calls trickle back over the next 2-3 seconds; the UI updates per-row as the responses land. The user never noticed the LLM was involved. Boundary: this works because the default type (`todo`) is safe and useful — wrong only in the sense that it could be more specific. If the default were unusable, the user would see broken UI during the async window.

Three-todos-in-five-seconds on a timeline:

```
   Time     User action            Heuristic     LLM (Haiku)   UI state
   ─────    ───────────────────    ───────────   ───────────   ────────────────
   0.0s     '[] call mom'           'todo'        skipped       row shown: todo
   1.5s     '[] thinking about       null          scheduled     row shown: todo
            onboarding redesign'                                  (default)
   3.0s     '[] ship the feature'   'todo'        skipped       row shown: todo
   ...
   2.1s                                            returns      row 2 updates:
                                                  'idea'        todo → idea
   ─────────────────────────────────────────────────────────────────────────
   user never waited on a network round-trip; all three rows
   visible by 3.0s; LLM-resolved type for row 2 arrives at 2.1s
```

The default type (`todo`) is what makes this work — it's safe and useful even when the LLM hasn't returned yet.

This is what people mean by "cascade by cost, route hot cases through cheap stages." Spam filters work this way (rules then ML), OCR pipelines work this way (whitespace detection then character recognition), CDNs work this way (cache then origin). The shared insight is that *most inputs are easy*, and a cheap gate that knows when to abstain saves the expensive stage for the hard cases. The asymmetry is the design — precision-tuned on the cheap path, recall-tuned on the expensive one — and the discipline is naming when to defer instead of brute-forcing every input through the expensive engine. The full picture is below.

---

## Heuristic before LLM — diagram

```
  new todo created
        │
        ▼
   heuristicClassify(text)
        │
        ├─ returns 'todo'  → set type='todo', confidence='heuristic', SKIP LLM
        │
        └─ returns null    → insert with confidence=null
                              │
                              ▼
                          if not done: scheduleClassify(todoId, text)  ← async
                                            │
                                            ▼
                                       call Haiku/4o-mini
                                            │
                                            ▼
                                       updateTodoMeta(todoId, type, confidence)
```

---

## The same shape repeats elsewhere

- `expand.ts:218` refuses to expand when `meta.type == 'todo'` — no expansion shape exists for plain todos, so no LLM call.
- `compose.ts` falls back through `variants.clean → caption → summary.summary` — no LLM call to "compose", just a deterministic shape selection.

**Pseudocode (the gate, generalized):**

```
  cheap = freeDeterministicCheck(input)
  if cheap.isConfident: return cheap.result      // no LLM
  return await llmCall(input)
```

---

## In this codebase

**Heuristic:**     `src/services/todos/heuristicClassify.ts` → `heuristicClassify()` L71–L102 + regex tables L12–L62
**Caller:**        `src/services/todos/reconcileMeta.ts` → `reconcileTodoMetaForEntry()` L48–L92 calls heuristic before insert; falls through to `scheduleClassify()` L13–L46 on `null`
**LLM fallback:**  `src/services/todos/classify.ts` → `classifyTodo()` L90–L120 (with `SYSTEM_PROMPT` L12–L25)

---

## Elaborate

### Where this pattern comes from
"Cheap first, expensive second" cascades are foundational — disk cache → DRAM → page fault, CDN → origin, regex → parser. The AI-era version puts a regex (or any deterministic check) in front of the LLM.

### The deeper principle
**Pay for the answer you can't compute. Don't pay for the answer you can.** Most decisions are easy. Only the hard ones deserve a model.

### Where this breaks down
- New input shapes the heuristic doesn't know about. The LLM picks up the slack — graceful degradation, but the cost goes up.
- Multi-language users where English-only regex misses obvious cases.

### What to explore next
- [02-dsa/10-heuristic-first-classifier](../02-dsa/10-heuristic-first-classifier.md) → the regex algorithm.
- [09-async-classification](./09-async-classification.md) → what happens when the heuristic returns `null`.

---

## Tradeoffs

We traded a regex-table to maintain for catching 60-70% of todos at zero cost — and biased the gate hard toward `null` so the LLM absorbs every ambiguous case rather than the heuristic confidently mislabelling them.

### Comparison table — both costs in one frame

```
┌──────────────────┬────────────────────────────────┬────────────────────────────────┐
│ Cost dimension   │ Path taken (heuristic gate)    │ Alternative (LLM every todo)   │
├──────────────────┼────────────────────────────────┼────────────────────────────────┤
│ Money            │ ~50% of todos free; remainder  │ 100% × $0.0001 = ~$0.003/day   │
│ ($/1k tokens)    │ at $0.0001 each (Haiku/4o-mini)│ heavy-day (30 todos); ~$1/year │
│                  │ → ~$0.0015/heavy-day; ~$0.50/yr│ per user                       │
│ Latency          │ confident 'todo' returns sync; │ every todo round-trips ~300ms  │
│                  │ heuristic ~0.1ms regex test    │ to Haiku/4o-mini; async hides  │
│                  │                                │ it but rate-limit pressure up  │
│ Format reliability│ 'todo' label cannot be wrong  │ LLM hallucinates rare label    │
│                  │ — regex precision is 100% on   │ shapes (~0.5%); validate.ts    │
│                  │ patterns that match            │ rejects → row stuck at null    │
│ False-positive   │ impossible — bias toward null │ ~0.5-1% wrong-confident labels │
│ risk             │ is the whole design            │ → silent UX bug; needs picker  │
│                  │                                │ + user_overridden_type to fix  │
│ Capacity / rate  │ free path drains no quota      │ 100% of todos hit Anthropic/   │
│ limits           │                                │ OpenAI quota; 429s on bursts   │
│ Cognitive load   │ "regex first, LLM second" —    │ "every todo calls the model" — │
│                  │ one rule; regex table reads    │ simpler mental model but more  │
│                  │ as a precision-tuned list      │ failure modes downstream       │
└──────────────────┴────────────────────────────────┴────────────────────────────────┘
```

### What we gave up

The regex table in `heuristicClassify.ts` L12–L62 is maintenance code that drifts as new input shapes appear. A user who writes journal entries in Spanish, or uses gerund-led action lines ("buying groceries today"), or writes in passive voice ("groceries need buying") gets every line routed to the LLM — the heuristic is intentionally English-imperative-biased. That's a real category of users who pay full LLM cost on every todo. The table will need periodic re-tuning if usage shifts.

We also accept more LLM calls than strictly necessary because the bias is hard toward `null`. A line like "fix the dashboard before EOD" is *obviously* a todo to a human but the heuristic returns `null` if the regex doesn't catch the leading verb shape — the LLM picks it up at ~$0.0001 and labels it correctly. We pay the unnecessary cents to avoid the silent mislabel.

The async window between insert (sync, with placeholder `type='todo'`) and update (LLM responds) means the user briefly sees a row with the wrong badge if the LLM's eventual answer is `idea` or `reflect`. The window is ~300ms-2s in good network conditions, longer or unbounded under failure. The `/todos` banner via `getClassifyInFlight()` is the only signal that classification is still in flight.

### What the alternative would have cost

Sending every todo to Haiku/4o-mini would cost ~$0.0001 × 30 ambiguous todos × 365 days = ~$1/user/year — trivially affordable in absolute terms. The hidden cost is latency on the keystroke path. Without the async fire-and-forget, every commit waits for 30 round-trips at ~300ms each — that's 3-9 seconds of editor freeze on a heavy day. Even with the async pattern, every todo enters the in-flight queue and rate limits start mattering on bursts (a 100-todo entry would hit 429s).

The deeper cost is failure-mode amplification. The heuristic gate is deterministic — if it returns `'todo'`, it's right. Routing everything to the LLM means every todo can fail in three new ways: malformed JSON, hallucinated label, network error. The validation gate catches the first two; the user_overridden_type lock cleans up the third when the user manually corrects. Without the heuristic, 100% of todos go through the full failure-mode surface; with it, ~50% bypass it.

The cost of removing the heuristic isn't dollars — it's the increased volume on every downstream system (validator, retry path, lock, sync queue).

### The breakpoint

The pattern flips at ~$10 LLM cost per user per year (volume × price). At today's Haiku 4.5 / GPT-4o-mini pricing, that's ~3000 LLM-classify calls per user per year — far above any realistic single-user volume. The breakpoint shifts up if Anthropic drops Haiku pricing 5× or down if a user writes 200+ todos per day. A secondary trigger: if the regex table drifts so badly that the heuristic catches <30% of obvious todos, the maintenance cost stops being justified.

A different breakpoint: if the codebase adds a *second* cost-gated chain (say, a "quick rewrite" feature that runs on every clip), the heuristic-first pattern generalises into a shared `cheapFirstThenLLM(input, heuristic, llmCall)` utility. With one consumer today, the abstraction would have one caller and zero payback.

### What wasn't actually a tradeoff

Embedding the heuristic in the prompt ("if this is obviously a todo, return immediately") was never an option. The whole point of the gate is to avoid the LLM round-trip; folding it into the prompt would pay the network cost on every call to skip the network cost. A pre-prompt heuristic is the right shape; a prompt-side heuristic is a category error.

---

## Tech reference (industry pairing)

### @anthropic-ai/sdk / claude-haiku-4-5

- **Codebase uses:** `@anthropic-ai/sdk` with `claude-haiku-4-5` (via `classifyTodo` in `classify.ts`) — the LLM that fires only when the heuristic returns `null`.
- **Why it's here:** the cost gate exists specifically because even Haiku costs ~$0.0001/call; the heuristic skips this call for ~50% of todos.
- **Leading today:** `@anthropic-ai/sdk` — `adoption-leading`, 2026.
- **Why it leads:** native SDK gives first-class access to prompt caching, JSON output, and tool calling that wrappers sometimes flatten or delay.
- **Runner-up:** Vercel AI SDK — `innovation-leading` multi-provider streaming with typed message structures and `useChat` hook.

---

## Project exercises

### [B1.5] Document heuristic regex coverage as assertions

- **Exercise ID:** `[B1.5]`
- **What to build:** Walk `src/services/todos/heuristicClassify.ts`. For every regex branch, list the patterns it catches AND the false-negative patterns it misses (e.g., "study for math" matches a `study` keyword, but "thinking about studying calculus" does not). Encode the misses as named assertions so future-you knows what the heuristic intentionally defers.
- **Why it earns its place:** the heuristic is the gate that saves money on every classify call. A miss isn't a bug — it's a delegated decision. Naming the delegation is the difference between "we have a heuristic" and "we have a documented heuristic budget."
- **Files to touch:** new `src/services/todos/heuristicClassify.coverage.md`; cross-reference from `heuristicClassify.ts`.
- **Done when:** every regex branch has a "catches" line and a "misses" line; the false-negative list contains at least 5 realistic examples per branch with a one-line note on why the heuristic intentionally defers.
- **Estimated effort:** `1–4hr`.

### [B1.8] AI cost & latency panel in app/settings/ai.tsx

- **Exercise ID:** `[B1.8]`
- **What to build:** A panel in `app/settings/ai.tsx` reading from the new `ai_call_log` table (from `[B1.2]`). Shows per-chain count, p50/p95 latency, token spend, and the heuristic skip-rate for classify — what fraction of todos never hit the network.
- **Why it earns its place:** the heuristic-first pattern only earns its name if you can show how often it saves a call. The panel is the receipt; the skip-rate number is the senior-interview answer to "how do you know the heuristic is worth keeping?"
- **Files to touch:** `app/settings/ai.tsx`, new `src/services/ai/aiCallLog.ts` query helper; depends on `[B1.2]` `ai_call_log` table.
- **Done when:** the panel renders on device; skip-rate displays for classify; tapping a chain row reveals last-24h latency p50/p95 and last-30d token spend.
- **Estimated effort:** `1–2 days`.

---

## Summary

Heuristic-before-LLM is a two-stage cascade classifier: a cheap deterministic check decides whether the input is easy enough to skip the model, and only the residual uncertain cases pay for inference. In this codebase every new todo runs through `heuristicClassify()` in `src/services/todos/heuristicClassify.ts` (L71–L102, regex tables L12–L62) before any LLM call — confident `'todo'` results bypass the model entirely; `null` results insert with `classifierConfidence=null` and fire `scheduleClassify()` async. The constraint that drove it is cost on the highest-volume chain — classify is ~$0.0001 per call on Haiku/4o-mini and a heavy journaling day produces 30+ todos, so the heuristic catching 60-70% for free is the whole win. The cost is a regex table to maintain and a bias toward `null` that fires more LLM calls than strictly necessary — but false negatives cost a fraction of a cent while false positives would be silent and need user-initiated overrides.

Key points to remember:
- Heuristic returns `'todo' | null` — never anything else; the asymmetry is the whole design.
- `'todo'` bypasses the LLM entirely (`classifierConfidence='heuristic'`); `null` schedules the LLM async.
- Bias is firmly toward `null`: false negatives cost ~$0.0001, false positives need a manual override and lock the row.
- The same shape repeats elsewhere — `expand.ts:218` refuses to expand `meta.type == 'todo'`; `compose.ts` deterministically falls through `variants.clean → caption → summary.summary`.
- The cost is more LLM calls than strictly necessary and a regex table that must be updated when new input shapes appear.

---

## Interview defense

### What an interviewer is really asking
The cost-gate question is really "do you have a cost model?". They want to see that I picked a regex pre-filter because I did the math, not because it sounded clever. The number to drop: classify is ~$0.0001 per call, a heavy day is 30+ todos, and the heuristic catches roughly half of them for free. That's a halving of LLM cost on the highest-volume chain in the app.

### Likely questions

[mid] Q: What does `heuristicClassify` return when it can't classify, and what happens next?
      A: It returns `null`. `reconcileMeta.ts` inserts the meta row immediately with `classifierConfidence=null` (so the row exists synchronously), and if the todo isn't done yet it fires `scheduleClassify(todoId, text)` without awaiting. The async LLM call lands later via `updateTodoMeta` and emits `CLASSIFY_PROGRESS_EVENT` so `/todos` can re-render. The user sees the row appear instantly with `type='todo'` placeholder; the badge upgrades milliseconds-to-seconds later.

```
[heuristic-returns-null flow]

  heuristicClassify("fix the dashboard before EOD")
        │
        ▼  returns null (no clean verb-led match)
  reconcileMeta inserts row sync
        │   type='todo' placeholder, classifierConfidence=null
        ▼
  if !todo.done: scheduleClassify(todoId, text)   ← FIRE, no await
        │   reconcile returns; UI re-renders
        ▼  (network call lands later)
  classifyTodo → Haiku/4o-mini → updateTodoMeta(type, confidence)
        │
        ▼  emit CLASSIFY_PROGRESS_EVENT
  /todos re-fetches metas, badge upgrades from 'todo' → real type
```

[senior] Q: Why bias the heuristic toward `null` instead of toward catching more cases?
         A: False negatives cost one cheap LLM call. False positives are silent — the heuristic confidently labels a question as a todo, the LLM never runs, and the user has to manually open the picker to fix it (which then locks the row via `user_overridden_type`). The asymmetry is: a wrong heuristic is irreversible without user action, a `null` heuristic costs a fraction of a cent. So I bias hard toward `null`. The heuristic only fires `'todo'` for the cleanest verb-led actionable shape; everything ambiguous goes to the LLM.

```
                  Path taken (bias toward null)        Alternative (aggressive heuristic)
                  ─────────────────────────────        ─────────────────────────────────
false negative    1 LLM call ~$0.0001                  0 cost — gets caught by heuristic
cost              recoverable: LLM labels correctly
false positive    impossible — null is "I don't know"  ~0.5-1% wrong-confident labels
risk              never confidently wrong              silent UX bug, user must pick
recovery          LLM picks up the label               only via manual picker →
                                                       user_overridden_type=true (sticky)
regex table       small, high-precision patterns       wider, more permissive — adds
maintenance       ~50 LOC                              false-positive risk per pattern
% caught free     ~50% (heuristic is conservative)     ~75-85% (more aggressive)
$ saved/yr        ~$0.50 (heavy single user)           ~$0.75 — gain trivial vs UX cost
```

[arch] Q: At 10× the user volume, would you still keep the heuristic, or replace it with a small classifier model?
       A: I'd keep it as the first layer and add a small local classifier as the second layer before the LLM as the third. The heuristic at zero cost is unbeatable for the obvious cases — there's no model that does better than regex on "buy milk". A tiny on-device classifier (something like a fine-tuned distilbert) could catch the 30% the heuristic misses but the LLM gets right, taking another bite out of cost. The LLM stays the fallback. The cost gate just gets more layers.

```
At 10× user volume (300 todos/day, ~$10/user/year LLM cost):

  ┌─ Heuristic (regex, free) ───────────────────┐
  │ catches ~50% — unchanged                    │
  └────────────────┬────────────────────────────┘
                   │ null falls through
                   ▼
  ┌─ Small local classifier (NEW) ──────────────┐
  │ on-device distilbert/MobileBERT             │  ◀── NEW LAYER
  │ catches ~30% of remaining at zero $ cost    │
  │ ~10-50ms inference; bundled in app          │
  └────────────────┬────────────────────────────┘
                   │ low-confidence falls through
                   ▼
  ┌─ Cloud LLM (Haiku/4o-mini) ─────────────────┐
  │ catches the residual ~20%                   │  ◀── RATE-LIMIT-BREAKS-FIRST
  │ at 10× volume: 60 LLM calls/user/day        │     (currently free path absorbs
  │ → quota pressure on Anthropic/OpenAI         │      bursts; LLM-only would hit
  │                                              │      429s at this volume)
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: Doesn't the heuristic miss things? You're proud of "60-70% caught for free" but that means 30-40% of the easy-to-classify todos still hit the LLM unnecessarily.

A: Yes. The heuristic only catches the obvious 'todo' shape — anything verb-led with an actionable noun. Everything else returns `null` and goes to the LLM. That's the design: the heuristic is a free filter, not a complete classifier. The 50/50 split between heuristic-classified and LLM-classified is fine; the goal was to halve the LLM cost, not eliminate it. The reason I didn't push the heuristic harder is exactly the false-positive risk above — every regex I add risks confidently mis-labeling something the LLM would have got right. The current `heuristicClassify.ts` is intentionally conservative: a small set of high-precision patterns. I'd rather pay $0.0001 per LLM call than re-debug a regex that fires on ambiguous text.

```
                  Path taken (conservative heuristic)  Suggested (push heuristic harder)
                  ──────────────────────────────────   ─────────────────────────────────
% todos free      ~50%                                 ~75-85%
$ saved/year      ~$0.50 per heavy single user         ~$0.75 — incremental ~$0.25
false-positive    0 by design                          ~0.5-1% — silent UX bug
risk
recovery cost     N/A                                  user opens picker → permanent
                                                       user_overridden_type=true lock
debugging         "regex didn't match → LLM ran"       "regex matched but was wrong" →
                  obvious in the data                  must re-read regex table + retest
regex maintenance ~50 LOC, stable                      grows; each new pattern carries
                                                       false-positive risk
LLM cost saved    ~$0.50/user/yr — small absolute,     ~$0.25 marginal — too small to
                  but the test for "is this gate       justify the new failure mode
                  worth it" is binary yes              category
```

### One-line anchors
- "Pay for the answer you can't compute. Don't pay for the answer you can."
- "The heuristic is a free filter, not a complete classifier."
- "Bias toward `null`. False negatives cost a fraction of a cent; false positives need user action."
- "Halve the cost on the highest-volume chain. That's the whole win."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain "heuristic before LLM" to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/todos/heuristicClassify.ts:heuristicClassify`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user types `[] this is a question right?`. Walk both layers — exactly what does the heuristic decide and why? Does this line ever reach the LLM (`classifyTodo`)? Now do the same for `[] fix the dashboard before EOD` — heuristic returns what, and does the LLM run?

Write your answer. 3–5 sentences minimum. Then open `src/services/todos/heuristicClassify.ts` L71–L102 to verify the order of checks.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/todos/heuristicClassify.ts` (the regex-based zero-cost gate) to support what exists
→ Point to `src/services/todos/classify.ts:classifyTodo` (the LLM that absorbs every `null`) if you chose the alternative — what does cost look like with no gate?

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
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block. No "7-class problem" string present in this file; classification-count drift (7→5 modes) lives in file 13 and is updated there. Heuristic returns `'todo' | null` so the heuristic-gate description is unaffected by the mode-count reduction.
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.
---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @anthropic-ai/sdk / claude-haiku-4-5.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: added `## How it works` heading with three moves (doorman-at-club metaphor opening / 3 layered sub-sections — cheap-path heuristic, async LLM fallback, why typing never waits — each with frontend bridges and concrete consequences / principle paragraph on cascade-by-cost).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (clinic-with-triage-nurse-and-specialist scenario → "two-stage cascade, asymmetric cost" pattern naming → bolded stakes pivot to `heuristicClassify` + `scheduleClassify` + `classifier_confidence` keeping keystroke latency and bill honest → before/after bullets on inline-Haiku vs heuristic-first → one-line "cascade by cost" metaphor).

---
Updated: 2026-05-14 — v1.32.0 pass: (1) FIXED missing `## How it works` heading — the v1.30.0/v1.31.0 passes had dropped it. (2) Swapped Why care Move 1 from the clinic-triage-nurse-and-specialist physical-world analogy (banned per v1.31.0/v1.32.0) to level-1 primitives (a function with cheap-sync + expensive-async paths; `useMemo` cache-hit/miss; CDN cache-edge vs origin). (3) Swapped How it works Move 1 from "doorman at a club" analogy (also banned) to the same level-1 primitives. (4) Updated Move 5 one-liner from doorman/manager wording to `useMemo` cache hit/miss. Added Move 1 mnemonic diagram (cascade-by-confidence flow) + 3 Move 2 sub-section diagrams: heuristic function signature with sample inputs, async-path walked on the ambiguous case, three-todos timeline. Total: 4 new diagrams.
