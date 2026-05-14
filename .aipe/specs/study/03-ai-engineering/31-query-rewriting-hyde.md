# Query rewriting and HyDE

**Industry name(s):** Query rewriting, query expansion, HyDE (Hypothetical Document Embeddings)
**Type:** Industry standard

> Why the user's query is often the wrong thing to embed — and what to embed instead.

**See also:** → [24-embeddings-geometric](./24-embeddings-geometric.md) · → [28-hybrid-retrieval-rrf](./28-hybrid-retrieval-rrf.md) · → [29-reranking-cross-encoder](./29-reranking-cross-encoder.md)

---

## Why care

Type "knee" into GitHub's code search and you get an avalanche of token matches — README mentions, irrelevant CSS classes, every test fixture using the word. Now type "knee injury physical therapy" and the result set narrows dramatically — completely different ranking, more focused. The Algolia API exposes this gap explicitly: `query` is what the user typed, `queryLanguages` is the rewrite layer that can expand or reshape the input before retrieval fires. Google Search runs the rewrite implicitly under the hood every time you type a fragment. The user's typed string and the corpus the search runs against live in different vocabularies; the rewrite bridges them.

The implicit question is "why doesn't the user's typed string look like the things we're searching against, and how do we close that gap before the lookup?" Query rewriting is the family of techniques that answers it — and HyDE (Hypothetical Document Embeddings) is one specific shape: ask an LLM to generate a hypothetical document-shaped answer, embed *that*, and search with its vector instead of the user's. The short query and the long document live in different parts of vector space; the rewrite moves the search point into the documents' neighbourhood.

**What depends on getting this right:** recall on short queries against long-form corpora, the latency budget per retrieval call, and whether the rewrite blurs or sharpens the user's intent. For loopd the planned `src/services/ai/queryRewrite.ts` would feed `[B2A.8]` related-entries (latency-tolerant) before `[B2A.7]` interpret-this-week (already at 3–5 seconds, where +1s pushes past the perceptual threshold). The gating evidence comes from `[B2A.9]`'s eval — recall@5 below ~70% on short queries earns HyDE its slot; above that, the latency tax buys nothing.

Without the rewrite:
- User types "knee" → embed → vector lands in short-query cluster, far from any real entry
- Top-5 results are entries that happen to mention "knee" in passing, weighted by other features the model treats as similar to short prose
- The actual "day I hurt my knee playing tennis" entry sits at rank 12, the user gives up

With HyDE:
- User types "knee" → Sonnet generates "I hurt my knee yesterday playing tennis. It's been swelling and hurts when I bend it."
- Embed the hypothetical → vector now sits in the documents cluster
- Cosine search returns real knee entries; the tennis entry surfaces at rank 1 or 2
- Cost paid: +500–2000ms per query, ~$0.001–0.003 in tokens, plus the new failure mode of a bad rewrite blurring proper nouns

The user's typed string is one input shape; the documents are another — the rewrite layer is what bridges them.

---

## How it works

The fundamental observation: a short query and a long document live in different parts of vector space. "knee" embeds near other short queries, not near long entries that happen to discuss knee injuries. Closing that gap is the whole problem.

### Three flavours of query rewriting

1. **Expansion** — "knee" → "knee injury pain tennis sports". An LLM expands the short query with related terms. Helps sparse retrieval more than dense.
2. **Reformulation** — "knee" → "what did I write about hurting my knee?". An LLM turns the keyword into a natural-language question. Modest help; mostly normalises shape.
3. **HyDE** — "knee" → an LLM generates a hypothetical entry like "I went to play tennis and my knee gave out on the second set. It's been bothering me for days." Embed THAT, search with that vector. The hypothetical document lives in document-space, so its vector is in the same neighbourhood as real documents.

If you're coming from frontend, HyDE is the same shape as a "did you mean..." autocomplete that doesn't just correct typos but rewrites the entire query to match common search patterns. The LLM is the autocomplete, and the rewrite is at vector level rather than text level.

### The HyDE trick — bridge the asymmetry

