# 04 — Backend and API design

> **There's no real backend.** That's the first thing to say. Everything that looks like backend logic is in `src/services/` and runs on-device. The only network dependency is the Notion REST API.

When the interviewer asks about the backend, the temptation is to apologize for not having one. Don't. The decision to be local-first with optional cloud sync is the architectural call, and I should defend it on its merits. There's no auth layer because there are no other users. There's no database because there's only one device. There's no scaling concern because the system is single-user. What I do have is real sync logic — bidirectional Notion sync with field-level merge rules, a sync-deletion outbox queue, schema-gap tolerance for users running older Notion DB versions, and a module-level rate limiter that serializes every Notion call across all features.

The Notion sync is the most interesting "backend" concern in the codebase. It's bidirectional, it handles partial schema, it survives network failures, and it's correct in the face of clock skew between devices. None of that is template code. The patterns I'm using here — outbox queues, tolerant readers, last-edit-wins per-field merges — are textbook distributed-systems primitives applied at small scale. As of 2026-04-29 the same patterns extend to two more optional DBs (Habits, Threads), each behind their own DB-ID gate, each silently no-op when unset.

```
       Notion sync push/pull with rate limit + deletion queue

  Local SQLite                                  api.notion.com
       │                                              │
       │   ┌──────────────────────────────┐           │
       │   │  rate-limit() — 350ms gap    │           │
       │   │  module-level lastRequestTime│           │
       │   └──────────────┬───────────────┘           │
       │                  │                           │
       │  PUSH: dirty rows (updated_at > lastSync)    │
       ├──► entries ────┐                             │
       │                ├─► HTTPS PATCH ─────────────►│
       ├──► todos ──────┤                             │
       │                │                             │
       ├──► nutrition ──┤                             │
       │                │                             │
       ├──► habits *────┤   (* optional — gated on    │
       │                │      HABITS_DB_ID)          │
       │                │                             │
       ├──► threads *───┘   (* optional — gated on    │
       │                       THREADS_DB_ID;         │
       │                       mentions NOT synced)   │
       │                                              │
       │  PUSH: deletions (FIFO drain of queue)       │
       │   ┌─────────────────────────┐                │
       └──►│ sync_deletions          │── archivePage ►│
           │ entity_type discriminator                │
           │ ('entry'|'todo'|'habit' │                │
           │  |'nutrition'|'thread') │                │
           └─────────────────────────┘                │
                                                      │
                                                      │
       PULL ────────────────────────────────────────  │
       │                                              │
       │ queryDatabase (last 14 days)                 │
       │◄────────────────── pages[] ──────────────────┤
       │                                              │
       │ field-level merge per spec §11.2:           │
       │   text     → prose-canonical (drop)          │
       │   done     → bidirectional (last-edit-wins)  │
       │   type     → pull AND set userOverridden=1   │
       │   expanded → pull only when local empty      │
       │   slug     → REJECTED on pull (log warn) ── ◄┤  threads/habits
       │                                              │
       ▼
  Update todos_json + todo_meta in single tx

  Boot-time auto-sync chain (auto-sync ON only):
    syncAll → syncAllTodos → syncAllHabits → syncAllThreads

  On 429: Retry-After header → exponential backoff
  On schema gap: detect{Todo,Habit,Thread}MissingProperties
                 skips absent fields silently (tolerant reader)
```

## Interview questions

### Q1 [mid] What happens if the Notion API call fails mid-write?

The Notion API at [`notion/api.ts`](../../src/services/notion/api.ts) has three reliability layers. The rate limiter at lines 7-16 enforces a module-level 350ms gap between every request, regardless of which feature triggered it — this is shared state across `syncAll`, `syncAllTodos`, `syncAllHabits`, `syncAllThreads`, every individual call. We don't trip Notion's 3-req/s ceiling ourselves. On 429 (rate-limited) responses, the client respects the `Retry-After` header and waits before retrying.

If the network dies mid-push, the local SQLite is already authoritative and the row's `updated_at` is in the future relative to `lastSync`. Next sync, the dirty-row push picks the row up and tries again. The whole pattern is idempotent because the dedup key is loopd-side `loopd ID`, not the Notion page ID — Notion will never have duplicate pages from a re-pushed create.

For deletes, the [`sync_deletions`](../../src/services/database.ts) table holds pending archive ops keyed by `notion_page_id`, with `entity_type` now discriminating across `entry | todo | habit | nutrition | thread`. The local row is already gone, but the queue retains enough information to issue the archive on next sync. This is the textbook *Transactional Outbox* pattern — durable record of intent that survives local crashes and network failures.

### Q2 [senior] Why does editing a thread's slug in Notion get silently dropped on pull?

This is the slug-rejected-on-pull rule, and it's the most opinionated decision in the sync code. The slug is the matching key for `#tag` mentions — every row in `thread_mentions` was reconciled against `threads.slug` at scan time. If I let a Notion edit rename `loopd` → `loopd-app`, every existing mention immediately points at a phantom slug, and the next entry scan would either auto-create a NEW thread for `#loopd` (now unknown) or orphan the old one.

