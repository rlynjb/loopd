# Chunking strategies

**Industry name(s):** Chunking, document segmentation, text splitting, passage retrieval
**Type:** Industry standard

> The decision that comes between "embed this document" and "embed *what part* of this document" — and why getting it wrong silently degrades every retrieval.

**See also:** → [24-embeddings-geometric](./24-embeddings-geometric.md) · → [03-context-window](./03-context-window.md) · → [32-stale-embeddings](./32-stale-embeddings.md)

---

## Why care

A long letter arrives — five pages, single envelope. The mail room has a slot that fits A4-sized envelopes but not a folded five-page wad. The clerk's options: stuff the whole letter into one large envelope and hope the slot accepts the bulge; cut it cleanly between paragraphs into five smaller envelopes that fit; or chop it sentence-by-sentence into thirty tiny envelopes. The clerk that sends one bulky envelope loses some pages at the slot; the clerk sending thirty tiny envelopes loses the thread between sentences ("It was great" — what was great?). Same letter, three deliveries, three different things received on the other side.

The implicit question is what size piece you cut the document into before sending it through a fixed-size opening. Not "how do I embed the entry," but "how much of the entry per vector." A single vector per long entry averages every idea into a centroid that points at none of them; one vector per sentence shatters the antecedents; somewhere in between is the right cut.

**What depends on getting this right:** every retrieval feature in the Phase 2A roadmap that touches long entries. Today loopd doesn't chunk — `interpret.ts` and `expand.ts` work at the whole-entry granularity (`buildContext` in `expand.ts` ships ~3 days of entry context as-is). When `[B2A.7]` interpret-this-week or any "find what I said about my knee" feature lands, the planned `embed.ts` will face the call: one vector per `entries.text` row (whole-entry, simplest), one per sentence (highest precision, 5–20× storage in `entry_embeddings`), or one per paragraph (middle). Pick wrong and the right entry gets buried at rank 17 behind cat-topic centroids, or — at the other extreme — "it was great" lands in a chunk with no antecedent. The decision affects `entry_embeddings` storage cost, search latency, and recall, and re-chunking later means re-embedding every entry.

Without chunking (whole-entry vectors):
- One vector per `entries.text` row. Simplest. Smallest table.
- Long entries with many topics produce centroid vectors near no single topic
- "What did I say about my knee?" misses the entry that's 90% about a cat

With sentence-window chunking:
- ~10× rows in `entry_embeddings`; per-sentence precision
- "It was great" sentence has no antecedent in its own vector → meaningless match
- Higher recall on multi-topic entries; lower precision on context-dependent sentences

A long letter cut into envelopes that fit the slot — not so big it jams, not so small the sentences lose each other.

---

## How it works

A 1500-word entry has many ideas. The embedding model compresses all of them into one 1536-float vector — and that vector is the centroid of the entry's many meanings. Centroid-of-many is the problem.

### Three common strategies, in order of granularity

1. **Whole-document.** One vector per entry, regardless of length. Simplest. Fastest. Loses local detail.
2. **Sentence-window.** One vector per sentence (or per 2-3 sentence rolling window). Many vectors per entry. Highest precision; slower search; storage 5-20× whole-document.
3. **Semantic chunking.** Split at meaningful boundaries (paragraphs, topic shifts) using either rules (blank lines, headers) or a model (a separate "where does the topic change?" call). Middle of the road on both precision and storage.

If you're coming from frontend, this is the same trade-off as `Array.prototype.find()` vs `Array.prototype.filter()` vs a B-tree index — the question is *how granular should your queryable unit be?* and the answer depends on the query patterns you expect.

### Why "embed the whole entry" sometimes works and sometimes doesn't

For loopd's existing chains, the entry-level granularity is correct because the chain's job is "summarise/caption *this entry*." There's no sub-entry retrieval. Whole-document is correct when the retrieval unit matches the consumption unit.

The practical consequence: chunking only earns its place when (a) entries become long enough that a single vector loses fidelity, AND (b) the user wants to find *parts of entries*, not whole entries. For Phase 2A's `[B2A.7]` interpret-this-week, the consumption unit is "this week's entries" — the entry-level granularity works fine, because the user asks "what was this week about?" not "what was the second paragraph of Tuesday about?"