```
The asymmetry problem

User types:   "knee"
Documents:    Long-form journal entries (500–2000 words each)

Vector space (illustrative)
            ┌─────────────────────────────────────┐
            │   short queries cluster              │
            │   • "knee"  • "lunch"  • "today"     │
            │                                      │
            │              wide gap                │
            │                                      │
            │   ┌──────────────────────────┐       │
            │   │ long documents cluster   │       │
            │   │ • "yesterday I twisted   │       │
            │   │   my knee playing..."    │       │
            │   │ • "had a great lunch    │       │
            │   │   at Spice House"        │       │
            │   └──────────────────────────┘       │
            └─────────────────────────────────────┘

HyDE rewrite:
  query: "knee"
       ▼  LLM generates hypothetical document
  hypo: "I hurt my knee yesterday playing tennis.
         It's been swelling and hurts when I bend it."
       ▼  embed
  hypo_vector  ← now in the documents cluster
       ▼
  search for nearest entries → finds real "knee" entries
```

The hypothetical document doesn't need to be factually accurate. It needs to be *shaped like* the documents in the corpus.

### Where it shines and where it doesn't

HyDE helps most when:
- Queries are short and the corpus is long-form (loopd's exact shape).
- Queries are conceptual and the corpus is concrete-prose.
- The embedding model has a meaningful query/doc length sensitivity.

HyDE doesn't help (and can hurt) when:
- Queries already look like documents (long-form questions, natural language).
- The user is searching for proper nouns or exact identifiers — HyDE blurs them into the hypothetical document's prose.
- The latency cost of the LLM rewrite call breaks the latency budget.

### The cost ledger

HyDE adds ~500-2000ms per query (one LLM call) plus per-query LLM cost (~$0.001-0.003 on Sonnet, less on Haiku). For a feature that queries 10 times a day at solo scale, that's pennies per month — affordable. For an autocomplete-on-every-keystroke surface, it's not.

### This is what people mean by "the query isn't the right input"

The user's typed string is one input shape; the embedding model expected another. Query rewriting bridges them. The principle generalises: any time the user's input is dimensionally different from the data being searched (short ↔ long, casual ↔ formal, colloquial ↔ technical), a rewrite layer pays off. Here's the picture.

---

## Query rewriting and HyDE — diagram

```
Three rewrite strategies, one decision

  User query: "knee"
       │
       ├──────────────────────────┐
       │                          │
       ▼  Strategy 1: no rewrite  ▼  Strategy 3: HyDE
   embed("knee")              LLM("knee")
                              → "I hurt my knee yesterday
                                 playing tennis. It's been
                                 swelling..."
                              embed(hypothetical doc)
       │                          │
       │                          │
       ▼                          ▼
  Vector lives in              Vector lives in
  short-query cluster          documents cluster
       │                          │
       ▼  cosine vs entries       ▼  cosine vs entries
  Returns: long entries        Returns: real knee
  that happen to mention       entries (better recall
  "knee" anywhere              and precision)
```

```
Strategy 2: Expansion

  User query: "knee"
       │
       ▼  LLM("expand for retrieval: knee")
  "knee injury pain tennis sports physiotherapy"
       │
       ▼  embed
  Vector slightly more localised than "knee" alone
  but still in short-query cluster
       │
       ▼
  Helps sparse retrieval (BM25) more than dense
```

---

## In this codebase

**Status:** Case B — no query rewriting today.

The curriculum's `[B2B.5]` lives in *aipe*, not loopd: *"Query rewriting: expand `/aipe:feature <intent>` into richer retrieval query."* loopd's Phase 2A doesn't have a dedicated query-rewriting build item, but the `[B2A.7]` interpret-this-week feature and `[B2A.8]` related-entries feature both *might* benefit from HyDE — to be measured if `[B2A.9]`'s eval shows recall problems.

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, lives in `src/services/ai/queryRewrite.ts`)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
Query expansion is an old IR technique (PRF — pseudo-relevance feedback — dates to the 1990s). HyDE was formalised by Gao et al. (2022) and named in the paper "Precise Zero-Shot Dense Retrieval without Relevance Labels." The trick became practical when LLMs were cheap and fast enough to add a per-query rewrite call without breaking latency budgets.

