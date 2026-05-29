# Chapter 8 — The AI question

"Did you use AI to build this?" is now a standard interview question, and in 2026 the wrong answer is "no" — said defensively, as if AI assistance were cheating. The interviewer assumes you used AI heavily; everyone does. What they're actually probing is whether you *understand* what you shipped or whether the AI understands it and you're the courier. The question isn't "did you use AI" — it's "are the decisions yours."

The frame that wins is honesty calibrated by decision-mode. Not every line of buffr was a deliberate choice, and pretending otherwise is a trap — the interviewer will find the part you didn't deeply evaluate and you'll look like you claimed it. Instead, distinguish three modes of how a decision got made, and own each one accurately. The mode that's riskiest to admit — "the AI defaulted to it and I didn't deeply evaluate" — is also the most senior-positive when you own it well, because it proves you know the difference.

```
   THREE MODES OF DECISION — own each one accurately

   DELIBERATE ───────────────▶ you chose it, you can defend the
        │                      alternative you rejected
        │                      e.g. local-first, composite-PK gate
        ▼
   EVALUATED-AND-ACCEPTED ───▶ AI suggested, you tested, you kept it
        │                      e.g. Anthropic over OpenAI (you A/B'd it)
        ▼
   DEFAULTED-TO ─────────────▶ AI's default, you didn't deeply evaluate
                               e.g. batch size 50, some Expo config
                               ◀── riskiest to admit, most senior to own
```

The skill is sorting your decisions into these three buckets *out loud*, accurately. A candidate who claims everything was deliberate is lying and will get caught. A candidate who admits everything was defaulted-to has no signal. The one who says "this was deliberate, this I evaluated, and this I defaulted to and here's how I'd know if it mattered" — that's the one who looks like they ran the project.

---

## The core question

┌─────────────────────────────────────────────────────────────────────┐
│ "Did you use AI to build this?"                                     │
│   → testing whether the decisions are yours or the AI's; whether you │
│     understand what you shipped                                      │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"Heavily, yes — and I'd be suspicious of anyone who says they didn't in 2026. The useful question is which decisions were mine versus the model's, and I can sort them. The architecture was deliberate — local-first with SQLite canonical, the composite-PK security gate, single-purpose chains instead of one mega-prompt — those were my calls, and I can tell you the alternative I rejected for each. Some choices the AI suggested and I evaluated before keeping — I A/B'd Anthropic against OpenAI on the summary chain and Sonnet won on tone accuracy, so that's evaluated-and-accepted, not defaulted. And some things I defaulted to without deep evaluation — the push batch size of 50, a chunk of the Expo config — and I'll own those as defaults, with the caveat that I know which ones would need real measurement if they ever mattered. The AI was a fast pair, not the architect. The architecture decisions are mine to defend."

▸ The move: answer "yes, heavily" without a flicker of defensiveness, then immediately reframe to the question that matters (whose decisions) and demonstrate you can sort them. The sorting is the proof. Defensiveness about AI use is the actual red flag in 2026 — it signals you think you did something wrong.

┃ "The AI was a fast pair, not the architect. The architecture decisions are mine to defend — and I can tell you which were deliberate, which I evaluated, and which I defaulted to."

---

## The follow-up that separates candidates

┌─────────────────────────────────────────────────────────────────────┐
│ "Show me something the AI got wrong that you caught."               │
│   → testing whether you actually reviewed AI output or rubber-       │
│     stamped it                                                       │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"The clearest one: when I generated the study documentation for this codebase, the AI invented a classifier type set — it described buffr's thinking-mode classifier as having seven task-management types like 'errand,' 'social,' 'admin.' That was never buffr's design. The real set is five thinking-oriented types — `todo`, `idea`, `knowledge`, `study`, `reflect` — and the AI had pattern-matched to a generic todo-app taxonomy instead of reading my actual schema. I caught it because I knew the real types, traced it back to a stale line in my own project-context file that said 'seven values,' and corrected both the docs and the source-of-truth context. The lesson cuts both ways: the AI hallucinated a plausible-but-wrong taxonomy, *and* it was partly my fault for feeding it stale context. That's exactly why AI output needs a reviewer who knows the domain — a reviewer who didn't know buffr's real types would have shipped the hallucination."

▸ This is a genuinely strong answer because it's specific (the exact wrong types vs the exact right ones), it shows the *mechanism* of the error (pattern-matching to a generic taxonomy + stale context you fed it), and it's self-implicating in the right way (you owned the stale-context half). "The AI got X wrong and here's the root cause, including my part in it" is the answer of someone who reviews, not rubber-stamps.

┃ "The AI hallucinated a plausible-but-wrong taxonomy from generic patterns — a reviewer who didn't know the domain would have shipped it. That's the whole case for knowing your own system."

### Strong vs weak: the AI question

| Weak answer | Strong answer |
|-------------|---------------|
| "No, I built it all myself." | "Heavily — the question is which decisions were mine, and I can sort them into deliberate, evaluated, and defaulted." |
| "Yes, AI did most of it." (no ownership) | "AI was a fast pair; the architecture calls are mine — here's the alternative I rejected for each." |
| Can't name anything the AI got wrong | Names a specific hallucination, its root cause, and your part in it |
| Defensive about using AI | Matter-of-fact about using it; precise about what's yours |

---

## AI honesty is woven through every chapter

The decision-mode distinction isn't just for this chapter — it's the honest substrate under every answer in the book. When you say "I chose local-first" (Chapter 3), that's a *deliberate* claim and you'd better have the rejected alternative ready. When you say "Anthropic's primary" (Chapter 3), that's *evaluated-and-accepted* and you cite the A/B. When you say "batch size 50" (Chapter 4), that's *defaulted-to* and you say so rather than inventing a benchmark.

