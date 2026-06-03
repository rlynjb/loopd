# Chain composition with cache short-circuit — the cost & determinism floor
## Industry name(s): cache-aside, compose pattern, deterministic LLM orchestration · Type: Architecture pattern

> `compose.ts` orchestrates buffr's 5 chains as a deterministic outer function. Every chain call goes through the `ai_summaries` cache first; hits short-circuit (no LLM call). The pattern caps the per-day cost ceiling, makes re-runs idempotent, and lets the system reason about LLM output the way it reasons about any other function call.

## Zoom out, then zoom in

```
  THE COMPOSE PATTERN

  compose(input):
    summary  = cached('summarize', input)
    todos    = for line in candidates:
                  cached('classify', { line, ...ctx })
    threads  = for t in impacted:
                  cached('interpret', { thread: t, ...ctx })
    return  { summary, todos, threads }

  cache lookup is keyed by HASH(chain, input).
  hit → return stored result; no LLM call.
  miss → call LLM → validate → store → return.
```

Zoom in: the cache key includes the input prose. If the user edits the entry, the hash changes; classification re-runs naturally. No explicit invalidation needed.

## Structure pass

```
  layers   ─ compose ─ chain ─ cache lookup ─ LLM provider
  axes     ─ determinism (same input → same hash → same output)
             ─ cost (LLM calls per prose-commit)
  seams    ─ compose ←→ chain : a function call
             ─ chain ←→ cache : key by hash
             ─ chain ←→ LLM   : provider abstraction
```

## How it works

### Move 1 — the cache is content-addressable

```
  key = hash(chain_name + canonicalized_input)
  
  canonicalized_input means:
   ─ JSON-stringified with sorted keys
   ─ whitespace normalized in prose where it doesn't change meaning
   ─ stable across runs of the same code
```

### Move 2 — chain output is validated before cache write

```
  every chain returns a schema-typed object.
  on LLM miss:
   1. assemble prompt
   2. call provider
   3. parse response into the chain's expected shape
   4. validate (zod or hand-rolled)
   5. ★ only after validate: store in cache ★
   6. return
  
  validation failures throw; cache stays clean (no garbage stored).
```

### Move 3 — compose is itself deterministic

```
  for the same { entries.text, surrounding context }, compose
  returns the same { summary, todos, threads }.
  this lets the prose-commit be RE-RUN safely. if reconcileMeta
  fails mid-way, the user re-triggers, and compose returns
  cached results immediately. no double-LLM-spend.
```

## Primary diagram

```
   the chain call path

   compose.ts
      │
      │  classify({ line, ctx })
      ▼
   ┌────────────────────────────────┐
   │  cache: SELECT FROM ai_summaries│
   │  WHERE chain='classify'         │
   │  AND input_hash=?               │
   │                                 │
   │  hit?  ──── yes ──► return ──► ↗│
   │   │                             │
   │   no                            │
   │   ▼                             │
   │  LLM call → validate → store ──►│
   └────────────────────────────────┘
```

## Implementation in codebase

```ts
// pattern; src/services/ai/cache.ts
export async function cachedChain<I, O>(
  chain: string,
  input: I,
  call: (i: I) => Promise<O>,
  validate: (o: unknown) => O,
): Promise<O> {
  const key = hashInput(chain, input);
  const cached = await db.queryFirst<{ result: string }>(
    `SELECT result FROM ai_summaries WHERE chain = ? AND input_hash = ?`,
    [chain, key],
  );
  if (cached) return validate(JSON.parse(cached.result));
  const result = await call(input);
  const validated = validate(result);
  await db.exec(
    `INSERT INTO ai_summaries (user_id, id, chain, input_hash, result, ...)
     VALUES (?, ?, ?, ?, ?, ...)`,
    [/* ... */],
  );
  return validated;
}
```

```ts
// pattern; src/services/ai/compose.ts
export async function composeProseCommit(entry: Entry): Promise<Composed> {
  const summary = await cachedChain('summarize', { text: entry.text },
                                     callSummarize, validateSummary);
  const candidates = extractCandidateLines(entry.text);
  const todos = await Promise.all(
    candidates.map(line => cachedChain('classify', { line, date: entry.date },
                                        callClassify, validateClassify))
  );
  const impacted = findImpactedThreads(entry, todos);
  const threads = await Promise.all(
    impacted.map(t => cachedChain('interpret', { thread: t },
                                   callInterpret, validateInterpret))
  );
  return { summary, todos, threads };
}
```

**Line-by-line read:**

- `cachedChain` is the gateway. No chain bypasses it. This is the design discipline that caps cost.
- Validation runs *before* cache write, so invalid LLM output isn't memoized.
- `compose` is pure with respect to LLM side effects: same input → same output (modulo cache state).
- Fan-out (`Promise.all` over candidates) is parallel; cost is one HTTP call per uncached candidate.

## Elaborate

The cache-aside-with-hash pattern is the cheapest possible LLM cost control. It only works when:

- chain inputs are bounded in size (buffr's are)
- chain inputs are deterministic functions of stored state (they are)
- chain output is validable into a fixed shape (buffr's are, per-chain)

If chains' outputs were unstructured prose, the cache would still work but the validate step would degrade to "is this a string." Buffr's chains all produce structured output (summaries with bounded length, classifications with a fixed enum, etc.), which makes validate strong.

The pattern's failure mode is **prompt drift without cache invalidation**: if a developer changes the prompt template, all existing cache entries still match by hash and serve stale outputs. Buffr's mitigation: include a `prompt_version` in the hash input. Verify this is actually present; if not, the next prompt rewrite will silently return old outputs.

## Interview defense

**Q [mid]:** Why cache LLM outputs?

**A:** Cost. A daily user runs ~10 prose-commits per day; classify alone fans out 5-20× per commit. Without the cache, every re-render or re-trigger pays full LLM cost. With it, the user pays once per unique input.

**Q [senior]:** What's in the cache key?

**A:** Chain name + hash of canonicalized input. The hash must include everything that could change the output: the prompt template version, the model name, the input prose. Missing any of these means stale outputs after a prompt change.

**Q [arch]:** When does this pattern break?

**A:** When inputs are unbounded (long context window with retrieval-augmented prompts → hash collisions on near-duplicates). When chains have side effects (writes elsewhere). When the cache itself becomes a bottleneck (millions of rows). For buffr today, all three are far away.

## Validate

### Level 1 — sketch the cache lookup → LLM miss → store → return flow.

### Level 2 — explain why validation runs before cache write.

### Level 3 — apply: a teammate adds a `caption` chain that takes an image. How does the cache key change? Include image content hash, not URL.

### Level 4 — defend: "Caching LLM outputs causes stale data." Only if the cache key is wrong. Properly-hashed inputs invalidate naturally when inputs change.

## See also

- [`04-prompt-driven-prose-commit.md`](./04-prompt-driven-prose-commit.md) — what compose is called from.
- [`05-heuristic-before-llm-classifier.md`](./05-heuristic-before-llm-classifier.md) — the other cost-saving pattern.
- [`audit.md`](./audit.md) — Pass 1's lens 4 (caching).
- `../study-ai-engineering/06-production-serving/` — caching at a deeper level.
- `../study-prompt-engineering/03-prompts-as-code.md` — why prompt versioning matters for the cache key.