### Chunk size and overlap are knobs, not constants

When you do chunk, two parameters matter:

- **Chunk size** — typically 200-1000 tokens. Smaller = more precision, more storage, more vectors to search.
- **Overlap** — 0-50% of chunk size. Avoids splitting a single idea across two chunks. Costs ~10-30% extra storage.

The sentence-window approach with 3-sentence chunks and 1-sentence overlap is a popular default; it lands chunks at natural boundaries and keeps adjacent ideas joined.

### Where chunking goes wrong

Three failure modes recur:

1. **Cross-chunk references.** Entry: "I ate at Spice House. It was great." Chunking by sentence puts "It was great" in its own chunk with no antecedent. The "it" vector is meaningless.
2. **Topic-bleed averaging.** A single chunk that spans two topics (cat → knee → movie) gets an averaged vector that's near neither.
3. **Boundary-cut over-fragmentation.** A blank-line splitter cuts a single thought across chunks because the user pressed Enter twice mid-paragraph.

The fix to all three is "evaluate, don't theorise" — pick a strategy, build the eval set, measure hit@5, iterate.

### This is what people mean by "chunking is an empirical decision"

There is no universal best chunking strategy. There's only "the strategy that scored highest on *your* eval set for *your* expected query patterns." For loopd, that strategy is most likely whole-entry first, with sentence-window as a fallback only if the eval shows the whole-entry approach missing recall.

Here's the picture of how granularity translates into trade-offs.

---

## Chunking strategies — diagram

```
Granularity vs precision/recall trade-off

  Whole-document chunking
  ┌─────────────────────────────────────────────────┐
  │ entry #347 (1500 words, 3 topics)               │  →  1 vector
  └─────────────────────────────────────────────────┘
                       │
                       ▼
                 1 vector / entry        precision: low (topic-averaged)
                 fast retrieval          recall:    high (every entry findable)
                 small storage

  Sentence-window chunking (3-sentence, 1-sentence overlap)
  ┌─ chunk 1 ────────────┐
  │ sentences 1, 2, 3    │  →  vector A
  └──────────────────────┘
       ┌─ chunk 2 ────────────┐
       │ sentences 3, 4, 5    │  →  vector B
       └──────────────────────┘
            ┌─ chunk 3 ────────────┐
            │ sentences 5, 6, 7    │  →  vector C
            └──────────────────────┘
                       │
                       ▼
                 ~5-20 vectors / entry   precision: high (sub-entry hits)
                 slower retrieval        recall:    same (with rollup)
                 5-20× storage

  Semantic chunking (split at topic shifts)
  ┌─ topic A ────┐
  │ paragraphs   │  →  vector A
  │ about cat    │
  └──────────────┘
  ┌─ topic B ──┐
  │ paragraph  │     →  vector B
  │ about knee │
  └────────────┘
                       │
                       ▼
                 2-5 vectors / entry     precision: high (topic-aligned)
                 needs splitter logic    recall:    same
                 ~2-5× storage
```

---

## In this codebase

**Status:** Case B — no chunking in use today.

The curriculum's `[B2A.5]` decision: **per-entry whole-text first; sentence-window only if eval shows recall miss.** For loopd's typical entry length (a few paragraphs) and expected query patterns ("find an entry about X" rather than "find a paragraph about X"), the whole-entry vector should be sufficient. The decision spec lives in `loopd/.aipe/specs/features/rag-personal-corpus.md` once written.

**File:** *(no implementation yet)*
**Function / class:** *(if shipped, lives in `src/services/ai/embed.ts:chunkEntry()`)*
**Line range:** *(n/a)*

---

## Elaborate

### Where this pattern comes from
Chunking became a named discipline around 2022 when long-context production RAG started showing the cross-chunk reference problem. Before that, most retrieval systems used document- or page-level indexing inherited from search-engine practice. The sentence-window pattern is borrowed from passage retrieval (Karpukhin et al., 2020).

