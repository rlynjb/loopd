# Chapter 7 — The counterfactuals

"What would you do differently?" is a generosity test disguised as a critique. The interviewer wants to see whether you can hold your own work at arm's length and name what you'd reconsider — without either defending everything (rigid) or regretting everything (no conviction). The failure mode here is fabricating regrets for decisions that were obviously right, which reads as insecurity. The other failure mode is having no answer, which reads as someone who's never revisited their own work.

The discipline: pick the three or four decisions that are *genuinely* reconsiderable, and for each, voice the strong counterfactual — the version of "I'd change it" that a sharp engineer would actually say. Crucially, distinguish decisions that were *wrong* from decisions that were *right with a known expiry date*. Those are different answers, and conflating them makes you sound like you don't know which of your calls were good.

```
   FOUR DECISIONS, RANKED BY HOW RECONSIDERABLE

   already corrected ──────▶ RLS-on-before-auth
        │                    (shipped the fix in migration 0009 —
        │                     this is a "what I changed," not "would")
        ▼
   genuinely reconsider ───▶ success-only sync logging
        │                    (would change today — it hid two freezes)
        ▼
   right, known expiry ────▶ hand-picked retrieval over RAG
        │                    (right NOW; flips when week-scope ships)
        ▼
   right, would keep ──────▶ LWW conflict resolution
                             (correct for single-writer; the "change"
                              is conditional on going multi-user)
```

The strongest signal in this chapter is the *gradient* — showing you can tell a corrected mistake from a live regret from a right-with-expiry call from a hold-the-line decision. That gradient is what a senior engineer's judgment looks like out loud.

---

## Counterfactual 1 — RLS enabled before auth existed (already corrected)

┌─────────────────────────────────────────────────────────────────────┐
│ "Is there a decision you already reversed?"                         │
│   → testing whether you can own a mistake that you caught and fixed  │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"Yes — letting RLS get enabled before real auth existed. The Supabase dashboard nags about disabled-RLS tables and offers a one-click enable, and it got turned on. But buffr uses the anon key with no user session, so `auth.uid()` is NULL, every policy denied every query, and cloud sync silently froze. I caught it and shipped migration `0009` to re-disable RLS and codify the Phase A posture in the migration chain — so a `db-migrate --all-pending` can't silently leave RLS on again. What I'd do differently isn't a design change, it's a process one: I'd never let a security toggle live only in a dashboard where a well-meaning nag can flip it. The posture belongs in version-controlled migrations, full stop — which is exactly what 0009 enforces now."

▸ This is the strongest kind of counterfactual: a real mistake, *already fixed*, with the fix shipped and the lesson generalized (security state belongs in migrations, not dashboards). It proves you reverse decisions when you're wrong, which is the trait the whole chapter is testing.

┃ "Security posture belongs in version-controlled migrations, not a dashboard toggle a nag can flip. 0009 is that lesson, shipped."

---

## Counterfactual 2 — Success-only sync logging (would change today)

┌─────────────────────────────────────────────────────────────────────┐
│ "What's something you'd change right now if you reopened the code?" │
│   → testing whether you have a live, specific regret (not a vague    │
│     'more tests')                                                    │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"The sync orchestrator's logging. It logs only on the success path — `orchestrator.ts:49` and `:72` guard the log on non-zero applied/failed counts. That means an error returned as data instead of thrown produces zero counts and logs nothing, which is precisely how the silent sync freeze stayed silent for an hour. I'd change it today: log on `r.error`, not just on counts, and add a heartbeat that alerts when there's been no successful sync in N hours. It's a ten-line change. The reason it's a real regret and not just a missing feature is that it already cost me — twice. A missing feature is a gap; a logging blind spot that hid two production freezes is a mistake."

| Weak counterfactual | Strong counterfactual |
|---------------------|----------------------|
| "I'd add more logging." | "I'd log on `r.error`, not just success counts, in `orchestrator.ts:49/:72` — that exact guard hid two silent freezes. Ten-line change." |
| Vague, ungrounded | Names the file, the guard, the incident it caused, and the precise fix |

---

## Counterfactual 3 — Hand-picked retrieval over RAG (right now, known expiry)

┌─────────────────────────────────────────────────────────────────────┐
│ "Would you have built the AI retrieval differently?"                │
│   → testing whether you can defend a 'no' that has an expiration date│
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"Not today — and this is the interesting one, because the honest answer is 'it's right now but I know when it stops being right.' The expand chain uses hand-picked retrieval: sibling todos plus the last three days of entries, capped at about 1000 characters each. No embeddings, no vector search. At buffr's corpus size — one person's journal — that's correct; building an embedding index, keeping it fresh, and serving cosine queries would be cost and complexity for no measurable recall gain. My spec even names it as a principle: no RAG until provably needed. But it has an expiry date. The moment I add 'interpret my whole week' or 'find related entries on this thread,' hand-picked recency stops covering the query and semantic retrieval earns its place. So I wouldn't change it now, but I've already specced the Phase 2A build that flips it — embeddings in `sqlite-vec`, hybrid retrieval with reciprocal-rank fusion, optional reranking gated by an eval."

▸ The senior distinction this draws: a decision that's *right with a known expiry date* is not the same as a decision you'd change. Voicing that difference — "I wouldn't change it, but here's the exact condition that flips it" — shows you understand that good architecture decisions are contextual, not absolute.

┃ "It's right now, with a known expiry date. That's a different answer from 'I'd change it' — and knowing the difference is the point."

