# 99 — Appendix: complexity cheat sheet

Per-operation Big-O for everything significant in loopd. Use this in coding-round-style questions where the interviewer asks "and what's the complexity of that?" or "where does this break at scale?"

*N* = total entries, *T* = total todos across all entries, *M* = total `todo_meta` rows (= *T*), *Th* = total threads, *Mn* = total `thread_mentions` rows.

| Operation | Time | Space | At scale | Notes |
|---|---|---|---|---|
| `getAllEntries()` | O(N) read + JSON parse | O(N) | OK to ~10k entries | Linear DB scan; JSON parse for `todos_json`/`clips_json` is the cost driver |
| `getEntriesByDate(date)` | O(log N + k) | O(k) | Fine | Uses `idx_entries_date` index; *k* = entries on that date |
| `/todos` flat-list build | O(T + M) join + O(T log T) sort | O(T) | Push to SQL at 5k+ todos | JS-side hash join via `metas: Map`, then comparator sort |
| `updateEntry()` | O(1) DB write | O(1) | Fine | Single row UPDATE |
| `deleteEntry()` | O(1) + 2 cascade DELETEs | O(1) | Fine | Cascades to `todo_meta` + `nutrition` for that entry |
| `moveTodoUp/Down()` | O(T) on first reorder, O(1) thereafter | O(1) | OK to ~1000 todos | First call runs `ensureAllTodoPositions` (O(T) bulk write) |
| `scanTodosFromText(text, existing)` | O(L + E) | O(L + E) | Fine | *L* = lines in text, *E* = existing todos for entry |
| `reconcileTodoMetaForEntry(entry)` | O(T_e + M_e) | O(M_e) | Fine | Per-entry counts (single digits typical) |
| `parseTags(text)` | O(L) regex pass + O(L) code-mask | O(matches) | Fine | Multi-line code-block masking is the cost driver |
| `scanThreadsForEntry(...)` | O(parsedTags + Th + existingMentions) | O(parsedTags) | Fine | Two-pass reconcile per entry; per-todo runs separately |
| `resolveTagsToThreadIds(parsed)` | O(parsed × log Th) for slug lookup; auto-create on miss = O(insert) | O(parsed) | Fine | Auto-create can race; recovers via `slug-taken` re-fetch |
| `getThreadCards(now)` | O(Th × Mn) for last-mention map + O(Th log Th) sort | O(Th + Mn) | Fine to ~100 threads, ~10k mentions | Single SQL aggregate per query type; in-memory join afterwards |
| `getThreadDetail(threadId)` | O(Mn_t + N + T) (per-thread mentions + global entries/metas) | O(Mn_t + T) | Fine to ~100 threads, ~10k todos | Cap at 1000 mentions per query |
| `toggleThreadTouchToday(...)` | O(1) read + O(1) insert OR delete | O(1) | Fine | Single-row idempotent toggle |
| `pullTodos(notion)` | O(P + T) where P = Notion pages | O(P) | Fine; bounded by Notion API page size | Builds `byLoopdId` Map first |
| `pushTodos(notion, dirty)` | O(d × 350ms) where d = dirty rows | O(d) | Bounded by rate limit | One Notion API call per dirty row, serialized |
| `pullHabits(notion)` | O(P) | O(P) | Fine; usually small (~10–50 habits) | Slug-rejected-on-pull adds a log warning per rejected diff |
| `pushHabits(notion, dirty)` | O(d × 350ms) | O(d) | Fine | Habits CRUD is low-frequency |
| `pullThreads(notion)` | O(P) | O(P) | Fine; usually small (~10–50 threads) | Slug also rejected on pull here |
| `pushThreads(notion, dirty)` | O(d × 350ms) | O(d) | Fine | Threads CRUD is low-frequency |
| `classifyTodo(text)` | 1 LLM call (~1-3s) | O(1) | Cost-bounded | Module-level in-flight counter |
| `expandTodo(id, text)` | 1-2 LLM calls (~5-15s) | O(1) | Bounded by `MAX_CONCURRENT=3` | Auto-retry once on malformed JSON |
| `backfillTodoMeta()` | O(N × T_avg) | O(1) | One-time per install | SecureStore-gated |
| `backfillThreadMentions()` | O(N + T) — walk every entry + todo and re-scan tags | O(1) per iter | One-time per install (lazy) | SecureStore-gated; short-circuits if zero threads exist (re-checks on next boot) |
| `classifyAmbiguousMeta()` | O(K × LLM) where K = unclassified | O(K) | Boot-time, fire-and-forget | Skips done-or-overridden rows |
| `getNutritionSuggestions(query)` | O(R) read + O(R) dedupe | O(D) where D = distinct names | Fine to ~5k nutrition rows | Could push DISTINCT to SQL |
| `getThreadSuggestions(query, limit)` | O(Th + Mn) for LEFT-JOIN aggregate; LIMIT N | O(N) | Fine to ~100 threads | Recency-sorted via `MAX(created_at)` per thread |
| `processDeletions(token, type)` | O(d × 350ms) | O(d) | Bounded by rate limit | FIFO drain of `sync_deletions` (now 5 entity types) |
| Notion sync overall (4-stage chain) | O(rate-limit × total-dirty) | O(d) | Acceptable up to ~1000 dirty rows total | `syncAll → syncAllTodos → syncAllHabits → syncAllThreads`; later stages no-op when their DB ID isn't set |