### The deeper principle
The unit of retrieval should match the unit of meaning your user is searching for. Index too coarsely and the right answer gets averaged out; index too finely and adjacent context gets lost.

### Where this breaks down
Chunking strategy fails when your documents have *deeply nested* structure — long technical reports with sub-sections that reference each other. For those, hierarchical retrieval (find the doc, then find the section) outperforms either flat whole-document or flat sentence-window.

### What to explore next
- [29-reranking-cross-encoder](./29-reranking-cross-encoder.md) → how a reranker can compensate for sub-optimal chunking
- [33-incremental-indexing](./33-incremental-indexing.md) → when chunks become stale on text edit
- [27-dense-vs-sparse](./27-dense-vs-sparse.md) → BM25 has different chunking sensitivities than embeddings

---

## Tradeoffs

### Comparison table — whole-entry vs sentence-window for loopd

```
┌─────────────────────────┬─────────────────────────┬────────────────────────┐
│ Cost dimension          │ Whole-entry (plan)      │ Sentence-window (alt)  │
├─────────────────────────┼─────────────────────────┼────────────────────────┤
│ Vectors per entry       │ 1                       │ 5-20                   │
│ Storage / 365 entries   │ ~2 MB                   │ ~10-40 MB              │
│ Indexing cost / entry   │ 1 embed call            │ 5-20 embed calls       │
│ Re-embed on edit cost   │ Always full entry       │ Always all chunks      │
│ Query latency           │ 365 cosines             │ ~3650 cosines          │
│ Precision (sub-entry)   │ Low                     │ High                   │
│ Recall (entry-level)    │ High                    │ Same (needs rollup)    │
│ Cross-chunk reference   │ N/A                     │ Real risk              │
│ Implementation effort   │ ~20 LOC                 │ ~100 LOC + boundary    │
│                         │                         │ logic                  │
└─────────────────────────┴─────────────────────────┴────────────────────────┘
```

### Sub-block 1 — what whole-entry gives up

Sub-entry precision. If a user writes a 1500-word entry covering three topics, the entry's vector is the centroid of all three — and a query about any one of them ranks the entry lower than it would if that topic had its own vector. For loopd's typical short-to-medium entries this matters little; for long-form entries (rare today) it can drop a relevant entry out of top-5.

### Sub-block 2 — what sentence-window would have cost

5-20× more vectors, 5-20× more embed calls per entry, ~5-20× more storage, and the cross-chunk reference problem (chunks containing "it was great" with no antecedent). Implementation roughly doubles: chunk-boundary detection, per-chunk persistence, and rollup logic at query time to merge multi-hit-per-entry results into one ranked list. For loopd's solo scale the storage and cost are still negligible, but the implementation complexity is real.

