# Chapter 2 — The architecture

"Walk me through the system" is the question that eats the most interview time, and it's where candidates either look senior or look like they're narrating a tutorial. The trap is starting at a random corner — "so there's a React Native frontend..." — and wandering. You walk buffr the way the data flows: a write enters at the UI, lands in SQLite synchronously, and *later* a background job mirrors it to the cloud. If you walk it in that order, every interruption has a natural home.

The discipline: draw the layers first, name which one is canonical, then trace one write all the way through. You're not listing components — you're showing a request's journey and naming the boundary it never crosses on the read path.

```
┌─ buffr request flow — one write, traced end to end ───────────────────────┐
│                                                                           │
│  UI layer (app/, expo-router file routes)                                 │
│    user types in editor/[date].tsx                                        │
│         │  onChange → autosave (debounced per keystroke)                  │
│         ▼                                                                  │
│  Service layer (src/services/database.ts)                                 │
│    write to SQLite  ── bump updated_at ── schedulePush()                  │
│         │  (synchronous, <5ms — this is the whole user-visible write)     │
│         ▼                                                                  │
│  Storage layer — SQLite (buffr.db, WAL)  ◀── CANONICAL                    │
│    entries.text is the source of truth                                    │
│         │                                                                  │
│         │  ── on commit (focus blur / screen leave) ──                    │
│         ▼                                                                  │
│  Scanners (src/services/{todos,threads,nutrition}/)                        │
│    scan prose → derive todos_json, thread_mentions, nutrition             │
│    reconcileMeta keeps todo_meta 1:1 with the todos                       │
│         │                                                                  │
│  ··········· 5 seconds after last write ···········                       │
│         ▼                                                                  │
│  Network / sync layer (src/services/sync/)                                │
│    pushAll() → dirty rows (updated_at > synced_at) → batches of 50         │
│         │  upsert onConflict (user_id, id)                                │
│         ▼                                                                  │
│  Supabase Postgres (buffr schema)  ◀── MIRROR (never read during render)  │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

That diagram is the whole chapter. Everything below is what to say when they stop you at each layer — and they will stop you, because every arrow hides a decision.

---

## The walk, layer by layer

Start at the top and narrate the write. Here's the spoken version, with the interruption points marked.

**Your answer (the walk, ~60s):**

"A user types in the editor. Every keystroke autosaves to SQLite — that's `database.ts`, and it's synchronous, under five milliseconds, so the UI never waits on anything. On that write I bump an `updated_at` timestamp and call `schedulePush()`, which arms a five-second debounce. When the user leaves the screen, the commit path runs the scanners: they read the prose, which is canonical, and derive the structured records — todos from `[]` lines, thread mentions from `#tag`, nutrition from `** food` lines. A reconciler keeps a `todo_meta` row 1:1 with each todo. Then, five seconds after the last write, the push flow wakes up, selects every row where `updated_at > synced_at` — that's the dirty set — batches them in fifties, and upserts them to Supabase. Pull is a separate flow that runs on app boot. Reads, during all of this, only ever hit SQLite."

┃ "Reads only ever hit SQLite. The cloud is never on the render path — that's the whole architecture in one sentence."

### Where they'll interrupt — and what to say

```
   "Wait — autosave on every keystroke? Isn't that a lot of writes?"
        ▸ "SQLite WAL handles it — local writes are sub-millisecond.
           The scanners are what's expensive, so those run only at
           commit (blur / screen-leave), not per keystroke."

   "Why bump updated_at on the row instead of tracking dirty separately?"
        ▸ "updated_at is canonical and travels with the row to the cloud.
           synced_at is local-only bookkeeping. The dirty filter is just
           updated_at > synced_at — the column IS the queue, no separate
           outbox to drift out of sync."

   "What derives the todos — the AI?"
        ▸ "No. Derivation is deterministic prose-scanning, two-pass match.
           The AI only classifies and expands a todo AFTER it's derived.
           I keep the parsing rule-based so it's reproducible."

   "Five-second debounce — why five?"
        ▸ "Tuned, not sacred. Long enough to batch a burst of typing into
           one push, short enough that cross-device lag feels instant. At
           higher write volume I'd raise it."
```

The pattern across all four: every interruption is a decision you made on purpose, and you can name the thing it traded against. That's what separates "I walked the system" from "I defended the system."

