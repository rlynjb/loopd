# Chapter 1 — The pitch

The first 60 seconds decide what kind of interview you get. Pitch buffr as "a journaling app" and you'll spend the hour defending why the world needs another journaling app. Pitch it as "a local-first system with an AI composition layer and a cloud mirror that's never on the read path" and the interviewer leans in — now it's a systems conversation, which is the one you want.

You need three lengths, because you don't control which one the room asks for. The 10-second version is for "what have you been working on?" in a hallway. The 30-second version is for "give me the overview" at the top of a panel. The 90-second version is the real "tell me about a project you're proud of" — the one you'll get most often, the one that sets the agenda for everything after.

```
   THREE LENGTHS — pick by the room, never overshoot the ask

   10s  ┌───────────────────────────────────────────────────────┐
        │ what it is + the one sharp idea                       │
        │ "local-first journal; the device is canonical, cloud  │
        │  is a mirror that catches up"                         │
        └───────────────────────────────────────────────────────┘
              │  if they nod / ask for more
              ▼
   30s  ┌───────────────────────────────────────────────────────┐
        │ + the shape: what you write, what the AI does,        │
        │   where the data lives                                │
        └───────────────────────────────────────────────────────┘
              │  if it's "tell me about a project"
              ▼
   90s  ┌───────────────────────────────────────────────────────┐
        │ + the problem → the architecture → the one hard call  │
        │   → what you'd change.  Ends on a hook they can       │
        │   pull (the AI chains, the sync engine, the RLS       │
        │   incident) — you choose what they grab next.         │
        └───────────────────────────────────────────────────────┘
```

The skill isn't memorizing three paragraphs. It's stopping at the length they asked for, and ending the 90-second version on a hook *you* want them to pull.

---

## The 10-second pitch

┌─────────────────────────────────────────────────────────────────────┐
│ "What have you been working on?"                                    │
│   → they want a one-liner to decide if it's worth more time         │
└─────────────────────────────────────────────────────────────────────┘

**Your answer (speakable, ~10s):**

"buffr — a local-first daily-journaling app for Android. The interesting part is the data model: the device's SQLite is the source of truth, and the cloud is a mirror that catches up in the background. The app works fully offline because the network is never on the read path."

▸ That's it. Stop talking. The phrase "never on the read path" is bait — a good interviewer pulls on it.

┃ "The device is canonical; the cloud is a mirror that catches up."

---

## The 30-second pitch

┌─────────────────────────────────────────────────────────────────────┐
│ "Give me the overview."                                             │
│   → they want the shape: domain, AI role, data flow — enough to     │
│     decide where to drill                                           │
└─────────────────────────────────────────────────────────────────────┘

**Your answer (~30s):**

"buffr is a daily-vlogging journal — you write a freeform entry, and the app extracts structured records from inline markers in the prose: `[]` becomes a todo, `#tag` attributes the entry to a project thread. Five single-purpose AI chains do the composition — they summarize the day, generate caption variants, classify and expand todos. All of that runs against local SQLite, which is canonical. A debounced background push mirrors to Supabase Postgres five seconds after you stop typing. The whole thing is built so that losing the network degrades nothing the user can see."

▸ Notice the three beats: what you write (prose + markers), what the AI does (5 chains), where it lives (local-canonical, cloud-mirror). Three beats, thirty seconds.

---

## The 90-second pitch

This is the one that matters. It's a small story: the problem, the architecture that answers it, the one hard call, and what you'd change. It ends on a hook.

┌─────────────────────────────────────────────────────────────────────┐
│ "Tell me about a project you're proud of."                          │
│   → they're testing: can you frame a system, name a real tradeoff,  │
│     and stay honest about its limits — all without rambling         │
└─────────────────────────────────────────────────────────────────────┘

**Your answer (~90s):**

"buffr is a daily journaling app I built solo in React Native. The product idea is simple — you write a freeform entry every day — but I wanted it to feel instant and work anywhere, including with no signal. So the architecture is local-first: SQLite on the device is the canonical store, every read and write hits it synchronously in under five milliseconds, and a background job mirrors changes to Supabase Postgres on a five-second debounce after you stop typing.

On top of that, there's a 'drops' layer — the app scans your prose for inline markers and derives typed records: `[]` lines become todos, `#tag` mentions attribute the entry to a project thread, `** food 200 kcal` lines become nutrition rows. The prose is canonical; the derived records get rebuilt from it at commit time. And five AI chains handle composition: summarizing the day, generating four tonal caption variants, classifying each todo into a thinking-mode type, expanding it, and writing a long-form reflection. They're provider-agnostic — Anthropic primary, OpenAI behind a one-line toggle.

