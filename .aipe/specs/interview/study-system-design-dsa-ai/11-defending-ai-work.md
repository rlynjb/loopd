# Chapter 11 — Defending AI-Assisted Work

## Opening — what's actually being asked

When an interviewer asks "how much of this did the AI write," the literal question is rarely the real question. The real question is: do you understand what's in your own code, did you make the architectural decisions, can you defend the tradeoffs without reading from a script. The lazy candidate answer is "the AI wrote some boilerplate, I wrote the hard parts" — true and useless. The signal-rich answer names exactly what was AI-assisted, exactly what was human-decided, and where the boundary sits.

The boundary in buffr sits at the rules document. Every architectural principle in `docs/spec.md` §10 was a human decision. Every spec under `docs/<feature>-spec.md` was human-authored before any code was written for that feature. Every line of TypeScript in `src/services/` was reviewed by me, modified by me, tested by me on a connected Android device. The AI accelerated implementation; it did not make decisions that survive in the architecture. That's a defensible claim because I can pull up any file and explain why each non-obvious decision is the way it is, and I can pull up the rules document and explain the failure mode behind each principle.

The answers in this chapter are written as talking points, not scripts. The goal is to internalize the framing so I can answer naturally on the call. If I memorize the literal sentences, the interviewer will hear "memorized," which is exactly the wrong signal. Read the points, agree or disagree, then translate to my own voice.

---

## Talking points

### "How much did you write versus how much the AI wrote?"

**The honest framing.** The AI wrote most of the syntax. I wrote all of the rules. The boundary is `.aipe/project/rules.md` and `docs/spec.md` §10 — twelve architectural principles, each one mine, each one tied to a specific failure mode I observed or a specific cost I refused to pay. Beneath those rules, the AI generated TypeScript that satisfies them. I reviewed every diff, modified about a third, kept about two-thirds with minor edits.

**The proof.** Pull up any commit. Read `docs/spec.md` next to the diff. The diff respects the principles. If you ask me "why is this scanner two-pass," I can name principle 7 and explain that it exists because in-place text edits would otherwise destroy the meta row's identity. If you ask me "why does the cloud lag the local DB by 5 seconds," I can name principle 12 and explain why the keystroke path can't depend on the network. Those answers come from the rules I wrote, not from the code the AI generated.

**What to avoid.** Don't claim "I wrote it all" — it's transparently false and the interviewer will catch the inconsistency the moment they ask a syntactic question. Don't claim "the AI wrote it all" — it's also false and signals abdication. The right framing is *boundary*: I owned the decisions, the AI accelerated the typing.

### "How do you know the AI didn't introduce subtle bugs?"

**The honest framing.** I have three lines of defense. TypeScript strict mode catches the largest class of AI-generated bugs (wrong field types, missing properties, null not handled). Manual end-to-end testing on a connected Android device catches the visual and runtime regressions. The architectural rules document catches the deep design errors — if a generated diff doesn't satisfy a rule, I reject it.

**Where the gap is.** I don't have automated tests for the scanners. A subtle two-pass-matching bug that doesn't break the happy path could ship undetected. That's a real risk surface. I named it in chapter 6 as the gap I'd close first if I were investing test infrastructure — property-based tests for the three scanners, because they're pure functions over text and existing rows. I haven't done it because at single-user scale the cost of a regression is bounded. At multi-tenant scale, this would be the first thing I'd build.

**What to avoid.** Don't pretend the testing story is complete. It's not. The right framing is "here's what catches what, here's what doesn't, and here's what I'd add first."

### "Could you have built this without AI?"

**The honest framing.** Yes, slower. The AI accelerated implementation by maybe 3-4×. The architectural decisions, the spec writing, the failure-mode forecasting — none of those benefited from AI acceleration in the same proportion. I'd estimate the project would have taken ~9 months instead of ~3.

**The qualifier.** The thing that did benefit from AI was *breadth*. I learned the FFmpeg API, the Skia text rendering pipeline, the Supabase RPC pattern, the `expo-router` typed-route conventions — all in less time than it would have taken alone. The AI is faster than reading docs front-to-back when I know roughly what I'm looking for. For first-encounter unknowns where I don't know the question, docs are still better.

**What to avoid.** Don't say "no, I couldn't have built this without AI" — it implies dependency in a way that signals weakness. Don't say "yes, I could have built this exactly as well without AI" — it implies the AI added nothing, which is also not true and undersells the productivity multiplier. The right framing is "yes, slower, and I traded velocity for the same architectural quality."

