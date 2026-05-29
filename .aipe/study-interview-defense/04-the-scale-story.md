# Chapter 4 — The scale story

"What breaks first at 10x?" is a trap with a tell. The candidate who's never run anything at scale either freezes or name-drops Kafka. The candidate who's thought about it walks the bottlenecks *in the order they'd actually hit* and names what they'd measure before reaching for any tool. You don't have distributed-systems-at-scale on your resume — buffr is a single-user app — so the move is not to pretend. The move is to reason precisely about where *this specific system* breaks, in order, and to be honest that you'd measure before you'd build.

Here's the thing that makes buffr's scale story unusual and worth telling: because reads are local-canonical, the read path *doesn't scale with users at all* — it's per-device. That removes the bottleneck most apps hit first. So buffr's scale story is mostly about the sync layer, the AI chains, and the one query that does a full table scan.

```
   THREE SCALE AXES — where each one breaks first

   10x USERS (1 → ~1000)              100x DATA (per user)          10x LATENCY-SENSITIVE
   ────────────────────               ───────────────────          ─────────────────────
   read path: unaffected              push query: full scan         AI chains: ~1-2s each
   (reads are per-device              on updated_at (no index)       (network-bound)
    local SQLite)                          │                              │
        │                                  ▼                              ▼
   FIRST BREAK:                       FIRST BREAK:                   FIRST BREAK:
   auth — the hardcoded               CREATE INDEX                   no caching beyond
   user_id collides                   ON <table>(updated_at)         per-day ai_summaries;
   (Phase A → Phase B)                                               no streaming on interpret
        │                                  │                              │
        ▼                                  ▼                              ▼
   SECOND BREAK:                      SECOND BREAK:                  SECOND BREAK:
   Supabase connection                batch size 50 → drain          no request queue /
   limits on concurrent push          time grows; raise + parallel    rate limit → 429s
```

The honest frame to open with: "buffr is single-user today, so I haven't *run* it at scale — but I know exactly where it breaks, in what order, and what I'd measure before adding anything." That sentence buys you the right to reason instead of perform.

---

## Scenario 1 — 10x users (1 → ~1000)

┌─────────────────────────────────────────────────────────────────────┐
│ "Say this gets a thousand users. What breaks first?"                │
│   → testing whether you know your system's actual first bottleneck,  │
│     not a generic 'add a load balancer' answer                       │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"The read path doesn't break at all — reads are local SQLite, per-device, so they don't scale with user count. The first thing that breaks is auth, and not for a scaling reason exactly: buffr is in Phase A, where every cloud row is stamped with one hardcoded `user_id`. The moment there's a real second user, that UUID collides — every device's rows show up on every other device's dashboard. So 'ten users' isn't a load problem first, it's a correctness problem: I have to ship Phase B — real Supabase auth, replace the hardcoded UUID with `auth.uid()`, run a one-time backfill, and ship a new migration that flips RLS to ENABLE. The schema was built for this — the composite PK was correct from day one — so it's an auth-flow addition, not a schema rewrite. *After* that, the actual load question is Supabase's concurrent-connection limits on the push flow, which is where I'd start measuring."

▸ The senior move: you reframed "10x users" from a load question into a *correctness* question (the Phase A UUID collision), because for buffr that's genuinely what breaks first. Answering the question they should have asked, accurately, beats answering the generic one.

┃ "At ten users the first break isn't load — it's the Phase A hardcoded user_id colliding. Auth before scale."

---

## Scenario 2 — 100x data (per-user corpus grows)

┌─────────────────────────────────────────────────────────────────────┐
│ "A user has years of entries — hundreds of thousands of rows.       │
│  What breaks?"                                                       │
│   → testing whether you know your queries' complexity and indexing   │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"The push query breaks first. It selects the dirty set with `WHERE updated_at > synced_at`, and there's no index on `updated_at` today — at a few hundred rows that's nothing, but at hundreds of thousands it's a full table scan on every push. The fix is a one-liner: `CREATE INDEX ON <table>(updated_at)`, or a partial index on `updated_at WHERE deleted_at IS NULL` since reads filter soft-deletes anyway. Second break is the batch size — 50 per batch is fine for hundreds of dirty rows, but if a user comes back online after a long offline stretch with thousands of dirty rows, draining 50 at a time gets slow; I'd raise the batch and parallelize per-table. The pull pagination is already fine in shape — 200 per page, ordered by `updated_at` — it just assumes a sane index on the cloud side too."

```
   the query that breaks first, and the fix

   today:   SELECT * FROM <table> WHERE updated_at > synced_at
                │
                ▼  no index on updated_at
            full table scan  ── fine at 100s of rows
                                 SLOW at 100k+ rows
   fix:     CREATE INDEX ON <table>(updated_at)
                            WHERE deleted_at IS NULL    ◀── one line
```

▸ Naming the *exact* query, the *exact* missing index, and the *exact* one-line fix is what makes this credible. "I'd add some indexes" is what someone says who hasn't looked. "There's no index on `updated_at` and the push query full-scans" is what someone says who has.

---

## Scenario 3 — 10x latency-sensitive requests (AI chains under load)

