# Cache short-circuit as cost ceiling — buffr's load-bearing perf pattern
## Industry name(s): content-addressable cache, memoization, cache-aside · Type: Performance pattern

> The `ai_summaries` cache turns LLM call rate from "per prose-commit per candidate" into "per *unique* prose-commit per *unique* candidate." Removing the cache would multiply the per-day LLM bill by 10-100x for an active user.

## Zoom out, then zoom in

```
  WITHOUT THE CACHE                       WITH THE CACHE

  every prose-commit:                     first prose-commit:
   ─ 1 summarize call                      ─ 1 summarize call
   ─ 20 classify calls (per todo)          ─ 20 classify calls (some heuristic; ~6 LLM)
   ─ 3 interpret calls                     ─ 3 interpret calls
   total: ~24 LLM calls                    total: ~10 LLM calls

  user re-saves same entry: another 24    user re-saves: ALL CACHE HITS, ~0 LLM
```

Zoom in: most user re-saves of an entry happen because they edited something small. The chain inputs depend on the *content*, so unchanged classifier inputs hit the cache. The cost ceiling is "1× per unique input."

## Structure pass

```
  layers   ─ caller ─ cache key hash ─ DB lookup ─ LLM call
  axes     ─ uniqueness of inputs
             ─ hit rate over time
  seams    ─ caller ←→ cache : the load-bearing seam
```

## How it works

### Move 1 — the hash captures the full input

```
  key = sha256(chain || canonicalize(input))
  
  if input changes by ONE token, the hash changes; new LLM call.
  if input is unchanged, hash is identical; cache hit.
```

### Move 2 — the cost ceiling is "unique inputs × cost per call"

```
  for an active user (say 10 prose-commits/day, 15 candidates each):
   ─ without cache: 150 LLM calls/day × $0.01 average = $1.50/day
   ─ with cache: ~30-50 LLM calls/day = $0.30-0.50/day
   
  yearly difference: $360 vs $130 per user. real money at 100 users.
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ a content-keyed cache turns "cost per call" into │
   │ "cost per unique input." for buffr this is the   │
   │ difference between a viable business and an      │
   │ unviable one as user count grows.                │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
   the cost-ceiling effect

   without cache             with cache
   ─────────────             ──────────
                              
   prose-commit              prose-commit
        │                          │
        ▼                          ▼
   ┌─────────┐               ┌────────────┐
   │ 24 LLM  │               │ cache      │
   │ calls   │               │ lookup     │ ── hit ── ► done
   │ every   │               │ first      │           
   │ time    │               └─────┬──────┘           
   └─────────┘                     │ miss             
                                    ▼                  
                              ┌────────┐               
                              │ ~10    │               
                              │ LLM    │               
                              │ calls  │               
                              └────────┘               
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
  if (cached) return validate(JSON.parse(cached.result));  // ★ short-circuit
  const result = await call(input);
  const validated = validate(result);
  await db.exec(/* store */);
  return validated;
}
```

**Line-by-line:**

- The cache key is content-keyed. Any input change → new key → miss → fresh LLM call.
- Cache stored in SQLite. Persists across app launches. Survives device sleep.
- Validation runs *before* cache write. Invalid LLM output isn't memoized.

## Elaborate

The "1× per unique input" property generalizes everywhere LLM responses are deterministic functions of input. Cost ceiling becomes a function of vocabulary, not usage rate. The pattern fails when:

- inputs are unbounded in size (whole-entry RAG, multi-MB context windows)
- prompt template changes invalidate cache silently (include `prompt_version` in hash — verify)
- model changes change output for same input (include `model_id` in hash — verify)

## Interview defense

**Q [mid]:** Why cache LLM outputs?

**A:** Cost ceiling. Without the cache, every re-save costs full LLM rate. With it, only unique inputs cost. ~3-5x reduction in LLM call rate for typical users.

**Q [senior]:** How do you handle prompt drift?

**A:** Include the prompt template version in the hash input. Verify this is actually present. If not, the next prompt iteration silently returns stale outputs.

**Q [arch]:** What's the failure mode?

**A:** Stale outputs from un-versioned prompt changes. Cache pollution if invalid outputs were stored (mitigated by validate-before-write). At scale, cache table size — needs LRU or TTL eviction.

## Validate

### Level 1 — sketch the with-cache vs without-cache flow.

### Level 2 — explain why "1× per unique input" is the cost ceiling.

### Level 3 — apply: a feature changes the classify prompt. Walk: bump prompt_version; all existing entries get re-classified naturally as their cache keys change.

### Level 4 — defend: "Cache is just a perf optimization." Wrong here — it's the cost model itself.

## See also

- [`audit.md`](./audit.md) — Pass 1's lens 6.
- [`02-debounce-as-throughput-control.md`](./02-debounce-as-throughput-control.md) — the throughput side.
- `../study-system-design/03-chain-composition-with-cache-shortcircuit.md` — the architecture-side framing.
- `../study-system-design/05-heuristic-before-llm-classifier.md` — the upstream short-circuit.
- `../study-ai-engineering/06-production-serving/` — LLM caching at depth.
