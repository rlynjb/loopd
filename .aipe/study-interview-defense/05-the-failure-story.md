# Chapter 5 — The failure story

"What happens when it fails?" separates people who shipped from people who demoed. A demo has a happy path. A shipped system has a behavior for every way the happy path breaks — and if you can't name those behaviors, the interviewer concludes you never ran it for real. buffr's saving grace here is local-first: most failures degrade *gracefully* because the canonical store is on-device and the network was never load-bearing. The failure that's *not* graceful — the silent sync freeze — is the most interesting story you have, because you found it, diagnosed it, and fixed it.

Walk the failure surfaces in order of how visible they are to the user. Network failures: invisible (local-first absorbs them). LLM API outages: nearly invisible (cached fallback), with one honest gap. Malformed input: handled by design (two-pass matching). And then the one that *wasn't* graceful and taught you the most: errors that arrive as data, not exceptions.

```
   FAILURE SURFACES — by user-visibility, best to worst

   network down ──────────▶ INVISIBLE
        │                   reads/writes hit local SQLite; sync lags,
        │                   catches up on reconnect via the dirty filter
        ▼
   LLM API outage ────────▶ MOSTLY INVISIBLE
        │                   cached ai_summaries served; a fresh chain
        │                   call throws → caught → silent fallback
        │                   (gap: no retry, no circuit breaker)
        ▼
   malformed prose ───────▶ HANDLED BY DESIGN
        │                   two-pass matching (exact → line-index
        │                   fallback); a bad marker just doesn't derive
        ▼
   mid-batch sync fail ───▶ SELF-HEALING
        │                   synced_at only stamped on success; the
        │                   dirty filter re-sends the rest next push
        ▼
   error-as-data ─────────▶ SILENT + DANGEROUS  ◀── the war story
                            PostgREST error returned as data, not thrown;
                            success-only logging hid it; froze sync twice
```

The frame to open with: "Because it's local-first, most failures degrade gracefully — the user keeps working and sync catches up. The failure mode I actually had to hunt down was the opposite: a sync freeze that was *silent* precisely because the local app kept feeling fine."

---

## Surface 1 — Network down

┌─────────────────────────────────────────────────────────────────────┐
│ "What happens if the user's offline?"                               │
│   → testing whether offline is designed-for or an afterthought       │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"Nothing the user can see. Reads and writes hit local SQLite, which is canonical, so the entire app works offline — that's the whole point of the architecture, not a feature bolted on. The only thing that stops is the background push, and it doesn't error loudly: the dirty rows just stay dirty — `updated_at > synced_at` still matches them — and the next push after reconnect picks them up exactly where it left off. A user can write eight entries on a plane; on landing, the first push batches all eight up. The dirty filter *is* the offline queue — there's no separate retry buffer to get out of sync."

┃ "The dirty filter is the offline queue. Offline writes stay dirty and the next push catches them up — no separate buffer to drift."

---

## Surface 2 — LLM API outage

┌─────────────────────────────────────────────────────────────────────┐
│ "What if the Anthropic API is down when a chain runs?"              │
│   → testing whether you handle provider failure or assume happy path │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"Two cases. If the day already has a cached summary — they're stored per-day in `ai_summaries` — the user sees that, no call happens, no problem. If it's a fresh call and the provider is down, the chain throws, the orchestrator in `compose.ts` catches it, and the UI falls back to whatever's cached or an empty state. Here's the honest gap: there's no retry with backoff and no circuit breaker today. A transient blip surfaces as 'no AI output' instead of silently retrying and succeeding. A sustained outage means every chain call fails the same way with no fast-fail. I know the fix — a request queue with exponential backoff for transient failures, a circuit breaker that opens after N consecutive failures so I'm not hammering a dead provider — I just haven't built it because at single-user volume a failed chain is a manual re-tap, not an incident. The provider abstraction is where that retry layer would slot in."