### Sub-block 3 — the breakpoint
Whole-entry stops being the right call when (a) the eval shows hit@5 below target on real query patterns, (b) entries grow consistently past ~2000 words (loopd's average is <500), or (c) users start asking sub-entry questions ("what was the paragraph about my knee" rather than "the entry about my knee").

### What wasn't actually a tradeoff
Token-level embedding (1 vector per token) is not a real option. The point of embedding is *compression* of meaning; per-token vectors defeat it.

---

## Tech reference (industry pairing)

### Custom JS chunker (current plan)

- **Codebase uses:** target plan — a small `chunkEntry()` function in `src/services/ai/embed.ts` that returns either `[entry.text]` (whole-entry) or a sentence-window split based on a config flag.
- **Why it's here:** loopd's chunking decision is small and binary today; a custom 20-LOC function is the right size.
- **Leading today:** custom chunkers — `adoption-leading` for small codebases, 2026.
- **Why it leads:** zero dependencies, easy to reason about, fits into existing service-layer pattern. LangChain's text splitters are overkill for this scope.
- **Runner-up:** LangChain `RecursiveCharacterTextSplitter` — `innovation-leading` for multi-format corpora; powerful but adds a dependency loopd doesn't otherwise need.

### Semantic Chunker (LlamaIndex)

- **Codebase uses:** not used.
- **Why it's here:** the boundary-detection alternative — uses an embedding-similarity check between adjacent paragraphs to find natural topic shifts.
- **Leading today:** LlamaIndex `SemanticSplitterNodeParser` — `innovation-leading` for chunking quality, 2026.
- **Why it leads:** topic-aware boundaries, doesn't over-fragment single thoughts split by accidental newlines.
- **Runner-up:** rule-based paragraph splitter — `adoption-leading` for simplicity; LlamaIndex's semantic splitter outperforms but costs an extra embed call per boundary check.

---

## Project exercises

### [B2A.5] Chunking decision: per-entry whole-text first; sentence-window only if eval shows recall miss

- **Exercise ID:** `[B2A.5]`
- **What to build:** A small JS chunker function in `src/services/ai/embed.ts` that defaults to whole-entry. Run `[B2A.9]`'s eval set against the whole-entry approach first. If hit@5 falls below 0.7, swap to sentence-window with 3-sentence chunks, 1-sentence overlap. Document the decision and the eval numbers in `loopd/.aipe/specs/features/rag-personal-corpus.md`.
- **Why it earns its place:** the chunking choice is the second-most-expensive-to-reverse decision in Phase 2A (after model choice). Eval-driven picking turns a guess into a measurement.
- **Files to touch:** new `src/services/ai/embed.ts` with `chunkEntry()`; `loopd/.aipe/specs/features/rag-personal-corpus.md` (decision section).
- **Done when:** the chunker function exists; whole-entry results pass the eval threshold OR sentence-window has been tried and documented as the winner with eval numbers.
- **Estimated effort:** `1–4hr` for whole-entry; `1–2 days` if sentence-window becomes necessary.

---

## Summary

Chunking is the decision about how to slice documents before embedding them — and the strategy you pick sets the unit of retrieval for every query that ever runs. In loopd this is not yet implemented; the curriculum's plan (`[B2A.5]`) is whole-entry first, with sentence-window as a fallback only if the eval shows recall miss. The constraint that makes whole-entry the right starting call is loopd's entry length (typically short-to-medium) and expected query patterns ("find an entry about X" rather than "find a paragraph about X"). The cost being paid is sub-entry precision: a long entry covering three topics will rank lower for any single-topic query than it would with chunking.

Key points to remember:
- Whole-document chunking is correct when the retrieval unit matches the consumption unit.
- Sentence-window has higher precision but 5-20× storage and a real cross-chunk reference problem.
- Chunking is an empirical decision — eval first, theorise later.
- Smaller chunks = more precision, more storage, more vectors to search.
- For loopd, hit@5 on the `[B2A.9]` eval set is the deciding number.

---

## Interview defense

### What an interviewer is really asking
"How did you chunk?" tests whether the candidate picked by reputation ("everyone uses sentence-window") or by eval. The follow-up — "why not chunk more?" — tests whether they understand the precision/storage trade.

### Likely questions

  [mid] Q: How are loopd's entries chunked?
  A: Whole-entry — one vector per `entries.text`, regardless of length. The reason is that loopd's expected retrieval patterns are entry-level ("find an entry about X"), not paragraph-level, and the typical entry is short enough that the topic-averaging penalty of whole-document chunking is minimal. If the `[B2A.9]` eval shows hit@5 dropping below 0.7, the fallback is sentence-window with 3-sentence chunks and 1-sentence overlap.
  Diagram:
  ```
  entry.text (~500 words, 1 topic)
        │
        ▼  embed(entry.text)
  1 vector → entry_embeddings
  ```

  [senior] Q: Why didn't you sentence-window from the start?
  A: Three reasons. First, the retrieval unit matches the consumption unit — users look up "the entry where I talked about X" not "the sentence." Second, sentence-window adds the cross-chunk reference problem ("it was great" with no antecedent), and loopd's prose style has lots of pronoun-heavy short sentences that would suffer. Third, sentence-window is 5-20× the storage and 5-20× the indexing cost. At solo scale these are pennies, but the engineering complexity (chunk-boundary logic, query-time rollup) is real and unjustified unless the eval shows a recall miss. The plan is eval-first: ship whole-entry, run `[B2A.9]`, if hit@5 < 0.7 then sentence-window.
  Diagram:
  ```
  Picked: whole-entry              Suggested: sentence-window
  ─────────────────                ─────────────────────────
  1 vec per entry                  5-20 vecs per entry
  ~2 MB / 365 entries              ~10-40 MB / 365 entries
  Centroid topic risk              Cross-chunk ref risk
  Right at solo + short entries    Right at long-form prose
  ```

  [arch] Q: What changes at 10× corpus or 10× entry length?
  A: At 10× corpus (~3650 entries), the storage and query-cost numbers grow linearly but stay small at whole-entry. At 10× entry length (average 5000+ words), the centroid problem starts dominating retrieval quality — three topics in one entry get averaged into a vector that ranks below entries with one focused topic. The fix is hierarchical chunking: whole-entry vector for "find the entry," plus per-paragraph vectors that you only consult if the user drills in. That keeps default queries fast while adding sub-entry precision on demand.
  Diagram:
  ```
  ┌─ Today: whole-entry only ──────────┐
  │ 1 vec → entry_embeddings           │  ← averaging breaks at 10× length
  └────────────────────────────────────┘
              │ at long-form scale
              ▼
  ┌─ Hierarchical (future) ────────────┐
  │ 1 vec → entry_embeddings (default) │
  │ + N vecs → paragraph_embeddings    │
  │   (consulted only on drill-in)     │
  └────────────────────────────────────┘
  ```

### The question candidates always dodge
"How do you handle entries that get edited after embedding?" This is the stale-embedding problem ([32-stale-embeddings](./32-stale-embeddings.md)). For whole-entry, the answer is simple: mark `embedding_stale_at` on text edit, re-embed on idle pass. For sentence-window, the answer is much harder: an edit to one sentence invalidates the chunks that contained it, and chunk boundaries may have shifted, so the entire entry needs re-chunking-and-re-embedding. Sentence-window's edit overhead is one of the real reasons whole-entry is a better default for a journaling app where editing is common.

```
Picked: whole-entry              Suggested: sentence-window
─────────────────────             ─────────────────────────
Edit → re-embed 1 vec             Edit → re-chunk + re-embed N vecs
~1 embed call                     ~5-20 embed calls
Idle pass simple                  Idle pass complex
Right for editable corpora        Right for static corpora
```

### One-line anchors
- The retrieval unit should match the consumption unit.
- Whole-entry trades precision for simplicity.
- Sentence-window trades simplicity for precision (and adds cross-chunk reference risk).
- Chunking is empirical — eval first, decide second.
- Editable corpora favour whole-entry. Static corpora favour smaller chunks.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close the file and draw the three chunking strategies side-by-side: whole-document, sentence-window, semantic chunking. Label vectors-per-entry, storage cost, and precision for each.

### Level 2 — Explain it out loud
In under 90 seconds, explain: (a) why chunking exists, (b) the trade between precision and storage, (c) why loopd starts with whole-entry, (d) the cross-chunk reference problem.

### Level 3 — Apply it to a new scenario
A loopd user starts writing 5000-word weekly retrospectives once a week. The 365-entry corpus now contains 52 mega-entries among ~300 normal ones. Without looking, predict what happens to retrieval quality and propose one mitigation.

Open the Tradeoffs comparison and check whether your mitigation matches the long-form-entry breakpoint named there.

### Level 4 — Defend the decision you'd change
Today the plan is whole-entry first, sentence-window if eval fails. If you were starting today, would you ship both and let the user toggle between them? Defend your answer naming one specific failure mode each choice creates.

### Quick check — code reference test
- What function would do the chunking?
- What table holds the resulting vectors?

Answer: `chunkEntry()` in `src/services/ai/embed.ts` (target, not yet created). `entry_embeddings` (target, `[B2A.2]`).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (long-letter-through-mail-slot scenario, name the how-much-per-vector question, planned chunkEntry/entry_embeddings stakes, before/after, single-line metaphor).