---

## Counterfactual 4 — Last-write-wins conflict resolution (conditional change)

┌─────────────────────────────────────────────────────────────────────┐
│ "Would you keep last-write-wins?"                                   │
│   → testing whether you defend a decision that's right under your    │
│     constraints without pretending it's universally right            │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"For single-writer — which is buffr today — yes, I'd keep it. LWW by `updated_at` is correct exactly once per row per second, and at single-writer scale that's always; CRDTs would be machinery for a problem I don't have. The change is purely conditional: the day buffr is multi-user with concurrent edits to the same entry, LWW silently drops one writer's changes, and that's the point I'd replace it — not patch it. The replacement is CRDTs on the prose layer, Y.js or Automerge, so edits compose deterministically before the scanners run. That swaps out `chooseWinner` and leaves push, pull, and the orchestrator intact. So my answer is 'keep it, with a documented trigger' — I know the exact condition, and I know the migration is contained to the conflict path."

---

## Follow-up decision tree — counterfactuals

```
   "It sounds like a lot of these are 'I'd change it later.' Anything
    you'd genuinely undo about the core design?"
        ▸ "The core local-first design, no — it's the thing I'd keep
           hardest, because it's what makes the app instant and offline.
           The genuine undo is smaller and process-level: I'd build the
           eval harness and the sync observability alongside the features,
           not after. Those aren't design reversals; they're sequencing
           regrets. The architecture I'd build the same way."
              │
              ├── "So no architectural regrets at all? That's convenient."
              │      ▸ "Fair challenge. The one architectural thing I'd
              │         genuinely reconsider: storing todos as JSON in the
              │         entry plus a 1:1 meta table. It works, but the
              │         reconciler that keeps them in sync is the most
              │         fragile code in the app. A normalized todos table
              │         would trade the reconciler for joins — I'm not
              │         certain which is right, and that uncertainty is
              │         honest."
              │
              └── "Why not just decide that one now?"
                     ▸ "Because I haven't felt enough pain from either to
                        know. Deciding it without that signal would be
                        guessing. I'd let the next feature that touches
                        todos force the call."
```

▸ That second branch is important: when pushed on "no architectural regrets," *find a real one* (the JSON-todos + reconciler fragility) and be honest that you're genuinely uncertain. Manufactured certainty in either direction is the tell; "I don't know which is right and here's why" is the senior answer.

---

╔═══════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY — pushed to regret a decision that was right   ║
║                                                                       ║
║ The pushback: "Surely local-first was the wrong call — it cost you a  ║
║ whole sync engine you wouldn't need with a normal cloud backend."     ║
║                                                                       ║
║ Say: "I'll push back on that one. The sync engine is real cost — about║
║ twelve files — but it bought the two properties that define the       ║
║ product: sub-five-millisecond reads and full offline use. A cloud     ║
║ backend removes the sync engine and replaces it with a network round- ║
║ trip on every render and a dead app with no signal. For a journaling  ║
║ app people use on planes and subways, that's not a trade I'd reverse. ║
║ I'll own the sync complexity as the price; I won't call the decision  ║
║ wrong, because the alternative is worse for this product."            ║
║                                                                       ║
║ Why this works: not every "would you change it" deserves a yes.       ║
║ Defending a right decision *with the tradeoff named* is stronger than ║
║ manufacturing a regret to seem humble. The interviewer is also        ║
║ testing whether you'll cave under pushback on a correct call.         ║
║                                                                       ║
║ Do NOT say: "Yeah, maybe local-first was overkill" — caving on a      ║
║ decision you can defend reads as no conviction, which is worse than   ║
║ the imagined arrogance of holding your ground with a reason.          ║
╚═══════════════════════════════════════════════════════════════════════╝

---

## What you'd change about the counterfactuals

The meta-lesson across all four: most of what I'd "do differently" about buffr isn't architecture — it's *sequencing*. The local-first design, the prose-canonical model, the provider abstraction, even LWW — those I'd build the same. What I'd reorder is building the rulers (evals) and the alarms (sync observability) *alongside* the features instead of after them. If there's one thing to carry to the next project, it's that the instrumentation isn't a later phase; it's part of the first feature's definition of done. That's a process counterfactual, and it's the most useful kind, because it transfers to every project, not just this one.

---

## One-page summary — Chapter 7

**Core claim:** counterfactuals test whether you can hold your work at arm's length — answer with a *gradient* from corrected mistakes to live regrets to right-with-expiry calls to held-line decisions, and never fabricate a regret for a right call.

**The four, one line each:**
- *RLS-before-auth* → already corrected (migration 0009); lesson: security posture belongs in migrations, not a dashboard toggle.
- *Success-only sync logging* → would change today; log on `r.error` + heartbeat; it hid two freezes (a mistake, not a gap).
- *Hand-picked retrieval over RAG* → right now with a known expiry; flips when week-scope/related-entries ships; Phase 2A already specced.
- *LWW conflict* → keep for single-writer; conditional change to CRDT when multi-user; contained to `chooseWinner`.

**Pull quotes:**
- ┃ "Security posture belongs in version-controlled migrations, not a dashboard toggle a nag can flip."
- ┃ "It's right now, with a known expiry date. That's a different answer from 'I'd change it.'"

**What you'd change:** Mostly sequencing, not architecture — build the evals and sync observability alongside the features, not after. The design I'd build the same; the order I'd reverse.