▸ Don't hide the gap — name it precisely (no retry, no circuit breaker) and show you know exactly where the fix goes (the provider abstraction boundary). "I haven't built it and here's why and here's where it goes" is a senior answer. "It handles failures gracefully" when it doesn't is a trap you set for yourself.

| Weak answer | Strong answer |
|-------------|---------------|
| "It handles API failures gracefully." | "Cached days are fine; a fresh call throws and falls back to cache/empty. The gap is no retry and no circuit breaker — here's where each would go and why it's not there yet." |
| Implies robustness that isn't there | Names the exact gap, the failure's user-visible shape, and the fix's location |

---

## Surface 3 — Malformed input

┌─────────────────────────────────────────────────────────────────────┐
│ "What if the user's prose is malformed — a broken marker, weird     │
│  formatting?"                                                        │
│   → testing input-robustness in the deterministic parsing layer      │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"The drop derivation is deterministic prose-scanning, and it's built two-pass: first an exact match against the prior scan, then a line-index fallback if the exact match fails — that's the same shape as a diff algorithm matching lines across an edit. A malformed marker just doesn't derive a record; it doesn't crash the scan or corrupt the existing drops. And the AI output has its own guard: the four JSON chains use the provider's tool-calling to constrain the shape, and `validate.ts` re-checks the parsed result with a schema before anything's stored. If a chain returns something malformed, validation throws a typed error the orchestrator handles — it doesn't write garbage into the cache."

┃ "A malformed marker just doesn't derive a record — two-pass matching means a bad line is a no-op, not a crash."

---

## Surface 4 — The silent sync freeze (the war story)

This is the failure worth spending real time on. It's where you demonstrate that you can debug a system whose failure mode is *invisible*.

┌─────────────────────────────────────────────────────────────────────┐
│ "Tell me about a time the system failed in production."             │
│   → testing whether you've debugged something genuinely hard, and    │
│     whether you understand silent failures                           │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"The worst failure I had was a *silent* one — twice, same root shape. Cloud sync just stopped, but the app felt completely normal, because reads are local-canonical: the user keeps reading and writing, nothing's visibly broken, and meanwhile the cloud quietly stops converging.

First instance: RLS got enabled on the Supabase tables. The dashboard nags about disabled-RLS tables and offers a one-click enable, and it got toggled on. But buffr authenticates with the anon key and no user session, so `auth.uid()` is NULL — and every `auth.uid() = user_id` policy denied every push and pull. Sync froze. I caught it by curling the endpoint and seeing the rows come back empty; migration `0009` re-disabled RLS to restore the Phase A posture.

Second instance: after I namespaced the tables into a `buffr` schema in migration `0010`, the schema wasn't in Supabase's exposed-schemas list yet, so every call returned `PGRST106`. Same silent freeze.

The thing both share — and the real lesson — is *why* they were silent. The sync orchestrator logs only on the success path: `orchestrator.ts:49` and `:72` guard the log on non-zero applied/failed counts. A PostgREST error that comes back as *data* instead of throwing produces zero counts, so it logs nothing. The freeze was invisible at the app layer because of local-first, and invisible at the log layer because of success-only logging. The fix I'd ship is to log on `r.error`, not just on counts — that's the difference between an hour of silent divergence and an immediate alert."

```
   why the freeze was double-invisible

   app layer:   reads are local ──▶ app feels fine ──▶ user notices nothing
   log layer:   error returned as data (not thrown)
                     │
                     ▼
                success-only log guard (count > 0?)  ──▶ zero counts ──▶ no log
                     │
                     ▼
                FROZEN + SILENT  ── caught only by curling the endpoint
```

▸ This story does three jobs at once: it proves you debug hard things, it shows you understand *defense-in-depth's* shadow side (local-first hid the failure), and it ends on a concrete, shipped-or-specced fix. Lead with it whenever they ask for a failure story. The phrase "invisible at the app layer *and* invisible at the log layer" is the line that lands.

┃ "Local-first hid the freeze at the app layer; success-only logging hid it at the log layer. Double-invisible — that's why it took an endpoint curl to find."

