# 03 — AI engineering

Every AI pattern in loopd, with the diagram first and the why-this-not-that named.

---

### What an LLM actually is (in one diagram)

```
   Input (tokens)              Output (tokens)
        │                            ▲
        │                            │
        ▼                            │
  ┌─────────────────────────────────────┐
  │              LLM                     │
  │     predicts next token              │
  │     (no memory, no I/O, no tools)    │
  └─────────────────────────────────────┘
```

**What it is:** a function. Tokens in → tokens out.
**What it isn't:** a database, a planner, a reasoner that holds state across calls.
**Why this matters here:** the four AI features in loopd (summarize, caption, classify, expand) are all framed as *one function call each*. There's no agent loop, no tool use. Every call is independent — input goes in, JSON comes back, the app validates and persists. That framing keeps the AI surface debuggable: when something looks wrong, you can re-run a single call deterministically.

---

### Single-purpose chains (loopd's only pattern)

```
  ┌──── 4 chains, 4 different jobs ──────────────────────────────────┐
  │                                                                   │
  │   summarize.ts ─── one job: structured editor data + caption      │
  │                    Sonnet 4.6 · gpt-4o · ~1024 tokens out         │
  │                                                                   │
  │   caption.ts ───── one job: 4 tonal voice variants of one day     │
  │                    Sonnet 4.6 · gpt-4o · ~768 tokens out          │
  │                                                                   │
  │   classify.ts ─── one job: pick 1 of 7 thinking modes             │
  │                    Haiku 4.5 · gpt-4o-mini · ~50 tokens out       │
  │                                                                   │
  │   expand.ts ───── one job per type (idea/bug/question/decision/   │
  │                   knowledge/content) — typed JSON expansion       │
  │                    Sonnet 4.6 · gpt-4o · ~1024 tokens out         │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
```

**What it is:** every AI feature is a single LLM call with one job. The model writes JSON. The app parses, validates, and persists. No chains-of-chains, no multi-step plans.
**Why this pattern:**

- **Easier to debug** — one chain fails, you know which job failed (the editor failed → it's `summarize`; the caption is missing → it's `caption`).
- **Easier to test** — each chain has a clear expected JSON shape that `validate.ts` enforces.
- **Cheaper** — only run what you need. The classifier doesn't run for an obviously-imperative line because the heuristic already caught it.

