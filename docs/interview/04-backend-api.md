# 04 — Backend and API design

> **There's no traditional backend.** Cloud is Supabase Postgres acting as a sync mirror. Local SQLite stays canonical (Architectural Principle 12). Everything that looks like backend logic is in `src/services/sync/` and runs on-device.

When the interviewer asks about the backend, the temptation is to apologize for not having one. Don't. The decision to be local-first with Supabase as a sync mirror is the architectural call, and it has to be defended on its merits. There's no auth code yet (Phase A is single-user; Phase B flips on Supabase Auth + RLS). There's no API gateway in the conventional sense — the client talks directly to Postgres via supabase-js. What I do have is a real sync layer: bidirectional push/pull with last-write-wins by `updated_at`, soft-delete propagation, paginated incremental pulls with server-clock anchoring, debounced edit-push, and a bootstrap flow that decides between initial-push and first-pull on a fresh device.

The previous version of this app synced to Notion. That whole layer was deleted in commit `dc8483a` once Supabase was stable — about 2,200 lines of mappers / rate-limiter / outbox-queue code that just went away. The migration was a 7-milestone plan in [`docs/loopd-cloud-sync-plan.md`](../loopd-cloud-sync-plan.md); the design doc is [`docs/loopd-cloud-sync-spec.md`](../loopd-cloud-sync-spec.md). The patterns I'm using — incremental pull by `updated_at`, soft delete via `deleted_at`, server-clock-anchored cursors via a `get_server_time()` RPC, last-write-wins conflict resolution — are textbook distributed-systems primitives applied at small scale.

```
              Supabase push/pull with debounced edits

  Local SQLite                                      Supabase Postgres
       │                                                    │
       │  PUSH — fires on writes (debounced 5s) AND on boot │
       │                                                    │
       │  schedulePush() coalesces a burst of edits         │
       │   into one pushAll() call. Per-table:              │
       │                                                    │
       │   1. SELECT * FROM <t> WHERE                       │
       │      synced_at IS NULL OR                          │
       │      updated_at > synced_at                        │
       │                                                    │
       │   2. batch upsert (50/batch):                      │
       │      INSERT … ON CONFLICT (user_id, id)            │
       │      DO UPDATE                                     │
       │   ────► HTTPS POST /rest/v1/<table> ──────────────►│
       │                                                    │
       │   3. stamp synced_at on each row                   │
       │                                                    │
       │  Push order respects FK intent:                    │
       │   entries → projects → day_meta → vlogs →          │
       │   ai_summaries → todo_meta → nutrition →           │
       │   habits → threads → thread_mentions               │
       │                                                    │
       │                                                    │
       │  PULL — fires on boot. Incremental.                │
       │                                                    │
       │   1. RPC get_server_time() ──────────────────────►│
       │      ◄───────────────────────── server_time string │
       │                                                    │
       │   2. per-table:                                    │
       │      SELECT * FROM <t>                             │
       │      WHERE updated_at > sync_meta.last_pull_at     │
       │      ORDER BY updated_at ASC                       │
       │      LIMIT 200                                     │
       │   ────► HTTPS GET /rest/v1/<table>?…──────────────►│
       │      ◄───────────────────────────────── rows[]     │
       │                                                    │
       │   3. per row: chooseWinner(local, cloud)           │
       │      by updated_at; cloud or tie → upsert local    │
       │      + stamp synced_at (suppress repush)           │
       │                                                    │
       │   4. sync_meta.last_pull_at = server_time          │
       │                                                    │
       │  Pull order — habits + threads BEFORE              │
       │   todo_meta / nutrition / thread_mentions          │
       │   so child rows land after their parents exist     │
       │                                                    │
       │                                                    │
       │  SOFT DELETE — every CRUD delete in database.ts    │
       │   stamps deleted_at = NOW(), bumps updated_at.     │
       │   Reads filter WHERE deleted_at IS NULL.           │
       │   Push propagates the deletion as a normal row.    │
       │   Pull lands deleted_at on local; reads hide it.   │
       │   30-day vacuum (deferred — see backlog) hard-     │
       │   deletes once the soft window closes.             │
       │                                                    │
       │                                                    │
       │  BOOTSTRAP — runs once on first cold start         │
       │   after the feature shipped. Detects:              │
       │     local empty + cloud empty → no-op              │
       │     local has data + cloud empty → initial-push    │
       │     local empty + cloud has data → first-pull      │
       │     both → fallback to initial-push                │
       │   Gated by SecureStore flag cloud_initial_push_done│
```

