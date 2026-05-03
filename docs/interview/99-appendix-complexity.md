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
| `pushTable<T>(table)` (Supabase) | O(d) batches of 50 | O(d) | Fine to ~10k dirty rows per push | Generic batched upsert via `ON CONFLICT (user_id, id) DO UPDATE`; stamps `synced_at` on success |
| `pullTable<T>(table)` (Supabase) | O(p × 200) paginated by `updated_at ASC`; *p* = pages | O(page) | Fine to ~10k changes since last pull | Calls `get_server_time()` RPC once per pull for clock-skew-safe `last_pull_at` |
| `pushAll()` orchestrator | O(t × push) where *t* = synced tables (10) | O(d) | Acceptable to ~10k total dirty rows | Walks registry in `pushOrder` (FK-aware: parents before children) |
| `pullAll()` orchestrator | O(t × pull) | O(page) | Fine | Walks registry in `pullOrder` (different from push: habits/threads before todo_meta/nutrition) |
| `firstPullAll()` (recovery) | O(N + T + Mn) full restore | O(page) | Bounded by total cloud rows | Resets `sync_meta` then runs `pullAll()` from epoch — fresh-device path |
| `chooseWinner(local, cloud)` | O(1) timestamp compare | O(1) | Fine | Pure function — last-write-wins by `updated_at` |
| `schedulePush()` | O(1) timer reset | O(1) | Fine | 5s debounce; coalesces a burst of edits into one `pushAll()` |
| `classifyTodo(text)` | 1 LLM call (~1-3s) | O(1) | Cost-bounded | Module-level in-flight counter |
| `expandTodo(id, text)` | 1-2 LLM calls (~5-15s) | O(1) | Bounded by `MAX_CONCURRENT=3` | Auto-retry once on malformed JSON |
| `backfillTodoMeta()` | O(N × T_avg) | O(1) | One-time per install | SecureStore-gated |
| `backfillThreadMentions()` | O(N + T) — walk every entry + todo and re-scan tags | O(1) per iter | One-time per install (lazy) | SecureStore-gated; short-circuits if zero threads exist (re-checks on next boot) |
| `classifyAmbiguousMeta()` | O(K × LLM) where K = unclassified | O(K) | Boot-time, fire-and-forget | Skips done-or-overridden rows |
| `getNutritionSuggestions(query)` | O(R) read + O(R) dedupe | O(D) where D = distinct names | Fine to ~5k nutrition rows | Could push DISTINCT to SQL |
| `getThreadSuggestions(query, limit)` | O(Th + Mn) for LEFT-JOIN aggregate; LIMIT N | O(N) | Fine to ~100 threads | Recency-sorted via `MAX(created_at)` per thread |
| Soft-delete cascade (e.g. `deleteEntry`) | O(1) entry + O(C) child rows where C = nutrition + todo_meta + thread_mentions for that entry | O(1) | Fine | All cascades are `UPDATE … SET deleted_at = ?` on already-indexed columns |
| Read-path filter (`WHERE deleted_at IS NULL`) | O(1) per query (uses partial index) | O(1) | Fine | Applied to every getter on every synced table |

## Where the cliffs are

Four places that break first under load, ranked by which would hurt the user soonest:

**`/todos` JS-side sort + filter.** At 5k+ todos starts to jank during scroll. Solution: virtualize the list (`FlashList`) and push sort/filter into a `useMemo` keyed only by inputs that affect them. Effort: half a day. Worth it: when you see jank in profiling, not before.

**Cloud sync at high dirty counts.** Push batches at 50 rows per upsert call; ~10k dirty rows = 200 batches × supabase-js round trip (~150ms typical) = ~30s of wall clock. Acceptable on cold-start initial-push but visible as a foreground freeze if it ever runs interactively. Solution: keep the 5s debounce honest (the existing `schedulePush()` already coalesces bursts), and at any larger scale move the push to a worker thread. Effort: worker thread is a day; better debouncing is already in. Worth it: worker thread when push starts blocking the UI.

**First reorder bulk write.** O(T) `updateTodoMeta` calls, each a SQL UPDATE. At 1000+ todos this is a noticeable pause when the user first taps the up arrow. Solution: wrap in a single SQLite transaction, or implement Linear-style sparse fractional indexing so positions never need bulk reassignment. Effort: transaction wrapper is an hour; fractional indexing is two-three days. Worth it: transaction wrapper yes, fractional indexing only if reorder becomes a hot operation.

**LLM expansion latency without streaming.** 5-15 seconds per call is fine UX-wise *with* a loading state, but if a user taps 10 expand buttons at once they see queueing behavior. Already handled by `MAX_CONCURRENT=3` cap, but a streaming response would feel snappier. Solution: stream the LLM response token-by-token into the modal. Effort: a day per provider (Anthropic and OpenAI have different stream shapes). Worth it: yes once expansion becomes a frequent operation; today it's manual-only and infrequent.

**Thread mention backfill on a heavy entries table.** Walking every entry + todo to scan for `#tag` matches is O(N + T) regex passes. At ~10k entries with averaged-50-line entries that's still single-digit seconds, but the lazy gate (skip when zero threads exist) means it doesn't run on fresh installs anyway. The cliff is users with thousands of pre-existing entries who create their first thread late — the backfill pause is briefly noticeable. Solution: chunk the backfill in 100-entry batches with `requestAnimationFrame` yields between chunks. Effort: half a day. Worth it: only for users with 1000+ entries.

**`getThreadCards()` aggregation.** Today it issues several distinct SQL aggregates and joins them in JS — fine when threads × mentions is small (current shape). At 100+ threads × 10k+ mentions, the LEFT JOIN-then-GROUP-BY for last-mention-per-thread becomes the dominant cost. Solution: cache the aggregate or push the entire dashboard query into a single SQL with derived tables. Effort: a day. Worth it: once dashboard load time exceeds 100ms in profiling.

## Where you should NOT optimize prematurely

Three places where the current implementation is correct as-is and reaching for optimization would be theater:

**Single-entry scan** is `O(L + E)` where both are typically <50. No optimization needed at any realistic scale.

**5-second push debounce** is correct as-is. Don't reach for adaptive backoff or token buckets until the cloud-sync layer has visible problems in production traffic.

**Heuristic classifier** is `O(L)` regex scan — already as cheap as it gets without sacrificing accuracy.

**`#tag` parser** is also `O(L)` per scan with a single regex pass and code-block masking. The auto-create path adds one INSERT per unknown slug per scan — bounded by the number of distinct unknown slugs (typically 0–1).

**`toggleThreadTouchToday`** is two SELECT-or-INSERT/DELETE queries, both indexed. The dashboard re-render after toggle costs more than the DB write.

## How to use this in an interview

When the interviewer asks "what's the complexity of X?" — answer in three parts: the Big-O, the constant-factor gotchas (JSON parsing, network latency, LLM latency), and whether it holds at the scale they care about.

When they ask "what would break first?" — point at one of the four cliffs above, name the threshold, name the fix, name the effort. Don't apologize for the gap; *frame it as a profile-driven priority*.

When they ask "what would you do at 100x scale?" — the answer is rarely "rewrite this." The answer is usually "push this hash-join to SQL," "stream the LLM response," "queue the writes." Knowing which lever to pull is the senior signature; reaching for "rewrite" is the junior trap.

← [back to README](./README.md)