### The deeper principle
The user's input shape is often not the optimal shape for the lookup. Any system that bridges those shapes — query rewriting, autocomplete, semantic search "did you mean," even SQL query planners — earns its place when the bridge measurably improves outcomes.

### Where this breaks down
HyDE depends on the LLM's ability to generate a *plausibly-shaped* hypothetical document for the user's query. If the corpus is highly domain-specific (medical records, code, legal documents) and the LLM hasn't been trained heavily on that domain, the hypothetical will be poorly shaped and HyDE can perform worse than no rewrite.

### What to explore next
- [28-hybrid-retrieval-rrf](./28-hybrid-retrieval-rrf.md) → hybrid retrieval addresses some of the same failure modes
- [29-reranking-cross-encoder](./29-reranking-cross-encoder.md) → an alternative way to improve precision on top candidates
- `[B2B.5]` (aipe) → the parallel curriculum exercise in a different project

---

## Tradeoffs

### Comparison table — query rewriting strategies for loopd

```
┌───────────────────────┬────────────────┬───────────────────┬────────────────────┐
│ Cost dimension        │ No rewrite     │ HyDE              │ Expansion (LLM)    │
├───────────────────────┼────────────────┼───────────────────┼────────────────────┤
│ Per-query latency add │ 0              │ +500–2000ms       │ +300–1000ms        │
│ Per-query cost add    │ 0              │ ~$0.001–0.003     │ ~$0.0005–0.002     │
│ Recall lift (typical) │ baseline       │ +5–20% on short Q │ +3–10% on sparse   │
│ Precision impact      │ baseline       │ ↓ for proper nouns│ ↓ for narrow Qs    │
│ Implementation effort │ 0              │ ~50 LOC           │ ~50 LOC            │
│ Helps dense           │ —              │ Yes (load-bearing)│ Modest             │
│ Helps sparse          │ —              │ Modest            │ Yes                │
│ Risk of bad rewrite   │ —              │ Real (LLM error)  │ Modest             │
└───────────────────────┴────────────────┴───────────────────┴────────────────────┘
```

### Sub-block 1 — what no-rewrite gives up

Recall on short queries. If the user types "knee" against a long-form corpus, the query vector lands in short-query space and gets fuzzy retrieval. The right answer might not even be in top-50, depending on how many short-text inputs (cached AI summaries, todo lines, etc.) cluster near "knee." For loopd this *could* matter on the related-entries feature where users may type compact tag-like queries.

### Sub-block 2 — what HyDE would cost

A round-trip LLM call before every retrieval — 500-2000ms of latency, $0.001-0.003 per query, plus a new failure mode (the LLM generates a bad hypothetical). The interpret-this-week query (`[B2A.7]`) already takes 3-5 seconds; adding HyDE to it pushes it past 5 seconds, which is the perceptual threshold where users start treating the app as "slow." For related-entries (`[B2A.8]`) the latency is more forgiving because the user is browsing.

### Sub-block 3 — the breakpoint
HyDE earns its place if `[B2A.9]`'s eval shows recall@5 below ~70% on short queries AND if the latency budget for that feature can absorb +1 second. Below either threshold, the simpler path (no rewrite, possibly relying on hybrid retrieval to compensate) wins.

### What wasn't actually a tradeoff
Pre-computing query rewrites and caching them was never a real option for journaling queries — queries are too varied. For a static FAQ corpus the math is different.

---

## Tech reference (industry pairing)

### LLM-as-rewriter (Sonnet/Haiku)

- **Codebase uses:** target plan if rewrite ships.
- **Why it's here:** loopd already uses Claude for all of its AI chains; reusing the same provider for rewrites means no new vendor.
- **Leading today:** Sonnet/Haiku — `adoption-leading` for rewrite calls, 2026.
- **Why it leads:** the chain already exists; the rewrite prompt is small; no new vendor onboarding.
- **Runner-up:** a dedicated rewrite-tuned model (e.g., Anthropic's smaller models, OpenAI's GPT-4o-mini) — `innovation-leading` for cost optimisation; pays off once rewrite call volume grows.

### Anthropic prompt caching for the rewrite prompt