## Interview questions

### Q1 [mid] What happens if the network dies mid-push?

The push function at [`sync/push.ts`](../../src/services/sync/push.ts) batches 50 rows per upsert call. On error, the failed batch's rows don't get their `synced_at` stamped — the next push picks them up automatically because the dirty-query is `WHERE synced_at IS NULL OR updated_at > synced_at`. The whole operation is idempotent: re-pushing the same row is `ON CONFLICT (user_id, id) DO UPDATE`, which produces the same final state.

The local SQLite write happened first, and `schedulePush()` only fires 5s after the last write — so if the user is mid-typing when the network dies, the bytes were durable from keystroke one (Architectural Principle 3) and the push retry waits for the typing to settle. There's no half-written state.

For deletes, the soft-delete approach makes this even cleaner than the old Notion outbox-queue model: a deletion is just a row update with `deleted_at` set. It pushes through the same path as any other change. If the push fails, the local row still has `updated_at > synced_at` and the next push retries. No separate queue, no archive operation, no `entity_type` discriminator — just one column.

The error is recorded in `sync_meta.last_error` per table (see [`sync/syncMeta.ts`](../../src/services/sync/syncMeta.ts)), surfaced in the Cloud Sync settings page so the user can see what's stuck.

### Q2 [senior] How does conflict resolution work? Walk me through a concurrent edit.

Last-write-wins by `updated_at`, per row, in [`sync/conflict.ts`](../../src/services/sync/conflict.ts). The function is a pure `chooseWinner(local, cloud)` returning `'local' | 'cloud' | 'tie'`. I picked the simplest correct semantics for solo use; CRDT-grade per-field merging is overkill.

Concrete trace. Device A edits entry `e123` at `T=100ms`, sets `updated_at = 100`. Device A pushes; Supabase row gets `updated_at = 100`. Device B edited the same entry at `T=80ms` while offline — local has `updated_at = 80`. Device B comes online, pulls. The pull query returns the cloud row (its `updated_at = 100` > `last_pull_at`). Pull calls `chooseWinner(local: {updated_at: 80}, cloud: {updated_at: 100})` → `'cloud'`. Local row gets overwritten with cloud's data; Device B's offline edit is lost.

That last-edit-loss is honest about its limit. The plan at [`docs/loopd-cloud-sync-spec.md`](../loopd-cloud-sync-spec.md) §4.6 names the cases this resolves cleanly (concurrent edits across devices, soft-delete-vs-edit, offline-comes-online) and the cases it doesn't (same-second ties, true concurrent edits to the same prose). Solo use doesn't hit the unresolved cases. Phase B (multi-user) would need vector clocks or CRDTs for prose; the two-pass-matching pattern in the scanners is a sane substrate for either.

The clock-skew bug is sidestepped via the `get_server_time()` RPC (see [`supabase/migrations/0003_server_time_rpc.sql`](../../supabase/migrations/0003_server_time_rpc.sql)). `last_pull_at` is the server's `NOW()`, not the device's. So if Device B's clock is 30s ahead of the server, the next pull doesn't accidentally skip rows that the server stamped at `server_now - 10s`.

### Q3 [arch] How would you switch from polling to realtime push from Supabase?

Supabase has Postgres LISTEN/NOTIFY exposed as Realtime channels. Today loopd polls — boot does `pullAll()` once, edits do nothing on the pull side. To go push-driven, I'd add a Supabase Realtime subscription per synced table, subscribed to row updates filtered by `user_id = $userId`. When a NOTIFY fires, the client calls `pullTable(t)` for the affected table — same code path as the boot pull, just triggered by a wakeup signal instead of a timer.

**The architectural insight here**: the cleanest reactive system makes pull idempotent and uses push only as a wakeup signal, not a data delivery mechanism. A missed wakeup is recoverable on next poll. A reordered notification doesn't matter because the pull resolves to the latest server state regardless. The system degrades to polling cleanly when realtime is unavailable.

