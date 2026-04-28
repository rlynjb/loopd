# 04 — Backend and API design

> **There's no real backend.** That's the first thing to say. Everything that looks like backend logic is in `src/services/` and runs on-device. The only network dependency is the Notion REST API.

When the interviewer asks about the backend, the temptation is to apologize for not having one. Don't. The decision to be local-first with optional cloud sync is the architectural call, and I should defend it on its merits. There's no auth layer because there are no other users. There's no database because there's only one device. There's no scaling concern because the system is single-user. What I do have is real sync logic — bidirectional Notion sync with field-level merge rules, a sync-deletion outbox queue, schema-gap tolerance for users running older Notion DB versions, and a module-level rate limiter that serializes every Notion call across all features.

The Notion sync is the most interesting "backend" concern in the codebase. It's bidirectional, it handles partial schema, it survives network failures, and it's correct in the face of clock skew between devices. None of that is template code. The patterns I'm using here — outbox queues, tolerant readers, last-edit-wins per-field merges — are textbook distributed-systems primitives applied at small scale.

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
       ├──► entries ──┐                              │
       │              ├─► HTTPS PATCH ──────────────►│
       ├──► todos ────┤                              │
       │              │                               │
       ├──► nutrition ┘                               │
       │                                              │
       │  PUSH: deletions (FIFO drain of queue)       │
       │   ┌─────────────────────────┐                │
       └──►│ sync_deletions          │── archivePage ►│
           │ entity_type discriminator                │
           │ ('entry'|'todo'|'habit' │                │
           │  |'nutrition')          │                │
           └─────────────────────────┘                │
                                                      │
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
       │                                              │
       ▼
  Update todos_json + todo_meta in single tx

  On 429: Retry-After header → exponential backoff
  On schema gap: detectMissingTodoProperties skips
                 absent fields silently (tolerant reader)
```

## Interview questions

### Q1 [mid] What happens if the Notion API call fails mid-write?

The Notion API at [`notion/api.ts`](../../src/services/notion/api.ts) has three reliability layers. The rate limiter at lines 7-16 enforces a module-level 350ms gap between every request, regardless of which feature triggered it — this is shared state across `syncAll`, `syncAllTodos`, every individual call. We don't trip Notion's 3-req/s ceiling ourselves. On 429 (rate-limited) responses, the client respects the `Retry-After` header and waits before retrying.

If the network dies mid-push, the local SQLite is already authoritative and the row's `updated_at` is in the future relative to `lastSync`. Next sync, the dirty-row push picks the row up and tries again. The whole pattern is idempotent because the dedup key is loopd-side `loopd ID`, not the Notion page ID — Notion will never have duplicate pages from a re-pushed create.

For deletes, the [`sync_deletions`](../../src/services/database.ts#L121-L129) table holds pending archive ops keyed by `notion_page_id`. The local row is already gone, but the queue retains enough information to issue the archive on next sync. This is the textbook *Transactional Outbox* pattern — durable record of intent that survives local crashes and network failures.

### Q2 [senior] Why is there a sync-deletion queue but no sync-creation queue?

Asymmetry of recoverability. A locally-deleted row that was synced has *no body left* — only its Notion page ID. If I don't capture that ID at delete time, the Notion page becomes unreachable. So the queue is required to preserve the archive intent.

A locally-created row, by contrast, *is* its body. The row exists in SQLite with `notionPageId IS NULL`. On the next sync, the dirty-detection logic at [`pushTodos`](../../src/services/notion/sync.ts) picks it up and creates the Notion page. The body is the queue.

The general principle: queues exist for ops that *lose information* without them. Captures, edits, and deletions of synced rows lose information; pure creates don't. I make a habit of asking this question whenever I see a queue — *what would be lost if this didn't exist?* If the answer is "nothing, the source is still there," the queue is overengineering.

### Q3 [arch] How would you design this to support webhooks pushing into loopd from Notion?

Today loopd polls — it pulls Notion on app open and on manual sync. To go push-driven, I'd insert a thin server in front: a webhook receiver that Notion POSTs to, and loopd connects via WebSocket or SSE for "your data changed, pull now" notifications. The receiver doesn't store body; it just dispatches.

The body still pulls through the existing [`pullEntries`](../../src/services/notion/sync.ts) and `pullTodos` paths. **The architectural insight here**: the cleanest reactive system makes pull idempotent and uses push only as a wakeup signal, not a data delivery mechanism. A missed webhook is recoverable on next poll. A reordered webhook doesn't matter. The system degrades to polling cleanly when push is unavailable.

I'd also need to think about ordering. Notion might fire a webhook while a pull is mid-flight; the existing `last_edited_time` per-field merge at [`pullTodos` in sync.ts](../../src/services/notion/sync.ts) gives natural conflict resolution as long as my clock skew assumptions hold. At larger scale I'd add a Lamport-clock or per-row version vector to the merge logic, but for two-actor sync (one user, two devices via Notion) the wall-clock comparison is fine.

The piece I haven't built that would matter at scale: a per-user sync gateway that fans out reads and writes to Notion with proper backpressure. Right now the rate limiter is per-device; a multi-user server would need a shared token bucket, probably backed by Redis.

## The hard question

> "What's the security model? You have no auth and tokens in plain text on a phone."

Tokens aren't in plain text. API keys live in `expo-secure-store` which on Android maps to the Android Keystore (hardware-backed when available) and on iOS to the Keychain. The Notion integration token, the Anthropic API key, the OpenAI API key — all encrypted at rest by the OS. Not by me — by the platform's standard secret store.

What I don't have: per-user isolation (single-user app), audit logging (no compliance requirement), or token rotation (Notion integration tokens are long-lived and the user can rotate them in their Notion admin). At any multi-user scale I'd need: per-user encryption-at-rest on the SQLite store (the OS-provided full-disk encryption is the current line of defense; that's not enough for sensitive shared data), OAuth flow for Notion (currently the user pastes integration tokens, which is fine for solo use and unacceptable in a real product), and an audit log of sync operations so the user can see what was sent where and when.

The honest framing is that the security model is "single-user, local-first, OS-provided secret storage" — and that's appropriate for what this is. The minute it becomes multi-user, three things change at once: auth, audit, encryption-at-rest. I know what they are and what order to ship them in. I don't have them today because today they would be theater.

→ [05 — AI engineering](./05-ai-engineering.md)