- **Codebase uses:** would compound nicely if rewrite ships.
- **Why it's here:** the rewrite system prompt is static across calls; prompt caching cuts the rewrite cost meaningfully if the rewrite prompt is long.
- **Leading today:** Anthropic `cache_control` — `adoption-leading`, 2026.
- **Why it leads:** first major provider with manual prompt caching; aligns naturally with stable system-prompt patterns.
- **Runner-up:** OpenAI automatic caching — no manual control but cheaper to enable.

---

## Project exercises

### Conditional — Add HyDE to `[B2A.8]` if eval shows recall miss

- **Exercise ID:** *deferred — gated on `[B2A.9]`'s eval results*
- **What to build:** A `rewriteQueryHyDE(query)` function in `src/services/ai/queryRewrite.ts` that calls Sonnet to generate a hypothetical 2-3 sentence entry-shaped response to the query, then returns the hypothetical text for embedding. Plug into the `[B2A.8]` related-entries pipeline behind a feature flag; measure recall@5 vs no-rewrite on the eval set.
- **Why it earns its place:** only if the eval shows recall problems on short queries. Otherwise the latency cost isn't justified.
- **Files to touch:** new `src/services/ai/queryRewrite.ts`; modify `[B2A.8]` retrieval pipeline.
- **Done when:** the function works end-to-end; eval results compare HyDE vs no-rewrite on the related-entries feature; the decision to ship or skip is documented with evidence.
- **Estimated effort:** `1–4hr` for the build; `1–2 days` end-to-end with eval.

### [B2B.5] (cross-project) Query rewriting in aipe

- **Exercise ID:** `[B2B.5]` — primary anchor in aipe; mentioned here for cross-reference.
- **What to build:** In aipe, expand `/aipe:feature <intent>` into a richer retrieval query before searching the project-context index. The same shape as HyDE but for project specs instead of journal entries.
- **Why it earns its place:** the rewrite pattern crosses projects; the discipline is the same.
- **Files to touch:** aipe's `commands/index.md` and friends.
- **Done when:** see aipe's curriculum.
- **Estimated effort:** see aipe's curriculum.

---

## Summary

Query rewriting transforms the user's raw query into a form better-shaped for the retrieval index — and HyDE specifically asks an LLM to generate a hypothetical document, embed *that*, and search with its vector instead of the query's. In loopd this is not implemented; the conditional plan is to ship HyDE on `[B2A.8]` related-entries only if `[B2A.9]`'s eval shows recall problems on short queries. The constraint that may make HyDE the wrong call is loopd's latency budget on `[B2A.7]` interpret-this-week, where an extra LLM round-trip pushes the feature past the 5-second perceptual threshold. The cost being paid for skipping HyDE is potential recall loss on short, underspecified queries.

Key points to remember:
- Short queries and long documents live in different parts of vector space.
- HyDE = LLM generates hypothetical document, embed the hypothetical, search with that.
- Best when corpus is long-form and queries are short.
- Adds 500-2000ms and ~$0.001-0.003 per query.
- Hurts precision on proper-noun queries (the rewrite blurs identifiers).

---

## Interview defense

### What an interviewer is really asking
"Do you rewrite queries?" tests whether the candidate knows the query-shape problem exists. "Why HyDE specifically?" tests whether they understand the asymmetry between query length and document length in vector space.