I haven't built it because solo Phase A only needs sync on boot — there's only one device. The infrastructure is in place though: `pullAll()` is already idempotent, `chooseWinner` already handles out-of-order arrivals, `sync_meta.last_pull_at` already advances monotonically. Wiring up the Realtime channel is ~50 lines of code. The reason to do it is when Phase B users have multiple devices and want sub-second cross-device updates instead of waiting until the next app foreground.

What I'd watch for: WebSocket reconnect storms when many devices wake up at once (Supabase Realtime has connection limits per project). Mitigation: jittered reconnect backoff client-side, plus the existing 5s push debounce to coalesce wake-up-induced re-pulls.

### Q4 [senior] You auto-create a thread when a user types `#unknown` in prose. Defend that.

Honest answer: it's a deviation from the stricter "explicit-only" model the spec originally proposed, and I made the call deliberately at [`scanThreads.ts`](../../src/services/threads/scanThreads.ts).

The tradeoff: explicit-only is typo-safe (`#loop` doesn't accidentally fork a new thread from `#loopd`) but high-friction (every new tag requires a confirm). Auto-create is ergonomic (you just type) but typo-prone. I chose auto-create because the inline `+ create #xyz` chip in the autocomplete already exists — that's the immediate-feedback path — and the scanner-side auto-create is the **fallback** for prose typed past the popover, on the `/todos` page where there's no autocomplete, or when fast-typing skips the chip entirely.

Risk mitigation: code-span masking (`` `git #branch` `` is stripped before regex) prevents accidental tag creation from quoted text. Per-line per-slug deduplication prevents `#loopd #loopd` from doubling up. And the threads CRUD page lets the user merge or hard-delete typo'd threads — recovery exists.

The cloud-sync angle: thread auto-create runs locally first, then pushes via the standard sync path. The Postgres unique index `idx_threads_user_slug` on `(user_id, LOWER(slug))` catches a real race — if two devices type `#family` simultaneously, one push wins and the other gets a constraint violation. Local sees the violation in `sync_meta.last_error` for `threads`. Phase B would need CRDT-level slug coordination; Phase A solo never hits the race.

If this app shipped to a wider audience I'd reconsider. For solo-dev daily use, the friction cost of explicit-only outweighs the cleanup cost of the occasional `#loop` → `#loopd` typo. The deviation from the original "explicit-only" design is documented inline above the auto-create branch so future-me knows it was intentional.

## The hard question

> "What's the security model? You have no auth and tokens in plain text on a phone."

Tokens aren't in plain text. API keys live in `expo-secure-store` which on Android maps to the Android Keystore (hardware-backed when available). The Anthropic API key, the OpenAI API key, the Supabase anon key — all encrypted at rest by the OS, not by me.

The Supabase anon key is *meant* to be on the client — that's its purpose. It's not a secret; it's a public identifier that says "I'm a Supabase client trying to reach this project." The actual access control is supposed to be RLS (row-level security), and that's where Phase A is honest about its limitation: **RLS is currently disabled**. Every policy is authored in [`supabase/migrations/0002_rls_policies.sql`](../../supabase/migrations/0002_rls_policies.sql) — `auth.uid() = user_id` for all-rows on every table — but the migration ends with `ALTER TABLE … DISABLE ROW LEVEL SECURITY`. Phase A is single-user with a hardcoded dummy `user_id`; flipping RLS on without auth would lock the app out of its own data.

So the actual Phase A security model is: "I'm the only user, I control the device, I control the Supabase project, the anon key is public-by-design, my AI keys live in the OS keychain." That's appropriate for what this is. **Phase B flips three things at once**: auth (Supabase Auth with email magic link or OAuth), RLS (just enable on every table — policies already authored), and per-user encryption-at-rest if data sensitivity requires it (the OS full-disk encryption is the current line of defense, fine for personal use, not enough for paid users with stricter compliance needs).

The honest framing is that the security model is "single-user, local-first, OS-provided secret storage, RLS scaffolded but off." I know what changes at multi-user scale and the order to ship them in. I don't have them today because today they'd be theater.

→ [05 — AI engineering](./05-ai-engineering.md)