**What goes wrong with multi-purpose chains:** if a single mega-prompt did "summarize + caption + classify all my todos", a single failure would leave you guessing which sub-task broke. The codebase explicitly avoided this — caption was *split out* of summarize when the 4-variant prompt was added (see `summarize.ts:87` — caption failures don't fail summarize).

```
Pseudocode (the pattern, applied uniformly):
  // 1. Get config
  provider = getProvider()
  apiKey   = getKeyFor(provider)
  if !apiKey: return { error: 'no API key' }

  // 2. Build prompt
  system = SYSTEM_PROMPT_FOR_THIS_JOB
  user   = buildUserPrompt(input)

  // 3. Single call
  raw = provider == 'openai' ? callOpenAI(...) : callClaude(...)

  // 4. Parse + validate
  parsed = extractJson(raw)
  validated = validateAgainstSchema(parsed)
  if !validated: return { error: 'malformed', maybe retry once with stricter prompt }

  // 5. Persist
  saveToSqlite(validated)
  return { ok: true, data: validated }
```

---

### Context window — how loopd packs it

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                  Context window (finite, model-specific)             │
  │                                                                      │
  │  System prompt        [████░░░░░░░░░░░░░░░░░░░░░░░░░]               │
  │  Today's entries      [████████░░░░░░░░░░░░░░░░░░░░░]               │
  │  Last 3 days          [████████████░░░░░░░░░░░░░░░░░] ← only expand │
  │  Sibling todos        [██░░░░░░░░░░░░░░░░░░░░░░░░░░░] ← only expand │
  │  Cached AI summaries  [██░░░░░░░░░░░░░░░░░░░░░░░░░░░] ← caption ⊕   │
  │  Recent captions (5)  [██░░░░░░░░░░░░░░░░░░░░░░░░░░░] ← caption     │
  │  Response space       [░░░░░░░░░░░░░░░░░░░░░░░░██████]              │
  │                                                                      │
  │  Total: bounded by max_tokens — everything competes for space.       │
  └─────────────────────────────────────────────────────────────────────┘
```

**What the model sees:** only what's in the window for *this call*.
**What it doesn't see:** any previous call's input, anything outside the window. There's no per-user memory.
**The management problem in this codebase:** keep the window small enough that small fast models can do the job.

How loopd handles it per feature:

- **classify** — text-only, ~50 tokens out. Context-free for cost: the surrounding entry isn't sent. Spec §5.3 calls this out as deliberate.
- **summarize** — full day (all entries for one date) + clip metadata + habits list. ~1024 tokens out.
- **caption** — `rawLog[]` (sentence-split entry text + done todo bullets) + last 5 captions for anti-repetition + mood. The 5 recent captions are the *only* multi-day context.
- **expand** — entry text + ≤5 sibling todos + last 3 days of entries with their cached AI summaries. The biggest context window of the four; even so, each part is capped.

**The cap on each section** (from `expand.ts:147` `buildContext`) is what keeps the window predictable: `siblingTodos.slice(0, 5)`, `recentDates.slice(0, 3)`. Without those caps, a heavy journaling day could blow past the model's budget.

---

### Provider abstraction — read on every call, no shared interface

```
  Each callsite (summarize / caption / classify / expand)
                        │
                        ▼
                 ┌──────────────────┐
                 │  ai/config.ts    │
                 │  getProvider()   │  ← reads SecureStore: 'claude' | 'openai'
                 │  getXxxKey()     │
                 └──────────┬───────┘
                            │
                  ┌─────────┴─────────┐
                  ▼                   ▼
         provider == 'claude'   provider == 'openai'
                  │                   │
                  ▼                   ▼
         Anthropic SDK          raw fetch /v1/chat/completions
         models.create({...})   response_format: json_object
                  │                   │
                  └─────────┬─────────┘
                            ▼
                 string of model output
                            │
                            ▼
                 caller-specific parser + validator
```

**What changes when you swap providers:** the model identifier and the API client. That's it.
**What doesn't change:** the prompts, the JSON shape the model is asked to produce, the validators, the persist layer.
**Why no `BaseChatModel` interface:** the two providers' APIs are different enough that a unified interface either lies (gluing OpenAI's `response_format: json_object` over Claude's looser shape) or constrains both to the lowest common denominator. The codebase chose explicit branches per callsite — four providers × four callsites = eight functions, but each one can use the optimal API for that provider.

```
Per-call branches (all 4 callsites follow this exact shape):

  callClaude(apiKey, system, user):
    client = new Anthropic({ apiKey })
    r = client.messages.create({
      model: 'claude-sonnet-4-6',  // or claude-haiku-4-5 for classify
      max_tokens: ...,
      system,
      messages: [{ role: 'user', content: user }],
    })
    return r.content[0].text

  callOpenAI(apiKey, system, user):
    r = fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, ... },
      body: { model: 'gpt-4o', max_tokens: ..., response_format: { type: 'json_object' },
              messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }
    })
    return r.choices[0].message.content
```

**One subtlety:** OpenAI's `response_format: 'json_object'` forces JSON; Claude doesn't have that option, so the prompts say "Output ONLY a JSON object — no preamble, no markdown" and the parser strips ` ```json ` fences defensively.

---

### Heuristic before LLM (the cost gate)

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

