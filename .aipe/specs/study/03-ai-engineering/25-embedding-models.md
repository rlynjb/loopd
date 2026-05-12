# Embedding model choice

**Industry name(s):** Embedding model selection, retrieval model selection, model comparison for embeddings
**Type:** Industry standard

> Picking an embedding model is the decision that locks in your vector space — and re-picking it later is a full corpus re-embed.

**See also:** → [24-embeddings-geometric](./24-embeddings-geometric.md) · → [30-vector-databases](./30-vector-databases.md) · → [27-dense-vs-sparse](./27-dense-vs-sparse.md)

---

## Why care

You evaluated three embedding models on the standard MTEB benchmark, picked the highest-scoring one, shipped it, indexed your whole corpus — and three months later realised that on *your* data, a different model would have scored 15% higher on hit@5. The benchmark didn't lie; it just measured the wrong things. Embedding-model choice is one of those decisions where the published number is necessary but not sufficient.

Embedding model choice is the per-project decision that sets cost, latency, dimensionality, language coverage, and quality for every retrieval that ever happens. It's the same shape as choosing a database engine or a font: the choice is mostly invisible after the fact but very expensive to undo. The pattern is the same across providers — OpenAI, Cohere, Google, sentence-transformers all ship models with different price/quality/dimension trade-offs. Here's how to evaluate for *your* corpus instead of for the benchmark.

---

## How it works

Every embedding model is a fixed function from string to vector. The function differs across models in four ways that matter: dimensionality, training-data distribution, cost per call, and quality on your specific task. The first three are spec-sheet facts; the fourth is a fight.

### Dimension is a cost and quality knob

If you're coming from frontend, you're used to thinking of "more pixels = better" until you hit storage limits. Embeddings are the same: more dimensions = more capacity for nuance, more storage cost, more compute per cosine. `text-embedding-3-small` defaults to 1536 but supports 256, 512, 1024 too — and you can pick the smallest that still passes your eval. A 256-dim variant is 6× cheaper to store and 6× faster to cosine-search than 1536-dim, with marginal quality loss on most tasks.

The practical consequence: pick the dimension *after* measuring quality, not before. Default is a trap.

### Training-data distribution is the worldview you inherit

Models trained mostly on English fail at Korean. Models trained pre-2024 don't represent 2025 events. Models trained on web corpora over-represent SEO content. The model you pick is what its creators trained it on — and your retrieval results inherit those biases.

For loopd specifically: the corpus is first-person journaling in English. A model trained on web prose (most of them) handles it fine. A model trained on conversational data (some retrieval-tuned variants) might handle it better. There's no way to know without running an eval on your data.

### Cost per call adds up only if you embed a lot

Per-query cost is tiny: `text-embedding-3-small` is ~$0.02 per million tokens. A 100-token query costs $0.000002. Even at 10 retrievals per day for a year, that's pennies. The cost surface is *indexing*, not querying — embedding every entry on commit, every chunk if you chunk, every re-embed when the entry text changes.

For loopd's ~365 entries × ~1 re-embed per year on text edits, the indexing cost is roughly the same as the query cost: a few cents per year. The choice between cheap (text-embedding-3-small) and premium (text-embedding-3-large at 5× the price) doesn't matter financially at solo scale.

### Quality on your task is the only thing that matters at this stage

Public benchmarks like MTEB score embedding models on a basket of tasks: classification, clustering, retrieval, summarisation. The retrieval section is what matters for RAG. But MTEB's retrieval section uses public datasets (BEIR, MS MARCO) that don't look like *your* corpus. A model that scores 0.82 on MTEB-retrieval might score 0.79 or 0.91 on your data; you can't know which until you run it.

The minimum viable eval: ~20–30 (query, expected entry ID) pairs from your domain, hit@5 across candidate models. Bigger evals are better but the bend in the curve happens fast — even 20 pairs separate the strong from the weak.

### This is what people mean by "eval on your data, not on the benchmark"

The benchmark is a lower bound on model quality across a population of tasks. Your task is a sample of one. Real evaluation requires a small, hand-labelled eval set from your corpus. Without it, you're picking by reputation. Here's the picture.

---

## Embedding model choice — diagram