```
   the three modes, mapped to claims you make elsewhere in the book

   DELIBERATE:              local-first · composite-PK gate · single-
                            purpose chains · prose-canonical drops
                            ▸ defend with the rejected alternative

   EVALUATED-AND-ACCEPTED:  Anthropic over OpenAI (A/B'd) · Haiku for
                            the cheap classifier (cost-measured)
                            ▸ defend with the evaluation you ran

   DEFAULTED-TO:            batch size 50 · 5s debounce · Expo config
                            ▸ defend by owning it as a default + naming
                              what would make you measure it
```

The reason to keep these straight: an interviewer who catches you claiming a defaulted-to decision as deliberate has found a crack, and they'll widen it. Owning "I defaulted to that" costs you nothing and buys you credibility on the decisions you *did* make deliberately.

---

## Follow-up decision tree — the AI question

```
   "If AI wrote most of the code, what did you actually do?"
        ▸ "I made the decisions AI can't make well — the architecture,
           the tradeoffs, the 'is this right for THIS product' calls —
           and I reviewed everything against a domain I understand. AI
           writes code fast; it doesn't know that local-first was right
           for a journaling app or that LWW breaks at multi-user. Those
           are the calls, and they're mine."
              │
              ├── "Couldn't AI have made those calls too?"
              │      ▸ "It can suggest them. It can't be accountable for
              │         them. When the RLS-freeze bug hit, no prompt
              │         caught it — I did, by knowing the system. The
              │         accountability is the job."
              │
              └── "How do you know you understand code AI wrote?"
                     ▸ "Same way I'd know for a teammate's code — I can
                        trace any path, name why each choice is there,
                        and tell you what breaks it. If I can't defend a
                        file, I didn't understand it, and I go back. This
                        whole book is that test, passed."
```

---

╔═══════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY — pushed on a defaulted-to decision you can't  ║
║ defend deeply                                                         ║
║                                                                       ║
║ The pushback: "You said the Expo config was defaulted-to. So you      ║
║ don't actually know how your build works?"                            ║
║                                                                       ║
║ Say: "I know what I needed it to do and verified it does that — the   ║
║ native modules I rely on, expo-sqlite and expo-secure-store, work and ║
║ I can explain why I need each. The parts of the Expo config I didn't  ║
║ hand-tune are the parts that worked at their defaults, and I didn't   ║
║ invent reasons to touch them. If a build issue forced me into the     ║
║ config, I'd learn the specific knob then. Defaulting to a working     ║
║ default isn't not-understanding — it's not-yet-needing-to. I won't    ║
║ pretend I tuned something I didn't."                                  ║
║                                                                       ║
║ Why this works: it distinguishes "I don't understand this" from "I    ║
║ didn't need to touch this," which are different and the interviewer   ║
║ is conflating them. You defend the parts you relied on, concede the   ║
║ parts you didn't, and refuse to fake depth on a working default.      ║
║                                                                       ║
║ Do NOT say: a bluffed explanation of a config knob you never set —    ║
║ this is the exact thing the question is hunting for. Owning the       ║
║ default is the safe and senior move.                                  ║
╚═══════════════════════════════════════════════════════════════════════╝

---

## What you'd change about the AI answer

The thing I'd strengthen about my AI-use story is the *evidence* of review. Right now my proof that I understood what AI wrote is that I can defend it in conversation — which is real, but it's verbal. If I were polishing buffr for interviews, I'd make the review trail visible: commit messages that distinguish "AI-drafted, reviewed" from "hand-written," a `docs/` note on which decisions were deliberate vs evaluated vs defaulted. Not because I need it to defend the work, but because *showing* the decision-mode sorting is stronger than *claiming* it. The catch I described — the classifier-type hallucination — is exactly the kind of thing that, captured in a commit, becomes proof instead of anecdote.

---

## One-page summary — Chapter 8

**Core claim:** in 2026 the AI question isn't "did you use it" (yes, everyone did) — it's "are the decisions yours." Answer by sorting decisions into deliberate / evaluated-and-accepted / defaulted-to, and owning each accurately.

**Questions, one-line answers:**
- *"Did you use AI?"* → "Heavily — the useful question is whose decisions. Architecture was deliberate; Anthropic I evaluated; batch size I defaulted to. I can sort them."
- *"Show me something AI got wrong."* → the invented 7-type classifier taxonomy (real set: 5 thinking-mode types); root cause was generic pattern-matching + stale context I fed it; caught because I knew the domain.
- *"If AI wrote it, what did you do?"* → the calls AI can't be accountable for — architecture, tradeoffs, is-this-right-for-this-product — plus reviewing against a domain I understand.

**Pull quotes:**
- ┃ "The AI was a fast pair, not the architect. The architecture decisions are mine to defend."
- ┃ "The AI hallucinated a plausible-but-wrong taxonomy — a reviewer who didn't know the domain would have shipped it."

**What you'd change:** Make the review trail *visible* — commit messages and a doc that distinguish deliberate / evaluated / defaulted decisions. Showing the sorting beats claiming it.

---

## Closing — you've reached the end of the book

You now have the whole interview, end to end: the pitch that sets the agenda, the architecture walk, the five load-bearing choices, the scale story honest about its gaps, the failure story with its silent-freeze war story, the hard-parts answers that don't flinch, the counterfactuals graded by reconsiderability, and the AI question owned by decision-mode. Read the eight one-page summaries the night before. Walk in knowing that the strongest thing you can do in the room is tell the truth about buffr precisely — what's deliberate, what's deferred, what broke and how you found it. That precision *is* the senior signal. Go defend your work.
