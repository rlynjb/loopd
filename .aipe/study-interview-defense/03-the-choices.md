# Chapter 3 — The choices

"Why did you use X?" is where most candidates lose the senior signal. The weak answer names a benefit ("SQLite is fast"). The strong answer names the *alternative you rejected*, the *criterion that decided it*, and the *cost you're paying*. A choice without a named alternative isn't a decision — it's a default, and interviewers can smell the difference.

buffr has five load-bearing choices worth defending. The CSS approach and the test runner aren't on this list — nobody senior cares, and bringing them up wastes the room's attention. The five that carry weight: the storage model, the framework, the AI provider strategy, the auth gate, and the conflict-resolution rule. For each, you need three things ready: what else you could have picked, what tipped it, and what it costs.

```
   EVERY CHOICE, SAME SHAPE — this is the template for all five

   ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
   │ what you     │     │ what decided │     │ the cost     │
   │ picked       │ ──▶ │ it           │ ──▶ │ you're       │
   │ + the        │     │ (the         │     │ paying       │
   │ alternative  │     │ criterion)   │     │ (named, not  │
   │ rejected     │     │              │     │  hidden)     │
   └──────────────┘     └──────────────┘     └──────────────┘

   "I picked A over B because criterion C mattered most here,
    and I'm paying cost D for it."
```

If every answer in this chapter lands in that shape, you'll sound like someone who made decisions, not someone who accepted defaults.

---

## Choice 1 — SQLite canonical + Supabase mirror (not cloud-first)

┌─────────────────────────────────────────────────────────────────────┐
│ "Why is SQLite the source of truth instead of the cloud database?"  │
│   → testing whether you understand the latency/offline tradeoff and  │
│     can name what local-canonical costs you                          │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"Because the product requirement was instant reads and full offline use, and a cloud-canonical design can't give you either. If the cloud is the source of truth, every dashboard render is a network round-trip — 80 to 250 milliseconds on LTE — and the app is dead without signal. With SQLite canonical, reads are sub-five-millisecond and offline is the default, not a feature. The cost is real: I had to build a sync engine — about twelve files in `src/services/sync/` — and every synced row carries two extra columns, `synced_at` and `deleted_at`. Cross-device freshness lags five to ten seconds. For a single-user journal that lag is invisible; for a collaborative doc it would be a bug. I paid the sync-engine complexity to buy instant-and-offline, and for this product that's the right trade."

| Weak answer | Strong answer |
|-------------|---------------|
| "SQLite is fast and works offline." | "Cloud-canonical means a network round-trip per render; I needed sub-5ms reads and offline-by-default, so I paid for a sync engine to get them." |
| Names the benefit only | Names the rejected alternative (cloud-first), the criterion (instant + offline), and the cost (12-file sync layer, staleness window) |

┃ "I paid the sync-engine complexity to buy instant-and-offline. For a single-user journal, that's the trade."

---

## Choice 2 — React Native + Expo (not native Android)

┌─────────────────────────────────────────────────────────────────────┐
│ "Why React Native and Expo instead of native Kotlin?"               │
│   → testing whether you chose for a reason or just used what you knew│
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"I came from seven years of frontend — React and Vue — so React Native let me move fast in a component model I already think in. Expo gave me the native modules I needed without ejecting: `expo-sqlite` for the canonical store, `expo-secure-store` for the API keys in the Android Keystore, EAS for builds. The honest cost is the ffmpeg dependency for vlog export — `@wokcito/ffmpeg-kit-react-native` — which is heavier and more fragile than a native pipeline would be, and it's Android-only. If buffr needed iOS or a tighter media pipeline, native would start to win. It didn't, so the velocity of staying in a model I'm fluent in was worth more than the native ceiling."

▸ This is a case where "I used what I knew" is *actually the right answer* — but you have to frame it as a velocity decision with a named cost (the ffmpeg fragility), not as a comfort-zone admission.

---

## Choice 3 — Anthropic primary, OpenAI behind a toggle (provider abstraction)