So [`notion/threadsMapper.ts`](../../src/services/notion/threadsMapper.ts) and [`notion/habitsMapper.ts`](../../src/services/notion/habitsMapper.ts) treat `slug` as **local-canonical**: pulled values are compared, and if they differ from the local slug, the pull is dropped with a `console.warn`. Slug renames must happen via the loopd CRUD — which can do them safely because the same transaction can re-reconcile mentions, or simply hold the line that slug renames are not a supported user op.

The general principle: **bidirectional sync requires a clear canonical-side per field, and the canonical side is whoever owns the invariants downstream of that field.** Notion owns display data (name, color, icon, target cadence). loopd owns identity (slug, IDs). Mentions are the third leg — derived from prose, not synced at all, because they're rebuilt at scan time and there's no point in shipping them across the wire.

### Q3 [arch] How would you design this to support webhooks pushing into loopd from Notion?

Today loopd polls — it pulls Notion on app open and on manual sync. Boot-time the chain is `syncAll → syncAllTodos → syncAllHabits → syncAllThreads`, all gated on auto-sync being on AND the relevant DB ID being configured. To go push-driven, I'd insert a thin server in front: a webhook receiver that Notion POSTs to, and loopd connects via WebSocket or SSE for "your data changed, pull now" notifications. The receiver doesn't store body; it just dispatches.

The body still pulls through the existing [`pullEntries`](../../src/services/notion/sync.ts) / `pullTodos` / `pullHabits` / `pullThreads` paths. **The architectural insight here**: the cleanest reactive system makes pull idempotent and uses push only as a wakeup signal, not a data delivery mechanism. A missed webhook is recoverable on next poll. A reordered webhook doesn't matter. The system degrades to polling cleanly when push is unavailable.

I'd also need to think about ordering. Notion might fire a webhook while a pull is mid-flight; the existing `last_edited_time` per-field merge gives natural conflict resolution as long as my clock skew assumptions hold. At larger scale I'd add a Lamport-clock or per-row version vector to the merge logic, but for two-actor sync (one user, two devices via Notion) the wall-clock comparison is fine.

The piece I haven't built that would matter at scale: a per-user sync gateway that fans out reads and writes to Notion with proper backpressure. Right now the rate limiter is per-device; a multi-user server would need a shared token bucket, probably backed by Redis.

### Q4 [senior] You auto-create a thread when a user types `#unknown` in prose. Defend that.

Honest answer: it's a deviation from the stricter "explicit-only" model the spec originally proposed, and I made the call deliberately at [`scanThreads.ts:65-94`](../../src/services/threads/scanThreads.ts).

The tradeoff: explicit-only is typo-safe (`#loop` doesn't accidentally fork a new thread from `#loopd`) but high-friction (every new tag requires a confirm). Auto-create is ergonomic (you just type) but typo-prone. I chose auto-create because the inline `+ create #xyz` chip in the autocomplete already exists — that's the immediate-feedback path — and the scanner-side auto-create is the **fallback** for prose typed past the popover, on the `/todos` page where there's no autocomplete, or when fast-typing skips the chip entirely.

Risk mitigation: code-span masking (`` `git #branch` `` is stripped before regex via [`maskCode`](../../src/services/threads/scanThreads.ts) at lines 25-33) prevents accidental tag creation from quoted text. Per-line per-slug deduplication prevents `#loopd #loopd` from doubling up. And the threads CRUD page lets the user merge or hard-delete typo'd threads — recovery exists.

If this app shipped to a wider audience I'd reconsider. For solo-dev daily use, the friction cost of explicit-only outweighs the cleanup cost of the occasional `#loop` → `#loopd` typo. The deviation from the original "explicit-only" design is documented inline above the auto-create branch so future-me knows it was intentional, not an oversight.

The broader lesson: **ergonomic deviations from a stricter model are fine if you (a) document them inline at the deviation point, (b) preserve a recovery path, and (c) note them in the spec as known deviations.** Spec §6.6 calls this out explicitly so I can't pretend it was an accident.

## The hard question

> "What's the security model? You have no auth and tokens in plain text on a phone."

Tokens aren't in plain text. API keys live in `expo-secure-store` which on Android maps to the Android Keystore (hardware-backed when available) and on iOS to the Keychain. The Notion integration token, the Anthropic API key, the OpenAI API key — all encrypted at rest by the OS. Not by me — by the platform's standard secret store.

What I don't have: per-user isolation (single-user app), audit logging (no compliance requirement), or token rotation (Notion integration tokens are long-lived and the user can rotate them in their Notion admin). At any multi-user scale I'd need: per-user encryption-at-rest on the SQLite store (the OS-provided full-disk encryption is the current line of defense; that's not enough for sensitive shared data), OAuth flow for Notion (currently the user pastes integration tokens, which is fine for solo use and unacceptable in a real product), and an audit log of sync operations so the user can see what was sent where and when.

The honest framing is that the security model is "single-user, local-first, OS-provided secret storage" — and that's appropriate for what this is. The minute it becomes multi-user, three things change at once: auth, audit, encryption-at-rest. I know what they are and what order to ship them in. I don't have them today because today they would be theater.

→ [05 — AI engineering](./05-ai-engineering.md)
