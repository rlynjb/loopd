# Heuristic-before-LLM classifier — the 70% short-circuit
## Industry name(s): rules-first then ML, fast-path classifier, escalation cascade · Type: Architecture pattern

> The classify chain checks a cheap deterministic heuristic *before* calling the LLM. ~70% of candidate lines match the heuristic and short-circuit. Cost and latency drop accordingly. The LLM handles only the ambiguous tail.

## Zoom out, then zoom in

```
  THE CASCADE

  classify(line, ctx):
    1. heuristic_check(line) → fast result?  yes → return
    2. cache lookup            → hit?         yes → return
    3. LLM call                → validate    → return

  hit rates (production approximation):
    heuristic: ~70%
    cache:     ~20% of remainder (variable)
    LLM:       ~10% of total candidates
```

Zoom in: the heuristic looks for unambiguous signals — a leading "TODO:" marker, a clear "- [ ]" checkbox, a date pattern recognizable as "scheduled today." When these fire, the line is *obviously* in one classification category; the LLM call would just confirm what the heuristic already knows.

## Structure pass

```
  layers   ─ heuristic ─ cache ─ LLM
  axes     ─ certainty (heuristic = high; LLM = probabilistic)
             ─ cost (heuristic = ms; LLM = $cents)
  seams    ─ heuristic ←→ cache : heuristic results bypass cache
             ─ cache ←→ LLM     : cache short-circuits LLM
```

## How it works

### Move 1 — the heuristic checks for unambiguous shapes

```
  examples of high-confidence shapes:
    "- [ ] X"               → todo
    "TODO: X"               → todo
    "DONE: X"               → todo (completed)
    "idea: X"               → idea
    "- [x] X"               → todo (completed)
    "20g protein, 100g X"   → nutrition (delegates to nutrition chain)
  
  if NONE of these match → LLM is asked.
```

### Move 2 — the LLM handles the ambiguous tail

```
  examples where heuristic stays silent:
    "I want to remember that A = B because C"
       → ambiguous: knowledge? study? reflect?
    "tomorrow I'll think about X"
       → ambiguous: todo (low intent)? reflect?
  
  the LLM call here is what earns its keep.
```

### Move 3 — the principle: pay LLM only for the hard tail

```
   ┌──────────────────────────────────────────────────┐
   │ for any classifier, identify the cheap-detectable│
   │ subset and short-circuit it. only pay LLM cost   │
   │ for the genuinely ambiguous cases. the heuristic │
   │ can be wrong on the edge — but its DOMAIN is     │
   │ the unambiguous middle.                          │
   └──────────────────────────────────────────────────┘
```

## Primary diagram

```
   the classifier cascade

   candidate line
        │
        ▼
   ┌─────────────────────────────────┐
   │ heuristic                        │
   │   "- [ ] X"      → todo         │ ──► return  ◄── ~70%
   │   "TODO: X"      → todo         │
   │   "idea: X"      → idea         │
   │   no match       → next         │
   └─────────────────────────────────┘
                                ↓
   ┌─────────────────────────────────┐
   │ cache lookup (input hash)        │ ──► return  ◄── ~20% of rem
   └─────────────────────────────────┘
                                ↓
   ┌─────────────────────────────────┐
   │ LLM call                          │ ──► return  ◄── ~10% total
   │ validate, store, return           │
   └─────────────────────────────────┘
```

## Implementation in codebase

```ts
// pattern; src/services/ai/classify.ts
export async function classify(line: string, ctx: ClassifyCtx): Promise<TodoType> {
  // 1. heuristic short-circuit
  const heuristic = heuristicClassify(line);
  if (heuristic) return heuristic;

  // 2. cache lookup
  // 3. LLM
  return cachedChain('classify', { line, ctx }, callClassifyLLM, validateClassify);
}

function heuristicClassify(line: string): TodoType | null {
  const trimmed = line.trim();
  if (/^- \[[ x]\]/i.test(trimmed)) return 'todo';
  if (/^todo:/i.test(trimmed))       return 'todo';
  if (/^done:/i.test(trimmed))       return 'todo';
  if (/^idea:/i.test(trimmed))       return 'idea';
  if (/^reflect:/i.test(trimmed))    return 'reflect';
  // ... etc
  return null;
}
```

**Line-by-line read:**

- The heuristic returns `null` when it has no opinion. The LLM is the only fallback; it gets the ambiguous tail by definition.
- The heuristic's coverage is calibrated to the user's actual writing style — it should match the markers the user uses most often, not "every possible TODO marker on the internet."
- The classification *set* is the real one: `todo, idea, knowledge, study, reflect`. See `src/types/todoMeta.ts`. Heuristics only cover the unambiguous subset; the LLM covers the rest.

## Elaborate

The cascade pattern generalizes everywhere LLMs do classification:

- **search ranking:** cheap BM25 first, LLM rerank top-N
- **moderation:** regex rules + classifier hits first, LLM judges the gray zone
- **spam detection:** known-bad signals first, LLM scores the unknown

The discipline is: the cheap stage's *coverage* is what matters most, not its precision on edge cases. If heuristic covers 70% of inputs with 99% precision, the LLM handles 30% — that's a 3.3x cost reduction. If heuristic covers 90% with 95% precision, the LLM handles 10% — 10x reduction, but the 5% precision loss on the cheap stage matters more.

Buffr's heuristic is conservative — high precision, lower coverage. This means the LLM still earns its keep on a meaningful chunk. The alternative (greedier heuristic) would mis-classify more often; user trust matters more than cost on a journaling app.

## Interview defense

**Q [mid]:** Why not just always call the LLM?

**A:** Cost and latency. 70% of candidate lines have unambiguous shape — the LLM call would just confirm what a 5ms regex already knows. The heuristic short-circuit caps the per-day LLM spend.

**Q [senior]:** What if the heuristic is wrong?

**A:** Then it's miscalibrated. The fix is conservative coverage — only short-circuit when the shape is unambiguous. Edge cases ("- [x] but the user means it ironically") fall to the LLM. Calibration is empirical: log the heuristic→LLM disagreement rate; tune the heuristic.

**Q [arch]:** Why not learn the heuristic from data?

**A:** Eventually, sure. For buffr today, the user's writing patterns are stable enough that hand-tuned regexes suffice. The day buffr has a million users with diverse patterns, training a tiny classifier on logged input → confirmed output pairs becomes worth it.

## Validate

### Level 1 — sketch the cascade.

### Level 2 — explain why heuristic returns `null` rather than guessing.

### Level 3 — apply: design a heuristic for the summarize chain. (Hard — summaries are inherently generative; heuristic short-circuit doesn't apply the same way.)

### Level 4 — defend: "Heuristics are technical debt." Wrong direction for this case — the heuristic is precise on its domain by construction. The cost it saves is real money.

## See also

- [`03-chain-composition-with-cache-shortcircuit.md`](./03-chain-composition-with-cache-shortcircuit.md) — the cache layer below this.
- [`audit.md`](./audit.md) — Pass 1's lens 7 (scale).
- `../study-ai-engineering/01-llm-foundations/` — heuristic-before-LLM as a foundational pattern.
- `../study-prompt-engineering/06-single-purpose-chains.md` — each chain is small and focused.