---

## The thing they'll try to catch you on: two flows, not one

Interviewers probe sync engines for a specific misconception — that "sync" is one atomic operation. It isn't, in buffr, and saying so is senior signal.

┌─────────────────────────────────────────────────────────────────────┐
│ "So when it syncs, it pushes and pulls together?"                   │
│   → testing whether you understand that push and pull are            │
│     independent, and what that asymmetry costs                       │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"No — they're two independent flows with separate triggers. `pushAll()` fires on the debounce after a write; `pullAll()` fires on app boot and pull-to-refresh. There's no single 'sync' verb that does both atomically. That means there's a valid intermediate state where push has run but pull hasn't — the cloud has my latest writes, but my local copy is missing a recent update from another device. The architecture is fine with that asymmetry because each flow is idempotent: push uses `updated_at > synced_at`, pull uses `updated_at > last_pull_at`. Two cursors, two flows, one shared 10-table registry in `orchestrator.ts`."

▸ The move here is to *volunteer* the intermediate state before they find it. "There's a window where the cloud is ahead of local, and that's intentional" sounds like someone who's run the system, not someone reciting it.

┃ "Push and pull are two flows, two cursors, one registry. There's no atomic 'sync' — and that's a choice, not an oversight."

---

╔═══════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY — pushed past the storage internals           ║
║                                                                       ║
║ The pushback: "How does SQLite's WAL mode actually handle concurrent  ║
║ readers during a write? What's the checkpoint behavior?"              ║
║                                                                       ║
║ Say: "I know WAL lets readers proceed without blocking on a writer,   ║
║ which is why autosave-on-keystroke doesn't stutter the UI — that's    ║
║ why I chose it. The checkpoint internals — when WAL frames flush back ║
║ to the main db file — I haven't had to tune, so I'd be guessing on    ║
║ the exact thresholds. What I can tell you is the property I relied    ║
║ on and why."                                                          ║
║                                                                       ║
║ Why this works: you name the property you actually used and the       ║
║ decision it drove, then draw a clean line at the depth you haven't    ║
║ needed. Confident about what you know, precise about the edge.        ║
║                                                                       ║
║ Do NOT say: a hand-wavy guess about checkpoint thresholds. If you     ║
║ bluff the internals and they know them, the whole walk loses trust.   ║
╚═══════════════════════════════════════════════════════════════════════╝

---

## What you'd change about the architecture

The honest weak point is **observability of the sync layer**. The push and pull flows log only on the success path — `orchestrator.ts:49` and `:72` guard the log on non-zero counts. An error-only result that doesn't throw (a PostgREST error returned as data) drains nothing and logs nothing, so a frozen mirror is invisible because reads stay local and the app feels fine. This has actually bitten twice (the RLS-drift freeze and the schema-not-exposed freeze — Chapter 5 has the story). If I were hardening the architecture, the first change is logging on `r.error`, not just on counts. It's a ten-line change and it's the difference between "sync silently froze for an hour" and "sync errored and I saw it immediately."

That's the senior habit: even when asked to *describe* the architecture, end on the thing you'd reconsider. It signals you hold an opinion about your own work.

---

## One-page summary — Chapter 2

**Core claim:** buffr is three layers (UI → service → storage) with a fourth background sync layer; SQLite is canonical, the cloud mirror is never on the read path, and a write is traced top-to-bottom to walk it.

**Questions, one-line answers:**
- *"Walk me through it."* → autosave to SQLite (sync, <5ms) → bump `updated_at` + `schedulePush()` → scanners derive drops at commit → debounced push to Supabase.
- *"Push and pull together?"* → No — two independent flows, two cursors, one registry; the cloud-ahead-of-local window is intentional.
- *"Autosave every keystroke?"* → WAL makes local writes sub-ms; the expensive scanners run only at commit.
- *"What derives todos?"* → deterministic prose scanning (two-pass), not AI; AI classifies/expands *after*.

**Pull quotes:**
- ┃ "Reads only ever hit SQLite. The cloud is never on the render path."
- ┃ "Push and pull are two flows, two cursors, one registry — there's no atomic 'sync.'"

**What you'd change:** Add error-path logging to the sync orchestrator (`log on r.error`, not just success counts) — the current success-only guard hid two silent sync freezes.