┌─────────────────────────────────────────────────────────────────────┐
│ "Why Anthropic? What happens if you want to switch providers?"      │
│   → testing whether you hard-coded a vendor or designed for the swap │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"The five chains are provider-agnostic at the chain boundary — the provider is a one-line toggle in `config.ts`. I use Claude Sonnet 4.6 for the quality-sensitive chains and Haiku 4.5 for the cheap classifier, with GPT-4o and 4o-mini as the alternates. Anthropic is primary because when I A/B'd the summary chain, Sonnet won on tone-tag accuracy — that's an actual eval I ran, not a brand preference. The abstraction earns its keep: I've swapped providers twice, once to A/B and once to move the classifier to Haiku for cost. What I deliberately did *not* hide behind the abstraction is the stuff that's genuinely different per provider — cost-per-token, latency, model character. Those surface in the cost log, because pretending providers are interchangeable is how you ship a regression."

┃ "Anthropic's primary because Sonnet won the tone-accuracy A/B — that's an eval I ran, not a brand preference."

```
   the swap surface — what the abstraction hides vs surfaces

   hidden (swap is a one-line toggle):        surfaced (stays visible):
   ┌────────────────────────────────┐         ┌────────────────────────────┐
   │ auth + request setup           │         │ cost per token             │
   │ tool-call request shape        │         │ p50 latency                │
   │ response parsing               │         │ model character (tone)     │
   └────────────────────────────────┘         │ eval scores per chain      │
                                               └────────────────────────────┘
```

---

## Choice 4 — Composite-PK schema gate (not RLS-only)

┌─────────────────────────────────────────────────────────────────────┐
│ "How do you isolate users? Why not just use Supabase RLS?"          │
│   → testing defense-in-depth thinking, and whether you understand    │
│     why a single runtime gate is fragile                             │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"Two gates with different failure modes. The schema gate is a composite primary key — `(user_id, id)` — on every synced table, so a query for another user's `id` doesn't return a forbidden row, it returns *no row*: the pair doesn't exist in the index. That holds whether or not the user is authenticated. The runtime gate is RLS, which is policy-based and depends on `auth.uid()`. I run defense-in-depth because RLS is a policy and policies have bugs — a bad `USING` clause, an accidental disable. The composite PK doesn't depend on any policy being correct; it depends on the relational model itself.

And I learned that the hard way. RLS got enabled once — the Supabase dashboard nags about disabled-RLS tables and offers a one-click enable — but buffr authenticates with the anon key and no user session, so `auth.uid()` is NULL, and every policy denied every push and pull. Cloud sync silently froze. Because reads are local-canonical, the app felt completely normal while the cloud quietly diverged. I caught it, and migration `0009` re-disabled RLS to restore the Phase A posture. That incident is exactly why I don't lean on RLS alone — the composite PK kept user data structurally isolated the entire time RLS was misconfigured."

▸ This is your best war story in the whole interview. It proves defense-in-depth with a real incident, shows you can debug a silent failure, and demonstrates you understand *why* the redundant gate mattered. Lead with it when they ask about security.

┃ "RLS without real auth doesn't half-work — it fails closed and silent. The composite PK is the gate that doesn't depend on a policy being right."

---

## Choice 5 — Last-write-wins conflict resolution (not CRDT)

┌─────────────────────────────────────────────────────────────────────┐
│ "How do you resolve sync conflicts? Isn't last-write-wins lossy?"   │
│   → testing whether you know LWW's failure mode and chose it anyway  │
│     with eyes open                                                   │
└─────────────────────────────────────────────────────────────────────┘

**Your answer:**

"Last-write-wins by `updated_at`, resolved per-row in `chooseWinner`. And yes — it's lossy on concurrent writes: two devices editing the same row in the same window, one edit silently loses. I chose it anyway because buffr is single-writer today — one user, usually one device — so concurrent same-row writes essentially don't happen. LWW is correct exactly once per row per second, and at single-writer scale that's always. I documented the exact breakpoint: the day there's a second concurrent writer, LWW is wrong, and the answer isn't 'fix LWW' — it's CRDTs on the prose layer, something like Y.js or Automerge, so edits compose deterministically before the scanners run. That replaces `chooseWinner` and leaves the rest of push/pull intact."

| Weak answer | Strong answer |
|-------------|---------------|
| "Last-write-wins — newest timestamp wins." | "LWW by `updated_at`; lossy on concurrent writes, which I accept because it's single-writer. The breakpoint is a second writer; the fix is CRDTs, not patching LWW." |
| Doesn't name the failure mode | Names it precisely (concurrent same-row writes), states why it's acceptable now, and names the migration path |