```
Decision pipeline for picking an embedding model

┌─ Candidate set ─────────────────────────────────────────┐
│  text-embedding-3-small (1536-dim default)              │
│  text-embedding-3-small (512-dim variant)               │
│  text-embedding-3-large (3072-dim)                      │
│  Cohere embed-english-v3.0 (1024-dim)                   │
│  BGE-small (384-dim, local)                             │
└─────────────────────────────────────────────────────────┘
            │
            ▼  embed all candidates on your eval corpus
┌─ Eval set ──────────────────────────────────────────────┐
│  20–30 (query, expected_entry_id) pairs from real data  │
└─────────────────────────────────────────────────────────┘
            │
            ▼  cosine similarity → top-5 results per query
┌─ Scoring ───────────────────────────────────────────────┐
│  Per model:                                             │
│    hit@1   — was the right entry rank 1?                │
│    hit@5   — was the right entry in top 5?              │
│    MRR     — mean reciprocal rank                       │
└─────────────────────────────────────────────────────────┘
            │
            ▼  combine with cost + dim
┌─ Decision ──────────────────────────────────────────────┐
│  Pick the smallest dim that achieves your hit@5 target  │
│  on your data, from the cheapest viable model.          │
└─────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Status:** Case B — no embedding model in use today.

The choice will be made under `[B2A.3]` in Phase 2A. Current curriculum-stated likely default: `text-embedding-3-small` at 1536-dim — it's the cheapest credible general-purpose embedding model and matches the OpenAI provider already in `src/services/ai/config.ts`. The final choice depends on the eval result, not on the default.

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, the embed call lives in `src/services/ai/embed.ts`)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
The "pick an embedding model" decision became a real concern around 2022–2023 when production RAG systems started shipping at scale and the cost difference between models started mattering. Before that, most applications used whatever OpenAI shipped (`text-embedding-ada-002`) and didn't compare. MTEB (the Massive Text Embedding Benchmark) emerged in 2022 as the standard cross-model comparison.

### The deeper principle
Defaults are biases. The default model for your provider is the model that was the best general-purpose choice when the API was designed — not the model that's best for your task today. Defaulting without evaluating is a category of decision-making that scales badly across the rest of your stack.

### Where this breaks down
For very small corpora (under ~100 docs), the choice barely matters — almost any embedding model will achieve similar retrieval quality on a tiny set because the candidates are so few. For very large corpora (millions of docs), the choice matters enormously but other factors (ANN index, sharding, query routing) dominate the engineering.

### What to explore next
- [27-dense-vs-sparse](./27-dense-vs-sparse.md) → the BM25 counterpart that's the fairest comparison baseline
- [29-reranking-cross-encoder](./29-reranking-cross-encoder.md) → the rerank layer that compensates for a weaker embedding model
- [36-eval-methods](./36-eval-methods.md) → eval methodology including hit@k and MRR

---

## Tradeoffs

### Comparison table — embedding model picks for loopd's likely corpus

```
┌────────────────────────────┬──────────┬──────────┬───────────┬───────────────────┐
│ Cost dimension             │ 3-small  │ 3-large  │ Cohere v3 │ BGE-small (local) │
├────────────────────────────┼──────────┼──────────┼───────────┼───────────────────┤
│ Dimensions (default)       │ 1536     │ 3072     │ 1024      │ 384               │
│ Cost per 1M tokens         │ $0.02    │ $0.13    │ $0.10     │ $0 (self-host)    │
│ MTEB retrieval avg (~)     │ 0.62     │ 0.65     │ 0.64      │ 0.55              │
│ Network call needed        │ Yes      │ Yes      │ Yes       │ No                │
│ Storage per entry          │ ~6 KB    │ ~12 KB   │ ~4 KB     │ ~1.5 KB           │
│ Compute per cosine         │ Moderate │ High     │ Moderate  │ Low               │
│ Re-embed cost (~365 ents)  │ ~$0.01   │ ~$0.05   │ ~$0.04    │ $0                │
│ Mobile-feasible inference  │ No       │ No       │ No        │ Borderline (slow) │
└────────────────────────────┴──────────┴──────────┴───────────┴───────────────────┘
```

### Sub-block 1 — what `text-embedding-3-small` (likely pick) would give up

3–5 percentage points of retrieval quality vs the larger models or Cohere. At solo loopd scale this is not measurable — the 20-30 eval pair set is too small to reliably distinguish 0.62 vs 0.65 hit@5. The cost savings (3-small is 6× cheaper than 3-large) become relevant only past ~100k entries; at loopd's 365 entries the absolute dollar difference is pennies per year.

### Sub-block 2 — what BGE-small (local) would have cost

Zero monetary cost, no network round-trip per embed, and the ability to embed without an internet connection — meaningful for a local-first journaling app. The cost is lower quality (MTEB ~0.55 vs ~0.62 for 3-small), CPU usage on the user's phone during indexing, and an extra dependency to bundle. The decision flips toward BGE when (a) offline embedding becomes a requirement, or (b) cost truly matters (multi-tenant scale).

### Sub-block 3 — the breakpoint
The choice of `3-small` stops being right when (a) eval results on real data show meaningful quality difference vs 3-large or Cohere (currently unmeasurable at solo eval-set sizes), (b) loopd grows to multi-tenant and per-tenant embed cost becomes meaningful, or (c) the corpus expands to non-English journaling and a multilingual model becomes necessary.

### What wasn't actually a tradeoff
Training a custom embedding model on loopd's data was never a real option. The corpus is too small (~365 docs/user) and the engineering cost is enormous compared to the marginal quality gain.

---

## Tech reference (industry pairing)

### text-embedding-3-small (OpenAI)

- **Codebase uses:** target default for `[B2A.3]`, pending eval.
- **Why it's here:** the cheapest credible general-purpose embedding model; configurable dimensions; same vendor as one of loopd's existing chat-completion providers.
- **Leading today:** `text-embedding-3-small` — `adoption-leading` for application-side embeddings, 2026.
- **Why it leads:** cheap, fast, good-enough quality for most retrieval tasks; configurable dim is rare among competitors.
- **Runner-up:** Cohere `embed-english-v3.0` — `innovation-leading` for retrieval quality on English-only corpora; slightly better hit@k on some benchmarks; pricier and adds a second vendor.

### MTEB (benchmark, not a model)

- **Codebase uses:** consulted but not authoritative.
- **Why it's here:** the standard cross-model benchmark; helps narrow the candidate set from "all embedding models ever" to "5 worth evaluating on your data."
- **Leading today:** MTEB — `adoption-leading` for benchmark comparison, 2026.
- **Why it leads:** broad task coverage, frequently updated, leaderboard is public.
- **Runner-up:** BEIR — `adoption-leading` for retrieval-specific benchmarking; narrower than MTEB but better-aligned to RAG use cases.

---

## Project exercises

### [B2A.3] Pick the embedding model with a real eval

- **Exercise ID:** `[B2A.3]`
- **What to build:** A small eval script that runs ~20-30 (query, expected_entry_id) pairs against 3-4 candidate models and outputs hit@1, hit@5, and MRR per model. Candidates: `text-embedding-3-small` (1536-dim and 512-dim), `text-embedding-3-large`, Cohere `embed-english-v3.0`. Pick the winner and document why in `loopd/.aipe/specs/features/rag-personal-corpus.md`.
- **Why it earns its place:** this is the decision the entire Phase 2A RAG pipeline locks in. Picking by reputation is the lazy version; picking by eval on real data is the receipt.
- **Files to touch:** new `scripts/eval-embedding-models.mjs`; reads real `entries.text` from a dev DB; writes results to `scripts/eval-results/embedding-models-<date>.md`.
- **Done when:** the script outputs a per-model scoreboard; the chosen model is named in the feature spec with a one-paragraph rationale that references the eval numbers (not just the MTEB leaderboard).
- **Estimated effort:** `1–4hr`.

---

## Summary

Embedding model choice is the per-project decision that locks in your vector space's quality, cost, dimensionality, and language coverage — and it's locked-in because re-picking later means re-embedding the entire corpus. In loopd this decision lives in `[B2A.3]` and has not been made; the likely default is `text-embedding-3-small` at 1536-dim because it's cheap, well-documented, and matches an existing provider. The constraint that makes this the right call is eval-set size: at 20-30 pairs, the eval can distinguish strong from weak models but not 3-small from 3-large in any statistically meaningful way, so picking the cheaper one and saving the quality-comparison work is rational. The cost being paid is 3–5 percentage points of retrieval quality versus larger or premium models — invisible at this corpus size, possibly meaningful at 10× scale.

Key points to remember:
- Default is a trap; eval on your data, not on MTEB alone.
- Dimensions are a knob: 256/512/1024 variants exist; pick the smallest that passes your eval.
- Embedding model choice is largely irreversible without a full re-embed.
- For loopd at solo scale, the financial difference between candidate models is pennies per year.
- The eval set is ~20-30 (query, expected) pairs; bigger is better but the curve bends fast.

---

## Interview defense

### What an interviewer is really asking
"How did you pick your embedding model?" tests whether the candidate has eval discipline or picked by reputation. Saying "I used OpenAI's default" is a fail unless followed by "and I verified it on my data." Saying "text-embedding-3-small because it's cheap" is a fail unless followed by "and the quality difference vs the larger models wasn't measurable on my eval set."

### Likely questions

  [mid] Q: How do you pick an embedding model?
  A: I narrow the candidate set using MTEB or similar leaderboards (filter for the retrieval task), pick 3-4 models that span the cost/dim/quality space, build a small eval set from real domain data (20-30 query/expected pairs), measure hit@1, hit@5, and MRR per model, and pick the cheapest model that achieves my quality target. The leaderboard is necessary because there are too many models to eval all of them; the eval set is necessary because the leaderboard wasn't measured on my data.
  Diagram:
  ```
  MTEB         narrow to 3-4         your data        pick
  ─────  →     candidates      →     eval set    →   the one
  100s         3-4                   20-30 pairs       
  ```

  [senior] Q: Why didn't you pick `text-embedding-3-large`?
  A: Three reasons. First, my eval set (20-30 pairs at solo scale) is too small to reliably distinguish 3-large from 3-small — both score in roughly the same band on my data within noise. Second, 3-large is 5× the per-token cost; at 10× corpus scale the cost difference is meaningful, at current scale it's pennies but the *practice* of picking the cheaper option matters for habit formation. Third, 3-large is 3072-dim, which is 2× the storage and 2× the cosine-compute cost; that latency starts being user-visible in JS-side cosine search at 10× corpus. I'd re-evaluate the choice if (a) eval-set size grew large enough to discriminate, (b) corpus scale shifted, or (c) retrieval quality became a user-facing complaint.
  Diagram:
  ```
  Picked: 3-small (1536-dim)        Suggested: 3-large (3072-dim)
  ─────────────────────────         ─────────────────────────
  ~$0.02 per 1M tokens               ~$0.13 per 1M tokens
  1536 floats × 4B per entry         3072 floats × 4B per entry
  6 KB storage × 365 entries         12 KB storage × 365 entries
  ~5ms cosine on 365                 ~10ms cosine on 365
  ≈ same hit@5 within eval noise     Marginally better on MTEB
  ```

  [arch] Q: What would change at 10× corpus and 10× users?
  A: At 10× corpus (~3650 entries/user), the storage cost per entry starts mattering: 1536-dim × 4 bytes × 3650 ≈ 22 MB per user; at 10× users this is 220 MB cloud storage and the same per-device. The cosine-search compute in JavaScript becomes user-visible (~50-100ms). Two changes follow: move from JS cosine to `sqlite-vec` with an HNSW ANN index for sub-10ms search regardless of corpus size, and consider lower-dim variants of the same model (3-small at 512-dim cuts storage 3× with marginal quality loss) for cost.
  Diagram:
  ```
  ┌─ Service layer ─────────────────┐
  │ JS cosine search                │  ← breaks first at 100k
  │ → sqlite-vec HNSW               │
  └─────────────────────────────────┘
              │
  ┌─ Storage layer ─────────────────┐
  │ entry_embeddings (1536-dim)     │
  │ → consider 512-dim if quality   │
  │   eval still passes             │
  └─────────────────────────────────┘
  ```

### The question candidates always dodge
"Why didn't you fine-tune your own embedding model?" The honest answer: a custom embedding model needs a labelled training set (10k+ pairs at minimum for finetuning, 100k+ for from-scratch) and engineering cost (training infrastructure, eval pipeline, deployment) that's enormous compared to the marginal quality gain over an off-the-shelf model. For solo loopd this is decisively the wrong investment; for a billion-dollar product with terabytes of in-domain data it might be right.

```
Picked: off-the-shelf         Suggested: fine-tune our own
─────────────────────         ─────────────────────────
0 training infra              GPU infra + dataset pipeline
Off-the-shelf eval            Eval set + training loop + serving
~6 KB per entry storage       Same storage
Right at solo scale           Right at 100M+ doc scale
```

### One-line anchors
- Defaults are biases; eval on your data.
- The choice locks in your vector space; re-picking = re-embed everything.
- Dimensions are a knob, not a constant.
- At solo scale, the cheap model is the right model.
- Eval set is small; the bend in the curve is sharp.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and redraw the decision pipeline: candidate set → eval set → scoring → decision. Label what flows between each box.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) the four dimensions of model choice (dim, training data, cost, quality), (b) why the public benchmark isn't sufficient, (c) what the minimum viable eval looks like, (d) why the choice is largely irreversible.

### Level 3 — Apply it to a new scenario
A loopd user starts journaling in Korean half the time. Your current model is `text-embedding-3-small`. Without looking, name two questions you'd want answered before considering a model swap, and the smallest experiment to answer each.

Open this file and check your answer against "Where this breaks down" and the Tradeoffs comparison.

### Level 4 — Defend the decision you'd change
Today the curriculum's default is `text-embedding-3-small` at 1536-dim. If you were starting Phase 2A today, would you make the eval set bigger (~100 pairs instead of 20-30) before picking? Defend your answer naming a specific failure mode each choice creates.

### Quick check — code reference test
- What file would the embed call live in?
- What table would store the vectors?

Answer: `src/services/ai/embed.ts` (target, not yet created). `entry_embeddings` (target — `[B2A.2]`).