### "What did you do that the AI couldn't have done?"

**The honest framing.** Three things. First, I wrote the rules. The architectural principles weren't proposed by the AI — they were observations I made from past bugs and design failures. Second, I did the integration thinking. Knowing that a new scanner has to fire after an existing scanner because it depends on the existing scanner's output is the kind of cross-file reasoning the AI doesn't do spontaneously. Third, I did the failure-mode forecasting. When I read a proposed implementation, the question I ask is "what breaks?" not "does this satisfy the prompt?"

**The proof.** Look at `user_overridden_type` — it's not a default pattern. The AI didn't propose a permanent lock on classifier output; I proposed it after watching the classifier flip my manual choice on the next commit. Look at the caption call's try/catch firewall — the AI didn't propose decoupling caption failures from structured summary failures; I proposed it after watching the summarize chain fail when the caption timed out. These are observations from running the system, not from reading the code.

**What to avoid.** Don't list things the AI is bad at as if you're better at them on principle. Frame it as "here's what I bring," not "here's what the AI lacks."

### "If I asked you to walk me through any file in this codebase, could you?"

**The honest framing.** Yes. Pick one. If you pick `src/services/todos/scanTodos.ts`, I can walk you through `collectMatches`, the deduplication logic, the two-pass scanner, the orphan-handling for unmatched existing todos, and the reason `sourceLine` is preserved across edits. If you pick `src/services/sync/orchestrator.ts`, I can walk you through `pushAll` and `pullAll`, the per-table try/catch isolation, the sync_meta error reporting, and the reason `pushOrder` differs from `pullOrder`. If you pick `src/services/ai/caption.ts`, I can walk you through the input shape (`CaptionInput`), the forbidden-pattern list, the failure firewall back to `summarize.ts`, and the reason the structured summary's `summary` field is the fallback for the overlay body.

**The qualifier.** There are files I'd hesitate on. `src/services/ffmpegCommand.ts` has FFmpeg flags I'd have to look up the meaning of mid-call — that's a domain-specific surface where I've memorized the working command and not the full FFmpeg vocabulary. I'd be honest about that boundary on the call.

**What to avoid.** Don't claim total fluency on every file. Some surfaces (FFmpeg, Supabase RPC, Skia text rendering) are deep specialty domains where I know the working configuration and not the full surface area. Naming that boundary is more credible than pretending it doesn't exist.

### "Where in this codebase did the AI get something wrong, and what did you change?"

**The honest framing.** Several places, three patterns recur. First, the AI defaults to optimistic UI everywhere even when the local DB write is the durability point — I had to roll back several "set state, then write" patterns to "ref + write, then state." Second, the AI generates `try/catch` around everything including paths that can't fail; I removed many of those because they hide intent. Third, the AI proposes feature-flag boilerplate for hypothetical future requirements — I deleted those because they're premature complexity.

**The pattern.** The AI is helpful at the line level and below. It writes correct, idiomatic TypeScript with proper imports, type narrowing, and JSX. It is *unhelpful* at the architectural level when not given strong constraints — it defaults to defensive patterns (try/catch everywhere, feature flags everywhere, abstraction layers everywhere) that look professional but cost reading-time without buying anything. The fix is the rules document: it constrains the AI's defaults to match the project's architectural choices.

**What to avoid.** Don't trash-talk the AI as if to prove your worth. The interviewer knows it's a tool. Frame the answer as "here's where the tool's defaults didn't match my architecture, and here's how I corrected it."

---

## The structural meta-question

> *"How would you handle a junior engineer who used AI the way you did?"*

Different question, same shape. The answer is: the same way I handled myself. Require the architectural decisions to be human-authored. Require a spec before any non-trivial feature. Review every diff. Run the project's rules document as the test contract. Pair-program on the first three features so the rules become muscle memory. The AI is a productivity multiplier, but it multiplies whatever discipline you bring; if you bring "vibe coding," the AI multiplies that and you ship something fragile. If you bring "rules-driven implementation," the AI multiplies that and you ship something defensible.

The thing I would not accept: a junior engineer who can't explain a piece of their own code. That's the failure mode the interview question "how much did the AI write" is sniffing for. The mitigation is to require that every PR description name the architectural choices and the failure modes considered. If they can't write that, they didn't make the decisions, and the AI made the code without supervision. That's the line.