### Likely questions

  [mid] Q: What problem does query rewriting solve?
  A: Short user queries and long documents live in different parts of vector space — the query "knee" doesn't embed near a 1500-word journal entry that discusses a knee injury. Query rewriting bridges the gap. HyDE specifically asks an LLM to generate a hypothetical document-shaped response to the query, then embeds and searches using *the hypothetical's* vector — which lives in document space, near the real documents.
  Diagram:
  ```
  Query: "knee" → embed → short-query cluster
                          (far from real entries)
  
  HyDE rewrite:
  "knee" → LLM → "I hurt my knee yesterday..."
                  → embed → document cluster
                            (near real entries)
  ```

  [senior] Q: When would you NOT use HyDE?
  A: Three cases. First, when queries are already long-form (questions phrased as full sentences) — they already live in document space; the rewrite adds nothing. Second, when the corpus is full of proper nouns or rare identifiers the user is searching by name — HyDE blurs those into the hypothetical's natural prose. Third, when the latency budget is tight — every HyDE call adds 500-2000ms. For loopd specifically, the `[B2A.7]` interpret-this-week feature already takes 3-5 seconds; adding HyDE pushes it past the 5-second perceptual threshold. We'd ship HyDE on the related-entries feature first (more latency tolerance), measure, and only then consider it for interpret.
  Diagram:
  ```
  Picked: HyDE on B2A.8 only          Suggested: HyDE everywhere
  ──────────────────────              ──────────────────────
  +500-2000ms on related-entries      +500-2000ms on EVERYTHING
  Latency-tolerant feature             Breaks interpret-week
  ~$0.001-0.003 per query              ~3× the per-query cost
  ```

  [arch] Q: What changes at 10× users or 10× query volume?
  A: Two shifts. First, prompt caching becomes load-bearing — the rewrite system prompt is static across calls, so caching brings per-query cost from $0.001-0.003 down to $0.0001-0.0003. Second, batching becomes relevant — multiple rewrite calls can share a single Claude API connection. The architectural change is a `rewriteQueryBatch()` function that takes N queries and returns N rewrites in one call, plus aggressive prompt caching.
  Diagram:
  ```
  Today (solo)            →  per-call rewrite, no caching
  10× users               →  per-call rewrite + prompt caching
  100× users              →  batched rewrites + prompt caching
  1000× users             →  dedicated rewrite service or cheap model
  ```

### The question candidates always dodge
"Why didn't you just use a longer query template?" Most candidates wave it off. The honest answer: HyDE generates *content-shaped* rewrites; a query template can only do syntactic expansion ("knee" → "find entries about knee"). Syntactic expansion helps modestly with sparse retrieval but not with dense, because the embedding model has already learned that "find entries about" is filler. HyDE works because the LLM generates *substantive content* the embedding model treats as substantive, not as filler.

```
Picked: HyDE (LLM-generated)       Suggested: query template ("find X")
──────────────────────────         ──────────────────────────
Generates substantive content       Adds syntactic filler
Vector lands in doc space           Vector stays in query space
~500-2000ms latency                 ~0ms latency
Right when recall is the problem    Right when filler tags are the problem
```

### One-line anchors
- The user's query is one input shape; documents are another.
- HyDE = generate hypothetical → embed → search.
- Best for short-query / long-doc asymmetry.
- Adds latency and cost per query.
- Eval-driven decision; ship one feature first.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and redraw the HyDE flow: short query → LLM hypothetical → embedded → search → real document match. Mark where the query lives in vector space before and after rewrite.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) the asymmetry HyDE addresses, (b) the three rewrite flavours (none / expansion / HyDE), (c) when HyDE hurts (proper nouns, long queries, tight latency), (d) loopd's conditional plan.

### Level 3 — Apply it to a new scenario
A loopd user runs the related-entries feature with the query "Sarah." There are three entries that mention Sarah by name. Without looking, predict whether HyDE helps or hurts here, and why.

Open "Where this breaks down" and check your answer against the proper-noun discussion.

### Level 4 — Defend the decision you'd change
Today the plan is conditional on eval results. If you were starting today, would you ship HyDE by default on all retrieval surfaces? Defend your answer naming one specific failure mode each choice creates.

### Quick check — code reference test
- What file would the rewrite live in?
- What's the latency cost of HyDE per query?

Answer: `src/services/ai/queryRewrite.ts` (target, not yet created). +500-2000ms per query.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (foreign-pharmacy scenario → "why doesn't the user's string look like the corpus" pattern naming → bolded "what depends on getting this right" with `queryRewrite.ts`/`[B2A.7]`/`[B2A.8]`/`[B2A.9]` stakes → without/with bullets walking the "knee" query → one-line "rewrite bridges two input shapes" metaphor).

---
Updated: 2026-05-13 — v1.31.0 pass: rewrote Move 1 of Why care to anchor on real software (replaced traveller-mumbling-at-pharmacy analogy with GitHub code search query refinement and the Algolia queryLanguages rewrite layer).
