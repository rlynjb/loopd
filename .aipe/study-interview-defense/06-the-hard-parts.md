# Chapter 6 — The hard parts

This chapter is about the questions that test character, not architecture: "What was the hardest bug?" "What are you proudest of?" "What part are you least confident defending?" The trap in all three is performance — candidates reach for a flattering bug (one that makes them look clever), a proud part that's actually generic, and they dodge the weakness question entirely. The senior move is the opposite: a bug whose *diagnosis* was hard, a proud part that's a real design call, and a weakness named plainly with the reason it's acceptable.

The reason these matter: an interviewer who's seen a hundred candidates can tell when you're reciting a rehearsed "greatest weakness is I care too much" answer. The thing that lands is specificity and the absence of flinching. You built buffr solo, so you own every decision — that's an advantage here, because every honest answer is also a complete one.

```
   THE THREE HARD QUESTIONS — what each actually tests

   "hardest bug?" ──────────▶ can you diagnose, not just code?
        │                     pick the bug whose CAUSE was hidden,
        │                     not the one with the cleverest fix
        ▼
   "proudest part?" ────────▶ do you know what's actually good?
        │                     pick a design call, not a feature.
        │                     "it works" is not pride; "it's still
        │                     right under change" is
        ▼
   "weakest spot?" ─────────▶ can you be honest without collapsing?
                              name it, say why it's acceptable now,
                              name what would change it. Don't
                              apologize; don't fake confidence
```

---

## The hardest bug

┌─────────────────────────────────────────────────────────────────────┐
│ "What was the hardest bug you hit on this?"                         │
│   → testing diagnosis skill: hard bugs are hard because the cause    │
│     is hidden, not because the fix is complex                        │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"The silent sync freeze, because the bug had no symptom. Cloud sync had stopped, but every symptom I could observe said the app was fine — reads worked, writes worked, the UI was responsive. That's the trap of a local-first app: the canonical store is on-device, so a broken cloud mirror produces *zero* user-visible signal. I only noticed because I happened to check Supabase directly and the rows were stale.

The diagnosis was the hard part. I curled the PostgREST endpoint with the anon key and saw rows coming back empty — which pointed at RLS, because the policies filter on `auth.uid()` and buffr has no user session, so `auth.uid()` is NULL and every policy denies. But the deeper bug was *why I hadn't caught it for an hour*: the sync orchestrator only logs on the success path, so an error that came back as data instead of an exception logged nothing. The bug taught me that in a local-first system, the absence of a sync log is itself a signal — silence isn't 'nothing happened,' it can be 'everything failed quietly.'"

▸ This is the same incident as the Chapter 5 war story, but framed for a *different* question — there it was "what fails," here it's "what was hard to *find*." Same facts, different emphasis: Chapter 5 stresses the failure behavior, Chapter 6 stresses the diagnosis. Use the framing that matches the question asked.

┃ "The bug had no symptom — that's what made it hard. In a local-first app, a broken cloud is invisible by construction."

---

## The proudest part

┌─────────────────────────────────────────────────────────────────────┐
│ "What part are you most proud of?"                                  │
│   → testing whether you can distinguish a real design call from a    │
│     feature that merely works                                        │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"The prose-as-canonical drops model. The user writes one freeform entry, and the structured records — todos, thread mentions, nutrition — are *derived* from inline markers in that prose, not stored as separate first-class inputs. The prose is the single source of truth; everything else is rebuilt from it at commit time. I'm proud of it because it stayed right under change. When I added the thinking-mode classifier and the per-type expansion later, they hung off the derived todos without touching the entry model — the derivation boundary held. And it's what makes the app feel like writing instead of filling out forms. The thing I'd point to in the code is the two-pass reconciler that keeps a `todo_meta` row 1:1 with each derived todo without a foreign key — SQLite can't FK to a JSON-array element, so the reconciler *is* the integrity mechanism, and it survived every feature I added on top."

▸ Notice what makes this a *senior* pride answer: it's not "the AI features are cool." It's a design decision (prose canonical, records derived) defended by its *durability under change* — the truest test of whether an abstraction was right. "It still holds after three features I didn't anticipate" is the proof.

┃ "Prose is canonical; the structured records are derived. I'm proud of it because it stayed right under every feature I added on top."

### Strong vs weak: the pride answer

| Weak answer | Strong answer |
|-------------|---------------|
| "I'm proud of the AI features — five chains is a lot." | "I'm proud of the prose-canonical drops model — a design call that stayed right as I added the classifier and expansion on top." |
| Pride in quantity / surface | Pride in a *decision* and its durability under change |
| Nothing to defend on follow-up | Invites the good follow-up ("how does derivation handle edits?" → two-pass matching) |

---

## The least-confident part

This is the one candidates dodge. Don't. The interviewer is testing whether you know your own weak spots — and if you claim there are none, they'll find one and you'll look like you didn't know your own system.