The hardest call was conflict resolution for sync. I went with last-write-wins by timestamp, which is correct for a single-user app and silently wrong the day there are two concurrent writers — so I documented exactly where that breakpoint is. If I were taking it multi-user, that's the first thing I'd replace, with CRDTs on the prose layer."

▸ That last sentence is the hook. You've handed them three threads to pull — the AI chains, the sync engine, the LWW breakpoint — and named the one you're most ready to defend. You're steering.

┃ "I went with last-write-wins — correct for one writer, silently wrong for two. I documented exactly where that breaks."

### Strong vs weak: the 90-second open

| Weak pitch | Strong pitch |
|------------|--------------|
| "It's a journaling app with some AI features and cloud sync." | "It's local-first: SQLite is canonical, the cloud is a mirror that catches up." |
| Lists features flatly (journal, todos, nutrition, vlogs, threads...) | Names the *organizing idea* (prose-canonical drops) and lets features hang off it |
| Ends on "...and that's basically it." | Ends on a named tradeoff + what you'd change — a hook they pull |
| "I used a lot of modern tools." | "Anthropic primary, OpenAI behind a one-line toggle — provider-agnostic at the chain boundary." |

The weak column isn't wrong — it's *flat*. It gives the interviewer nothing to grab, so they invent their own (harder) questions. The strong column hands them the threads you want them to pull.

---

## Follow-ups the pitch invites

```
   after the 90s pitch, the likely pulls:

   "Why local-first?" ───────────▶ Ch 3 (the choices). One line now:
        │                          "instant reads + offline; the cost is
        │                          a sync engine and a staleness window."
        │
   "Walk me through the sync." ──▶ Ch 2 (architecture) + Ch 3. One line:
        │                          "two independent flows — push and pull —
        │                          over a dirty-row filter."
        │
   "Tell me about the AI chains."▶ Ch 3 + the AI question (Ch 8). One line:
        │                          "five single-purpose chains, not one
        │                          mega-prompt — errors isolate."
        │
   "LWW — isn't that lossy?" ────▶ Ch 5 (failure) + Ch 7. One line:
                                   "yes, on concurrent writes. Single-user
                                    today; CRDT is the multi-user answer."
```

Whatever they pull, you have a one-liner that buys you the time to give the real answer. The pitch's job was to get you here.

---

╔═══════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY — when they ask for the user numbers          ║
║                                                                       ║
║ The pushback: "How many users does it have? What's your retention?"   ║
║                                                                       ║
║ Say: "It's a solo project with one real user — me. I built it to      ║
║ exercise a local-first architecture end-to-end, not to chase          ║
║ adoption. So I can't give you retention curves, but I can tell you    ║
║ exactly what would break the day it had a thousand users — that's     ║
║ the more interesting question and I've thought about it."             ║
║                                                                       ║
║ Why this works: it refuses the framing that a portfolio project       ║
║ needs a user base, and redirects to the systems thinking they         ║
║ actually want to assess. Pivots to Chapter 4.                         ║
║                                                                       ║
║ Do NOT say: "Oh, it's just a personal project" (apologetic, shrinks   ║
║ the work) or invent usage numbers (instant credibility death).        ║
╚═══════════════════════════════════════════════════════════════════════╝

---

## What you'd change about the pitch

The current pitch leads with architecture because that's buffr's strongest signal for a systems interview. But if you're interviewing for an **AI product** role, flip the open: lead with the five-chain composition layer and the heuristic-before-LLM cost discipline, and let the local-first architecture be the supporting act. Same facts, reordered for the room. The mistake would be using the systems-first pitch in an AI-product interview — you'd bury your most relevant signal under sync-engine details they don't care about.

---

## One-page summary — Chapter 1

**Core claim:** buffr is a local-first journal where the device is canonical and the cloud is a mirror; the pitch leads with that idea, not a feature list.

**Questions, one-line answers:**
- *"What are you working on?"* → "Local-first Android journal; device is canonical, cloud is a mirror that catches up."
- *"Give me the overview."* → prose + inline-marker drops → 5 AI chains → local SQLite canonical, debounced Supabase mirror.
- *"Tell me about a project."* → problem (instant + offline) → architecture (local-first) → hard call (LWW conflict) → what you'd change (CRDT for multi-user).
- *"How many users?"* → "One — me. I can tell you what breaks at a thousand, which is the better question."

**Pull quotes:**
- ┃ "The device is canonical; the cloud is a mirror that catches up."
- ┃ "I went with last-write-wins — correct for one writer, silently wrong for two."

**What you'd change:** For an AI-product role, flip the pitch to lead with the five-chain composition layer; keep the systems-first open for infra/backend rooms.