---

## Follow-up decision tree — the choices chapter

```
   "Why not just use Firebase / a BaaS that does sync for you?"
        ▸ "Then sync is a black box I can't reason about or tune.
           Building it taught me the dirty-filter + LWW + cursor
           mechanics — and let me put the canonical store on-device,
           which most BaaS sync assumes is the cloud."
              │
              ├── "Isn't that reinventing the wheel?"
              │      ▸ "For a single-user app at this scale, the wheel
              │         is ~12 files and I understand every one. A BaaS
              │         would be more code I don't control, not less."
              │
              └── "What would make you switch to a managed solution?"
                     ▸ "Multi-user collaboration. The moment I need CRDT
                        conflict resolution and presence, a managed
                        reactive backend (Convex, Liveblocks) beats
                        hand-rolling it."
```

---

╔═══════════════════════════════════════════════════════════════════════╗
║ "I DON'T KNOW" RECOVERY — pushed on a choice you didn't deeply make    ║
║                                                                       ║
║ The pushback: "Why batch size 50 on the push? Why not 100, or 500?"   ║
║                                                                       ║
║ Say: "Fifty is tuned by feel, not measured — it's small enough that   ║
║ a mid-batch network failure only re-sends fifty rows, large enough    ║
║ to amortize the HTTPS overhead at my row sizes. I haven't load-tested ║
║ it because single-user write volume never stresses it. If I were      ║
║ taking it multi-user, batch size is something I'd actually measure    ║
║ rather than guess."                                                   ║
║                                                                       ║
║ Why this works: it owns the choice as a defaulted-to value (not a     ║
║ measured one), gives the reasoning that *would* justify it, and       ║
║ names the condition under which you'd do the real work. Owning "I     ║
║ didn't measure this" is more senior than inventing a benchmark.       ║
║                                                                       ║
║ Do NOT say: "50 is the optimal batch size" (you'll get asked to       ║
║ prove it) or "I don't remember why" (sounds like you copied it).      ║
╚═══════════════════════════════════════════════════════════════════════╝

---

## What you'd change about the choices

The choice I'd most reconsider is **hand-picked retrieval over RAG** for the AI chains. Right now the expand chain feeds the model recency-based context — sibling todos plus the last three days, capped at ~1000 chars each. That's deliberate (my spec calls it principle #11: "no RAG until provably needed"), and at current corpus size it's correct — embeddings would be overkill. But the moment I add a "interpret my whole week" or "find related entries" feature, hand-picked recency stops being enough and semantic retrieval earns its place. I'd reconsider it not because the current call is wrong, but because the threshold where it flips is close. That's the distinction worth drawing in the room: a choice that's right *now* with a known expiry date is different from a choice that's just right.

---

## One-page summary — Chapter 3

**Core claim:** buffr has five load-bearing choices, each defended with the same shape — alternative rejected, deciding criterion, cost paid.

**The five choices, one line each:**
- *SQLite canonical + Supabase mirror* → cloud-first means a round-trip per render; paid a 12-file sync engine for sub-5ms reads + offline.
- *React Native + Expo* → frontend fluency = velocity; cost is the fragile Android-only ffmpeg pipeline.
- *Anthropic primary + provider toggle* → Sonnet won the tone A/B; abstraction hides the swap, surfaces cost/latency/character.
- *Composite-PK + RLS (defense in depth)* → the PK gate doesn't depend on a policy being right; proven by the 0009 RLS-freeze incident.
- *Last-write-wins* → lossy on concurrent writes, accepted at single-writer scale; CRDT is the multi-user answer.

**Pull quotes:**
- ┃ "I paid the sync-engine complexity to buy instant-and-offline."
- ┃ "RLS without real auth fails closed and silent. The composite PK is the gate that doesn't depend on a policy being right."
- ┃ "Anthropic's primary because Sonnet won the tone A/B — an eval I ran, not a brand preference."

**What you'd change:** Reconsider hand-picked retrieval vs RAG — right now, with a known expiry date (the week-scope/related-entries features), not a wrong call today.