┌─────────────────────────────────────────────────────────────────────┐
│ "What part are you least confident defending?"                      │
│   → testing self-awareness: can you name a real weakness without     │
│     either apologizing for it or pretending it's fine?               │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"The complete absence of an eval harness for the AI chains. I have five chains making quality-sensitive judgments — classifying todos, generating captions, writing reflections — and I have no golden set, no regression suite, no LLM-as-judge, nothing that tells me whether a prompt change made things better or worse. The only thing close is `validate.ts`, and that checks *shape*, not *quality* — it confirms the JSON parses, not that the summary is good. So when I tweak a prompt, I'm eyeballing three examples and shipping on vibes, which is exactly the thing I'd flag in someone else's code review. I know what the fix looks like — a 50-case golden set per chain, per-type F1 for the classifier, an LLM-as-judge rubric for the generative chains with cross-family judging to avoid self-preference bias — I just prioritized building features over building the eval harness. For a solo project at single-user scale that was a defensible call; for anything I shipped to real users, the eval harness would be a blocker, not a nice-to-have."

▸ The structure that makes this work: name the weakness *specifically* (no eval harness), admit the consequence *plainly* ("shipping on vibes"), prove you know the fix *in detail* (golden set, F1, LLM-as-judge with cross-family), and bound *when it's acceptable* (solo/single-user) vs *when it's not* (real users). That's four moves, and skipping any one of them turns honesty into either an apology or a dodge.

┃ "I tweak prompts and ship on vibes — no eval harness. I'd flag that in someone else's review, and I know exactly what fixes it."

---

## Follow-up decision tree — the hard parts

```
   "If you know the eval harness matters, why didn't you build it?"
        ▸ "Honest answer: features were more motivating, and at single-
           user scale a bad prompt is my problem for one day, not a
           thousand users' problem. I optimized for learning the
           architecture, not for production AI rigor. I'd reorder that
           for a real launch."
              │
              ├── "What would you eval first?"
              │      ▸ "The classifier — it's the one with a ground-truth
              │         label, so per-type F1 on ~50 hand-labeled todos
              │         is the cheapest, highest-signal eval to stand up."
              │
              └── "How do you know the captions are any good today?"
                     ▸ "I don't, rigorously. I know they don't repeat
                        because I pass recent captions as anti-repetition
                        context, but 'good' is unmeasured. That's the gap."
```

---

╔═══════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY — pushed to rank your weaknesses               ║
║                                                                       ║
║ The pushback: "Of all the things missing — evals, observability,      ║
║ auth, tests — which is the most dangerous, and why?"                  ║
║                                                                       ║
║ Say: "For the current state — solo, single-user — the most dangerous  ║
║ is the observability gap, because it already bit me twice with the    ║
║ silent sync freeze, and a silent failure I can't see is worse than a  ║
║ missing feature I know is missing. For a real launch, the ranking     ║
║ flips: auth becomes #1, because the Phase A hardcoded user_id is a    ║
║ correctness bug the moment there's a second user. So the answer       ║
║ depends on the timeline — and naming that it depends is the real      ║
║ answer."                                                              ║
║                                                                       ║
║ Why this works: it refuses a single fake ranking, gives two ranked    ║
║ by context (now vs launch) with a reason for each, and shows you      ║
║ think about risk relative to state. That's more senior than picking   ║
║ one and defending it rigidly.                                         ║
║                                                                       ║
║ Do NOT say: "they're all about equally important" (a dodge) or pick   ║
║ one without naming the timeline that makes it #1.                     ║
╚═══════════════════════════════════════════════════════════════════════╝

---

## What you'd change about the hard parts

If I could redo one thing, it's the order I built in: I built five AI chains before I built any way to measure them. The eval harness should have come after the second chain, not after the fifth — because by the time I had five, every prompt change risked a regression I couldn't detect, and retrofitting evals onto five chains at once is more work than growing them alongside. The lesson I'd carry forward: the eval harness is part of the *first* AI feature's definition of done, not a later phase. Build the ruler before you build the third thing you're measuring.

---

## One-page summary — Chapter 6

**Core claim:** the hard-parts questions test character, not architecture — answer with a bug that was hard to *diagnose*, a proud *design call* (not a feature), and a weakness named with its acceptable-bound.

**Questions, one-line answers:**
- *Hardest bug?* → the silent sync freeze — no symptom, because local-first hides a broken cloud. Diagnosis (curl → empty rows → RLS/auth.uid NULL) was the hard part.
- *Proudest part?* → prose-canonical drops model; proud because it stayed right under every feature added on top (classifier, expansion).
- *Weakest spot?* → no eval harness — tweaking prompts and shipping on vibes; know the fix (golden set, F1, LLM-as-judge), prioritized features instead.

**Pull quotes:**
- ┃ "The bug had no symptom — in a local-first app, a broken cloud is invisible by construction."
- ┃ "Prose is canonical; the records are derived. Proud because it stayed right under every feature on top."
- ┃ "I tweak prompts and ship on vibes — no eval harness. I'd flag that in someone else's review."

**What you'd change:** Build the eval harness as part of the *first* AI feature's definition of done — not after the fifth chain. Build the ruler before the third thing you measure.