**What it is:** every new todo runs through `heuristicClassify` first (regex-only, no network). The LLM classifier is fired only when the heuristic returns `null`.
**Why:** the LLM call costs ~$0.0001 per todo, but a heavy journaling day produces 30+ todos. Even cheap calls add up, and the heuristic catches the easy 60-70% of cases (imperative verbs, modal starts, deadlines).
**Tradeoff:** the heuristic intentionally over-fires `null`. False negatives cost one cheap LLM call. False positives (mis-classifying as 'todo' when it's an idea) would be silent and require a manual override — so the bias is firmly toward null.

**The same shape repeats elsewhere:**
- `expand.ts:218` refuses to expand when `meta.type == 'todo'` — no expansion shape exists for plain todos, so no LLM call.
- `compose.ts` falls back through `variants.clean → caption → summary.summary` — no LLM call to "compose", just a deterministic shape selection.

**Pseudocode (the gate, generalized):**

```
  cheap = freeDeterministicCheck(input)
  if cheap.isConfident: return cheap.result      // no LLM
  return await llmCall(input)
```

---

### Tool calling — not used in loopd

```
  Every loopd AI call:                  An agent with tools (NOT loopd):
  ────────────────────────              ────────────────────────────────

   prompt → JSON → done                  prompt → tool? → run tool
                                                     ▲          │
                                                     │          ▼
                                                     │     observation
                                                     └──────────┘
```

**What it isn't:** loopd does not implement tool calling, agents, or any loop where the LLM asks the app to do something and read the result back.
**Why not:** every AI feature in this app is a one-shot transformation (text → structured JSON). There's nothing for the LLM to *navigate* — the data the app needs is already in hand when the call is made.
**When tools would matter:** if the user asked "find me the day I was sickest last month" and the answer required searching entries, that's where tool calling fits (LLM emits `{tool: "search_entries", input: {query: "sickest"}}`, app runs SQL, replies). loopd doesn't have that surface today.

---

### RAG — not used in loopd, but the seed exists

```
  RAG pattern (NOT loopd):             What loopd does instead:
  ──────────────────────               ─────────────────────────

   user question                        explicit context block in the prompt
        │                                       │
        ▼                                       ▼
   embed → vector search                 callsite hand-picks N items
        │                                (last 3 days, 5 siblings, 5 captions)
        ▼                                       │
   stuff into prompt                            ▼
        │                                stuff into prompt
        ▼                                       │
   LLM answers                                  ▼
                                         LLM answers
```

**What it is in general:** Retrieval Augmented Generation — embed user data, vector-search, stuff results into the prompt.
**Why loopd doesn't need vector search yet:** the data is *small*. A user with a year of journaling has ~365 entries. Hand-picked context (last 3 days, 5 siblings, last 5 captions) is plenty for the small operations the app runs today.
**Where RAG would land if added:** "expand this todo with context from any past entry that mentioned similar ideas" — that's the moment to embed the corpus. Today the codebase fakes it with `getRecentAISummaries(date, 5)` for the caption's anti-repetition, which is hand-picked retrieval, not embed-and-search.

---

### Validation as a hard gate

```
  LLM raw output (string)
         │
         ▼
   parseJson — regex out the {…}, JSON.parse
         │
         ├─ throws → null
         ▼
   validate per-type schema (validate.ts / validateExpansion / parseAndValidate)
         │
         ├─ missing required field → null
         ├─ type out of allowed enum → null
         ▼
   persist
         │
         ├─ if null AFTER first call → caption-style: skip; expand-style: retry once with stricter system prompt
```

**What it is:** every callsite parses and *re-validates* the LLM output before writing to SQLite. The model is treated as untrusted input, even when its instructions are explicit.
**Why:** prompts drift. Models hallucinate keys. New model versions sometimes return slightly different JSON shapes. Validators catch all three.
**Tradeoff vs runtime types:** TypeScript types don't enforce at runtime. `validate.ts:validateSummary` and `expand.ts:validateExpansion` are the runtime guards.

**One retry pattern, not infinite retries:** `expand.ts:243` calls the model once, then if validation fails, calls *one* more time with an extra instruction (`"Your previous output was not valid JSON for the schema. Re-emit ONLY a single JSON object that exactly matches the schema."`). After that, give up — return `{ ok: false, reason: 'malformed' }`. The user sees a "couldn't expand" message; the row stays at `expanded_md = null` and can be retried manually.

---

### Async background classification — fire and forget

```
  reconcileTodoMetaForEntry(entry):
       │
       │   for each new todo:
       │     insertTodoMeta(...)               ← synchronous, blocking
       │     if heuristic was null and not done:
       │       scheduleClassify(todoId, text)  ← async, NOT awaited
       │
       ▼
  return                                     ← scan completes, UI re-renders
                                                with type='todo' shown for now
                                              │
              (some milliseconds later)        ▼
  classifyTodo(text)
       │
       ├─ network call to Haiku/4o-mini
       │
       ▼
  updateTodoMeta(todoId, { type, classifierConfidence, classifierModel })
       │
       ▼
  emit('classify-progress')
       │
       ▼
  /todos screen subscribes via on(CLASSIFY_PROGRESS_EVENT)
  → re-fetches metas, re-renders the type badge
```

**What it is:** the prose scan completes synchronously. Each new ambiguous todo fires an LLM call without awaiting it. The result lands later via DB write + event.
**Why:** keeping `reconcileTodoMetaForEntry` synchronous means the editor's commit doesn't block on the network. A 30-todo entry with 10 ambiguous lines would otherwise wait for 10 LLM round-trips — that's a 3-5 second pause when leaving the editor.
**Tradeoff:** the user briefly sees `type='todo'` on rows that the classifier later upgrades to `idea` / `bug` / etc. The /todos screen has a small banner showing "X classifying…" via `getClassifyInFlight()`.

```
Pseudocode (reconcileMeta.ts):
  function reconcileTodoMetaForEntry(entry):
    for each todo not in existing:
      heur = heuristicClassify(todo.text)
      meta = buildMeta(todo, heur)
      await insertTodoMeta(meta)                    ← synchronous
      if heur == null AND !todo.done:
        scheduleClassify(todo.id, todo.text)        ← FIRE, do NOT await
    for each meta not in current:
      await deleteTodoMeta(meta.todoId)

  function scheduleClassify(todoId, text):
    classifyTodo(text)
      .then(result => result && updateTodoMeta(todoId, {...}))
      .catch(err => log warning)                    ← never throws
```

---

### user_overridden_type — the manual lock

```
  Without lock:                            With lock:
  ─────────────                            ──────────

  classify  → type='idea'                  classify         → type='idea'
  user opens picker, picks 'todo'          user picks 'todo' → user_overridden_type=true
        │                                        │
  next reconcile fires...                  next reconcile / catch-up fires...
  fresh classify → type='idea' AGAIN ✗     classify still returns 'idea'
                                           BUT: write path checks user_overridden_type
                                                → SKIPS the update ✓
```

**What it is:** a single boolean column on `todo_meta`. When the user manually picks a type from the picker, the column flips to `true`. From then on, every AI-driven path (catch-up classifier, retroactive re-classify) MUST read this flag and refuse to overwrite.
**Why:** the LLM is sometimes wrong. Users notice and correct. Without the lock, the next batch run silently undoes the correction. With the lock, the user's choice is permanent.
**Where to apply this pattern:** any AI-assigned attribute that the user can override. The same shape would work for AI-suggested clip order, AI-detected mood, AI-picked filter — none of which are currently overridable, but the column is the canonical pattern when they become so.

---

### How this codebase uses AI specifically

```
  ┌────────────────────┬──────────────────┬─────────────────────────────────────┐
  │ Feature            │ Pattern          │ Why this pattern                     │
  ├────────────────────┼──────────────────┼─────────────────────────────────────┤
  │ Day summarize      │ Single chain     │ one job: structured editor JSON     │
  │                    │ Sonnet/4o        │ + freeform summary text             │
  │ 4-variant caption  │ Single chain     │ one job: 4 tonal voices of one day  │
  │                    │ Sonnet/4o        │ with theme detection                 │
  │ Todo classify      │ Heuristic + LLM  │ heuristic catches obvious; Haiku/   │
  │                    │ Haiku/4o-mini    │ mini handles the rest cheaply       │
  │ Todo expand        │ Per-type chain   │ 6 typed schemas: idea / bug /        │
  │                    │ Sonnet/4o        │ question / decision / knowledge /   │
  │                    │                  │ content. Each schema is a different │
  │                    │                  │ system prompt with its own JSON     │
  │                    │                  │ shape. The TYPE selects the chain.  │
  └────────────────────┴──────────────────┴─────────────────────────────────────┘
```

**Per feature: prompt shape, input, output**

```
  Day summarize
  ─────────────
  System: "You are an editor for a daily-vlog app. Read the day's
           entries, clip list, and habits. Output a single JSON object:
           { summary, mood, clipOrder[], clipTrims[], filterPreset, ... }"
  Input:  buildPrompt(entries, allClips, allHabits, date)
  Output: AISummary JSON, validated by validate.ts:validateSummary
          (checks every clipId in clipOrder exists, trims fit clip duration, etc.)

  4-variant caption
  ─────────────────
  System: SYSTEM_PROMPT in caption.ts (the most opinionated prompt in the codebase).
          Specifies four named voices (clean / smoother / reflective / punchy)
          with example body lines for each, plus universal rules
          (no "I"/"you"/"we"; no hashtags; no questions; no platitudes).
  Input:  { date, rawLog[], recentCaptions?, mood?, themeHint? }
  Output: { variants: { clean, smoother, reflective, punchy }, detectedTheme }
          All four required; partial output treated as malformed.

  Todo classify
  ─────────────
  System: "Classify into one of seven thinking modes:
           todo / idea / bug / question / decision / knowledge / content.
           Output ONLY {"type":"<mode>","confidence":"high|medium|low"}"
  Input:  the todo text alone — no surrounding context (cost optimization)
  Output: { type, confidence, model }

  Todo expand (per type)
  ──────────────────────
  System: getSystemPrompt(meta.type) — one of 6 templates
          (e.g., for 'bug': "Output {observed, expected, suspectedCause, reproSteps[]}")
  Input:  todo text + entry text + sibling todos + last 3 days of entries
          + cached summaries (from buildContext)
  Output: TodoExpansion union — validated against per-type required fields,
          serialized to markdown by serializeExpansion, persisted to
          todo_meta.expanded_md
```

---

### Failure modes the codebase explicitly handles

```
  ┌──────────────────────────────┬──────────────────────────────────────────────┐
  │ Failure                      │ How loopd recovers                            │
  ├──────────────────────────────┼──────────────────────────────────────────────┤
  │ No API key configured        │ all 4 services return early; UI shows banner │
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
  └──────────────────────────────┴──────────────────────────────────────────────┘
```

**The principle:** AI is best-effort. Every callsite makes sure that an AI failure leaves the canonical data (the prose, the todo, the entry) untouched. The worst outcome of any AI bug is "no AI annotation this time", never "lost data".

---

### Why no agents, no chains-of-chains

The codebase deliberately stops at single chains. The patterns above (heuristic-first, async classify, validation gate, user-override lock) are all *outside* the LLM — they're conventions in app code that surround the call.

If a feature ever needs multi-step LLM reasoning ("plan a vlog from a week of entries; review each step"), the place to add an agent is a new service file, not a modification to summarize/caption/classify/expand. Each of those four files is intentionally one-job, and the principle 12 list (DB-first, prose-canonical, etc.) doesn't change because of AI — those constraints apply equally well to whatever loopd ships next.