┌─────────────────────────────────────────────────────────────────────┐
│ "The AI features feel slow under load. Where's the latency?"        │
│   → testing whether you've thought about LLM serving, not just LLM   │
│     calling                                                          │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"The AI chains are network-bound — one to two seconds each against the provider — and buffr does almost nothing to manage that today, which is the honest gap. There's a per-day cache: the `ai_summaries` table keyed on `(user_id, date)`, so opening the same day twice doesn't re-call the model. But beyond that there's no streaming, no request queue, no retry-with-backoff, no circuit breaker. So the first thing that breaks under load is the user-perceived latency on the `interpret` chain — it's long-form markdown, four-ish seconds, and it blocks with a spinner because I never made it stream. The first fix is streaming `interpret` for perceived latency. The second is a request queue with backoff so a burst of chain calls degrades gracefully into a wait instead of a wall of 429s from the provider. I know the shape of the fix; I just haven't needed it at single-user volume."

| Weak answer | Strong answer |
|-------------|---------------|
| "I'd add caching and make it faster." | "There's a per-day exact-match cache already; what's missing is streaming on `interpret` and a request queue with backoff — and I can tell you why each isn't there yet." |
| Vague about what's cached | Names the cache (`ai_summaries`, `(user_id, date)`), the gap (no streaming/queue/circuit-breaker), and the order to fix |

┃ "The chains are network-bound and I manage that with a per-day cache and nothing else — which is the honest gap, and I know exactly what fills it."

---

## Follow-up decision tree — scale

```
   "When would you actually add all this infrastructure?"
        ▸ "When measurement says to. At single-user it's premature.
           The trigger for each is concrete: index when the push query
           p95 climbs; queue when I see 429s; streaming when users
           tap interpret twice thinking it's stuck."
              │
              ├── "How would you measure the push query?"
              │      ▸ "I'd need the ai_call_log / sync timing I haven't
              │         built yet — that's honestly the prerequisite.
              │         Can't optimize what I'm not measuring."
              │
              └── "Isn't local-first a scaling dead end for collaboration?"
                     ▸ "For real-time collaboration, yes — local-canonical
                        + LWW caps at single-writer. Multi-user collab is
                        a different architecture (CRDT + presence), not a
                        scaled version of this one. I'd say that plainly."
```

---

╔═══════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY — pushed into distributed-systems-at-scale     ║
║                                                                       ║
║ The pushback: "How would you shard this across regions? What's your   ║
║ replication strategy at a million users?"                             ║
║                                                                       ║
║ Say: "That's past where I've worked. I've built five system shapes    ║
║ end-to-end, but none of them ran at horizontal scale with            ║
║ multi-region replication — that's large-company-at-scale experience  ║
║ I don't have yet. I can reason about buffr's first two bottlenecks    ║
║ from the code, but if I started inventing a sharding strategy I'd be  ║
║ performing knowledge I don't have. What I'd actually do is measure,   ║
║ then bring in someone who's run it at that scale."                    ║
║                                                                       ║
║ Why this works: it draws the line exactly at the edge of your real    ║
║ experience (me.md is explicit about this gap), refuses to perform,    ║
║ and frames the honesty as judgment ("I'd bring in someone who's run   ║
║ it") rather than deficiency. Senior engineers know their edges.       ║
║                                                                       ║
║ Do NOT say: a confident-sounding sharding plan you can't defend on    ║
║ the follow-up. Interviewers who run things at scale will find the     ║
║ bottom of a bluff in one question.                                    ║
╚═══════════════════════════════════════════════════════════════════════╝

---

## What you'd change about the scale story

The thing that would change buffr's scale story most is the thing it's missing: **measurement.** I can name the bottlenecks by reading the code, but I can't show you a p95 curve because there's no sync-timing log and no `ai_call_log` table yet. That's the actual first thing I'd build before any scaling work — not an index, not a queue, but the instrumentation that tells me which one to add. The order is measure, then optimize, and right now I'm reasoning about bottlenecks I haven't yet instrumented. I'd rather say that than pretend I have the dashboards.

---

## One-page summary — Chapter 4

**Core claim:** buffr's read path is per-device local, so it doesn't scale with users; the scale story is about the sync layer, one unindexed query, and unmanaged AI latency — and the honest frame is "I know where it breaks, I haven't run it there."

**Scenarios, one-line answers:**
- *10x users* → first break is correctness, not load: the Phase A hardcoded `user_id` collides. Ship Phase B auth (schema's already ready).
- *100x data* → push query full-scans on `updated_at` (no index). Fix: `CREATE INDEX ON <table>(updated_at) WHERE deleted_at IS NULL`. Then raise batch size.
- *10x AI latency* → chains are network-bound; only a per-day cache exists. Add streaming on `interpret`, then a request queue with backoff.

**Pull quotes:**
- ┃ "At ten users the first break isn't load — it's the Phase A hardcoded user_id colliding. Auth before scale."
- ┃ "The chains are network-bound and I manage that with a per-day cache and nothing else — that's the honest gap."

**What you'd change:** Build the measurement first — sync timing + `ai_call_log` — because right now I'm reasoning about bottlenecks I haven't instrumented. Measure, then optimize.