---

## Follow-up decision tree — failure

```
   "How would you have caught the silent freeze sooner?"
        ▸ "Log on r.error, not just on success counts — ten-line change.
           Plus a heartbeat: alert if no successful sync in N hours.
           Absence of a sync log should be as loud as a sync error."
              │
              ├── "Why didn't you have that already?"
              │      ▸ "Honestly — success-only logging is the natural
              │         thing to write, and local-first masked the cost
              │         until it bit. That's exactly why I now treat
              │         'no log' as a signal, not a non-event."
              │
              └── "What other silent failures could be lurking?"
                     ▸ "Any error-as-data path. The classifier returning
                        a low-confidence default instead of erroring;
                        a chain silently truncating on a token overrun
                        I'm not counting. The fix class is the same:
                        instrument the quiet paths."
```

---

╔═══════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY — pushed on formal reliability guarantees      ║
║                                                                       ║
║ The pushback: "What are your consistency guarantees? Is this           ║
║ eventually consistent? What's your conflict-resolution correctness     ║
║ proof?"                                                                ║
║                                                                       ║
║ Say: "It's eventually consistent in the informal sense — each device  ║
║ converges after a push and a pull cycle, and last-write-wins makes    ║
║ the merge deterministic per row. I haven't written a formal           ║
║ correctness proof or modeled it in TLA+, so I won't claim guarantees  ║
║ I can't back. What I can defend precisely is the per-row merge rule   ║
║ and exactly where it's lossy — concurrent same-row writes — which is  ║
║ the property that actually matters for this app."                     ║
║                                                                       ║
║ Why this works: it gives the informal answer accurately, refuses to   ║
║ dress it up as a formal guarantee, and redirects to the property you  ║
║ can defend rigorously (the LWW merge and its known lossy case).       ║
║                                                                       ║
║ Do NOT say: "It's strongly consistent" (false — it's not) or invoke   ║
║ CAP-theorem vocabulary you'd have to defend on the next question.     ║
╚═══════════════════════════════════════════════════════════════════════╝

---

## What you'd change about the failure story

The failure story's weak spot is that buffr's graceful degradation is mostly a *gift of the architecture*, not a thing I engineered deliberately — local-first absorbs network failure for free, so I never had to design retry logic, and that's exactly why the silent freeze caught me. If I were hardening it, the first change isn't a feature, it's a posture: treat the sync layer's silence as a failure signal. Concretely — log on `r.error`, add a "no successful sync in N hours" heartbeat, and surface sync health somewhere the user (me) can see it. The architecture made failures quiet; the fix is making the quiet ones audible.

---

## One-page summary — Chapter 5

**Core claim:** local-first makes most buffr failures degrade gracefully (network, malformed input, mid-batch sync); the dangerous failure is the silent sync freeze, which was invisible at both the app layer and the log layer.

**Surfaces, one-line answers:**
- *Network down* → invisible; dirty rows stay dirty, next push catches up. The dirty filter is the offline queue.
- *LLM API outage* → cached days fine; fresh call throws → silent fallback. Gap: no retry/circuit-breaker (and I know where it goes).
- *Malformed prose* → two-pass matching makes a bad marker a no-op; `validate.ts` schema-checks AI output before storing.
- *Mid-batch sync fail* → `synced_at` stamped only on success; dirty filter re-sends the rest. Self-healing.
- *Silent freeze (war story)* → RLS-on (auth.uid NULL) and PGRST106 both froze sync; success-only logging hid it; fix is log-on-error + heartbeat.

**Pull quotes:**
- ┃ "The dirty filter is the offline queue — no separate buffer to drift."
- ┃ "Local-first hid the freeze at the app layer; success-only logging hid it at the log layer. Double-invisible."

**What you'd change:** Make the quiet failures audible — log on `r.error`, add a no-sync-in-N-hours heartbeat, surface sync health. The architecture made failures quiet; that's the thing to fix.