## Where the cliffs are

Four places that break first under load, ranked by which would hurt the user soonest:

**`/todos` JS-side sort + filter.** At 5k+ todos starts to jank during scroll. Solution: virtualize the list (`FlashList`) and push sort/filter into a `useMemo` keyed only by inputs that affect them. Effort: half a day. Worth it: when you see jank in profiling, not before.

**Notion sync at high dirty counts.** At >1000 dirty rows per sync, 350ms × 1000 = 5+ minutes of serial pushes. Solution: batch where Notion supports it (it doesn't for individual page creates), or accept the wall-clock cost with a progress UI. Effort: progress UI is half a day; true batching requires Notion API changes I don't control. Worth it: progress UI yes, batching wait-and-see.

**First reorder bulk write.** O(T) `updateTodoMeta` calls, each a SQL UPDATE. At 1000+ todos this is a noticeable pause when the user first taps the up arrow. Solution: wrap in a single SQLite transaction, or implement Linear-style sparse fractional indexing so positions never need bulk reassignment. Effort: transaction wrapper is an hour; fractional indexing is two-three days. Worth it: transaction wrapper yes, fractional indexing only if reorder becomes a hot operation.

**LLM expansion latency without streaming.** 5-15 seconds per call is fine UX-wise *with* a loading state, but if a user taps 10 expand buttons at once they see queueing behavior. Already handled by `MAX_CONCURRENT=3` cap, but a streaming response would feel snappier. Solution: stream the LLM response token-by-token into the modal. Effort: a day per provider (Anthropic and OpenAI have different stream shapes). Worth it: yes once expansion becomes a frequent operation; today it's manual-only and infrequent.

**Thread mention backfill on a heavy entries table.** Walking every entry + todo to scan for `#tag` matches is O(N + T) regex passes. At ~10k entries with averaged-50-line entries that's still single-digit seconds, but the lazy gate (skip when zero threads exist) means it doesn't run on fresh installs anyway. The cliff is users with thousands of pre-existing entries who create their first thread late — the backfill pause is briefly noticeable. Solution: chunk the backfill in 100-entry batches with `requestAnimationFrame` yields between chunks. Effort: half a day. Worth it: only for users with 1000+ entries.

**`getThreadCards()` aggregation.** Today it issues several distinct SQL aggregates and joins them in JS — fine when threads × mentions is small (current shape). At 100+ threads × 10k+ mentions, the LEFT JOIN-then-GROUP-BY for last-mention-per-thread becomes the dominant cost. Solution: cache the aggregate or push the entire dashboard query into a single SQL with derived tables. Effort: a day. Worth it: once dashboard load time exceeds 100ms in profiling.

## Where you should NOT optimize prematurely

Three places where the current implementation is correct as-is and reaching for optimization would be theater:

**Single-entry scan** is `O(L + E)` where both are typically <50. No optimization needed at any realistic scale.

**Module-level rate limiter** is correct as-is. Don't reach for token buckets until you have multiple workers.

**Heuristic classifier** is `O(L)` regex scan — already as cheap as it gets without sacrificing accuracy.

**`#tag` parser** is also `O(L)` per scan with a single regex pass and code-block masking. The auto-create path adds one INSERT per unknown slug per scan — bounded by the number of distinct unknown slugs (typically 0–1).

**`toggleThreadTouchToday`** is two SELECT-or-INSERT/DELETE queries, both indexed. The dashboard re-render after toggle costs more than the DB write.

## How to use this in an interview

When the interviewer asks "what's the complexity of X?" — answer in three parts: the Big-O, the constant-factor gotchas (JSON parsing, network latency, LLM latency), and whether it holds at the scale they care about.

When they ask "what would break first?" — point at one of the four cliffs above, name the threshold, name the fix, name the effort. Don't apologize for the gap; *frame it as a profile-driven priority*.

When they ask "what would you do at 100x scale?" — the answer is rarely "rewrite this." The answer is usually "push this hash-join to SQL," "stream the LLM response," "queue the writes." Knowing which lever to pull is the senior signature; reaching for "rewrite" is the junior trap.

← [back to README](./README.md)
