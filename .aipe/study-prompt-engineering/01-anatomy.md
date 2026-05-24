# Anatomy of a production prompt

**Industry name(s):** Prompt anatomy, prompt structure, system / context / few-shot / user decomposition
**Type:** Industry standard · Language-agnostic

> A production prompt has four sections, each with one job. Mix them and the prompt drifts; separate them and you have one place to change each kind of thing.

**See also:** → [02-structured-outputs](./02-structured-outputs.md) · → [03-prompts-as-code](./03-prompts-as-code.md) · → [13-forbidden-patterns](./13-forbidden-patterns.md)

---

## Why care

### Move 1 — The grounded scenario

You're staring at a prompt that worked yesterday and doesn't today. It's one 200-line string in a `.ts` file. Some of it is general instructions ("you are a helpful classifier"), some of it is examples, some of it is per-call data (today's date, the user's text), some of it is "respond with one of these labels," and some of it is "and don't be too brief." You changed one line — added a new label to the list — and the model started ignoring the existing labels and returning the new one for everything. Reverting is one git operation; understanding why the change broke things requires reading the whole 200-line string and guessing which section the new line interacted with.

### Move 2 — Name the question the pattern answers

That blast-radius question is what prompt anatomy answers. Not "what's the right tone," not "how do I phrase the instruction" — just *which section does this line belong in, so that a change here only affects this section.* Four sections, each with one job. The same shape every framework eventually converges on: system prompt (the constant rules), context (per-call data), few-shot examples (input/output pairs that demonstrate the shape), user message (the actual request).

### Move 3 — Why answering that question matters

**What breaks without it:** the prompt becomes a string nobody can change safely. In buffr's `src/services/ai/caption.ts`, the prompt is currently 200+ lines that mix the four roles. Add a new label to the classifier? It interacts with a forbidden-patterns clause buried 80 lines deep. Change the date format in context? You discover three weeks later that one of the few-shot examples hardcoded the old format and the model has been quietly copying it. The four-section decomposition isn't aesthetic preference — it's the difference between "I can change the rules without rewriting the examples" and "every change risks every other behaviour."

### Move 4 — Concrete before/after

Without the anatomy (one 200-line string):
- New label `'reduce'` added to the list
- Buried 80 lines later: "Always prefer one of {todo, idea, knowledge, study, reflect}" — a forbidden-pattern reminder
- Model gets two contradictory signals (new label allowed; only the old five allowed) and picks the more recent one (recency bias toward the new label)
- 60% of classifications become `'reduce'` for a week before anyone notices

With the anatomy (four named sections):
- New label `'reduce'` added in **system** ("you classify into one of: todo, idea, knowledge, study, reflect, reduce")
- Forbidden-pattern reminder lives in **system** too — the writer updates both in the same edit because they're co-located
- Examples in **few-shot** are checked: the new label needs at least one example
- Per-call user text lands in **user message**, untouched
- The change is reviewable: a PR diff shows two adjacent edits in one section

### Move 5 — The one-line summary

The anatomy is the same shape as a React component file: props at the top, state next, derived values, render — each section answers one question and you don't reach across them. Mix them and the component becomes unreadable; the same is true of prompts.

---

## How it works

### Move 1 — The mental model

A prompt is four named buckets that get concatenated by the SDK at call time. The buckets exist in the request shape (`messages: [{role: 'system', content: '…'}, {role: 'user', content: '…'}]`), not in the prompt text itself — meaning if you put a system-level rule inside the user message because it was "easier," the SDK still sends one user message, and the model sees a user asking it to behave a certain way (which it weighs less than a system instruction).

```
   prompt request
   ┌────────────────────────────────────┐
   │ messages: [                        │
   │   { role: 'system', content: ... } │  ◄── constant across calls
   │   { role: 'user',   content: ... } │  ◄── per-call data
   │ ]                                  │
   │ tools: [ ... structured outputs ]  │
   └────────────────────────────────────┘
```

That two-role API is what the four sections collapse into at the wire level: system carries the constants; user carries everything per-call (context + examples + the actual request), composed in that order. The composition is conventional, not enforced by the API — discipline lives in the codebase.

### Move 2 — The four sections

**System prompt** — the constant rules. Names what the model is, what it can output, what it must never do. This is the section the provider weighs most heavily for instruction-following.

The shape inside the system prompt:

```
You are a {role}.
You output {format}.
You must follow these rules:
  1. {rule}
  2. {rule}
You must never:
  - {forbidden pattern}
  - {forbidden pattern}
```

If you're coming from frontend: this is the file-level constant block at the top of a module — declarations that don't change per render. Concrete consequence: when buffr's `classify` chain ships a new thinking mode, the change goes in the system prompt's "you classify into one of" list. The user message stays "Classify this todo: {text}" forever.

**Context** — per-call data the model needs to do its job. Today's date, the user's previous entries (for caption variants that reference yesterday), the retrieved knowledge for RAG, the current todo's metadata. Lives in the user message, conventionally wrapped in delimiters so the model knows where data ends and the request begins.

```
<context>
  date: 2026-05-24
  yesterday_summary: "Long day. Shipped the schema migration. Lots of red builds."
  current_todo: {"id": "abc", "text": "follow up on PR review"}
</context>
```

If you're coming from frontend: this is props — different every render but the component signature is stable. The system prompt is the component definition; the context is `<Component data={...} />`.

**Few-shot examples** — input/output pairs that demonstrate the shape. Three to five good ones beat twenty mediocre ones. Examples constrain output more than instructions do — see [08-few-shot](./08-few-shot.md). Lives in the user message, after context, before the request.

```
Examples:
  Input:  "[] follow up on PR review"
  Output: {"type": "todo"}

  Input:  "[] understand how Postgres RLS interacts with row-level grants"
  Output: {"type": "study"}
```

In the OpenAI / Anthropic conventions, these can also be modelled as a synthetic assistant-turn — `{role: 'user', content: 'Input: ...'}, {role: 'assistant', content: 'Output: ...'}` repeated. Both shapes work; the inline-in-system approach is easier to version-control. Boundary: if the few-shot examples ever reference per-call data ("Yesterday you said X — classify today's…"), they've leaked into context and need to move.

**User message** — the actual request. Stays short. References context by name, references examples by structure. "Now classify: {current_todo.text}" not "Now please classify the following todo for me, being sure to follow the rules I gave above and considering the examples and please be concise."

The boundary that makes the anatomy work: each section can be edited without re-reading the others, **if the contract between them holds**. The system prompt declares the schema; few-shot demonstrates it; user message uses it. Break the contract (rename a field in system, forget to update an example) and the prompt regresses.

### Move 2.5 — Current state vs future state

In buffr today, the four sections are conceptually present but not always physically separated — `summarize.ts`, `caption.ts`, `expand.ts`, `classify.ts`, `interpret.ts` each carry the prompt as a single template-literal string with the section boundaries implied by whitespace and comments.

```
        Now (buffr)                           Later (refactored)
┌──────────────────────────────┐  ┌──────────────────────────────┐
│ caption.ts                   │  │ caption/                     │
│   const prompt = `           │  │   prompt.system.md      ←    │
│     [system stuff…]          │  │   prompt.context.ts     ←    │
│     [context stuff…]         │  │   prompt.examples.md    ←    │
│     [examples…]              │  │   prompt.user.ts        ←    │
│     [user request…]          │  │   index.ts                   │
│   `;                         │  │     compose(system,          │
│                              │  │             context(date),   │
│                              │  │             examples,        │
│                              │  │             user(entry))     │
└──────────────────────────────┘  └──────────────────────────────┘
   one string per chain               four files per chain;
   changes blast across sections      each section editable alone
```

The schema didn't have to change between phases — the wire-level request shape (`messages: [system, user]`) is identical either way. What changes is the codebase's ability to edit one section without touching the others.

### Move 3 — The principle

The four-section decomposition is the same principle every well-organized codebase eventually adopts: locality of change. The prompts that survive production aren't the cleverest — they're the ones where adding a new label, fixing a forbidden pattern, or swapping an example is one obvious edit in one obvious place. Anatomy is the thing that makes that obviousness possible.

The full picture is below.

---

## Anatomy — diagram

```
┌─ Wire layer (provider API) ─────────────────────────────────────────────┐
│                                                                          │
│   messages: [                                                            │
│     { role: 'system', content: <SYSTEM> },                               │
│     { role: 'user',   content: <CONTEXT> + <EXAMPLES> + <USER REQUEST> } │
│   ]                                                                      │
│   tools / response_format: <SCHEMA>          ◄── concept 02              │
└──────────────────────────────────────────────────────────────────────────┘
                            ▲
                            │  composed at call time
                            │
┌─ Authoring layer (codebase) ────────────────────────────────────────────┐
│                                                                          │
│   SYSTEM      — constant: role, output format, rules, forbidden patterns │
│   CONTEXT     — per-call: date, retrieved data, current entity           │
│   EXAMPLES    — input/output pairs demonstrating the schema              │
│   USER        — the actual request, short, references context + examples │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
                            ▲
                            │  edited independently
                            │
┌─ Engineer ──────────────────────────────────────────────────────────────┐
│   "Add a new thinking-mode label" → edit SYSTEM + add one EXAMPLE        │
│   "Fix a forbidden phrasing"      → edit SYSTEM                          │
│   "Add yesterday's summary"       → edit CONTEXT                         │
│   "Change the user-facing ask"    → edit USER                            │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Buffr's 5 chains** all carry the anatomy implicitly in one template-literal string per file:

**File:** `src/services/ai/caption.ts`
**Function / class:** `caption(entryText, date, yesterdaySummary)`
**Line range:** L1–L223 (the whole file; the prompt template starts around L60 and runs to L150)

**File:** `src/services/ai/classify.ts`
**Function / class:** `classify(todoText)`
**Line range:** L1–L160 (prompt template inline)

**File:** `src/services/ai/summarize.ts`
**Function / class:** `summarize(date)`
**Line range:** L1–L188 (prompt template inline)

**Aipe's templates** carry the anatomy as separate sections within a single markdown file — see `/Users/rein/Public/aipe/specs/study.md` for the canonical example. The study spec itself is a production prompt; its system-level rules ("the per-concept template," "the voice"), context (the codebase being studied), examples (worked-example blocks), and user request ("generate the guide") are all visible as named sections in the file.

---

## Elaborate

### Where this pattern comes from
The system/user split is structural to chat-completion APIs and dates back to the original ChatGPT API in early 2023. The few-shot-examples-in-user convention emerged from the OpenAI cookbook in mid-2023 and stabilised when Anthropic published its prompt engineering guide. The four-section naming is industry-converged; different teams call them different things (some call "context" "background" or "data"), but the boundaries are the same.

### The deeper principle
Locality of change. The four sections exist so that each kind of change (new rule, new piece of data, new example, new request shape) has one place to live. A prompt without anatomy is a function without parameters: technically it works, but every edit is a rewrite.

### Where this breaks down
Single-purpose chains so simple that anatomy is overkill — a one-line classifier that takes a string and returns a label doesn't need a separate context section because there's nothing per-call besides the input itself. Anatomy earns its keep at 3+ rules, 2+ context fields, or any few-shot examples.

### What to explore next
- [02-structured-outputs](./02-structured-outputs.md) — the schema lives in the SDK call alongside the four sections; it constrains what the user-message can return.
- [13-forbidden-patterns](./13-forbidden-patterns.md) — forbidden-pattern lists belong in the system section; if they're not there, they're scattered through the user message and forgotten.
- [03-prompts-as-code](./03-prompts-as-code.md) — extracting the four sections into separate files is the structural payoff of the anatomy concept.

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬───────────────────────────┐
│ Cost dimension   │ Anatomy (4 sections)      │ One string per chain      │
├──────────────────┼───────────────────────────┼───────────────────────────┤
│ Edit time        │ Targeted; one section     │ Re-read the whole string  │
│ Diff readability │ Section labels in PRs     │ Diff is "prompt changed"  │
│ Cognitive load   │ 4 small mental models     │ 1 big mental model        │
│ Files / chain    │ 4–5 (or 1 sectioned file) │ 1 string                  │
│ Onboarding       │ New contributor: 15 min   │ New contributor: 1 hr     │
│ Drift over time  │ Bounded per section       │ Compounds across whole   │
└──────────────────┴───────────────────────────┴───────────────────────────┘
```

### What we gave up

The cost of the anatomy is files-per-chain and a small amount of indirection — to read a prompt end-to-end you open four files (or four sections of one file) instead of one. The buffr-style "one template literal per chain" is the cheapest possible shape for two reasons: every chain is in one file you can open with one click, and the SDK call lives next to the prompt so the round-trip from "edit prompt → see request" is short. That cost reverses the moment you change anything non-trivial; the first time you have to re-read 200 lines to figure out where to add a new rule, you've paid more than the four-file structure would have cost in the first place.

### What the alternative would have cost

The current "one string per chain" approach has paid off so far because buffr has stayed small — five chains, each authored by one person, each evolving slowly. If you had separated the four sections from day one, the up-front cost would have been three extra files per chain (15 extra files across the five), one composition function per chain, and a small mental tax on anyone reading a chain end-to-end. The avoided cost (a future hour debugging why a new label interacts with a buried forbidden-pattern clause) would have been invisible until it happened.

### The breakpoint

Fine until any one prompt crosses ~150 lines, or until two different concerns (a new label vs a tweak to forbidden patterns) need to be edited together and a reviewer can't tell from the diff which is which. Buffr's `caption.ts` is past 200 lines; the breakpoint has been crossed but the cost is still being paid in small one-time edits rather than a large incident.

---

## Tech reference (industry pairing)

### Anthropic Messages API

- **Codebase uses:** `@anthropic-ai/sdk` `messages.create()` in buffr's 5 chain files; system prompt passed as the `system` parameter, user message as a single `messages: [{role: 'user', content: ...}]` entry.
- **Why it's here:** the API enforces the two-role minimum (system + user); the four-section authoring discipline composes into that shape at call time.
- **Leading today:** Anthropic Messages API + Anthropic SDK — `adoption-leading` for high-quality production prompt work, 2026.
- **Why it leads:** explicit system parameter (not just a system-role message); structured tool calling with strict schemas; prompt caching keyed on prefix; thinking-mode access.
- **Runner-up:** OpenAI chat completions — `adoption-leading` for wider integration; system role is a regular message, slightly more brittle for instruction hierarchy enforcement.

### OpenAI chat completions

- **Codebase uses:** raw `fetch` to `https://api.openai.com/v1/chat/completions` in buffr's 5 chain files (alternate provider).
- **Why it's here:** the second of two providers; system message is `{role: 'system', content: ...}` instead of a top-level parameter.
- **Leading today:** OpenAI chat completions — `adoption-leading` for breadth, 2026.
- **Why it leads:** broadest model selection; `response_format: { type: 'json_object' }` for structured-output mode; longest history of stable behaviour.
- **Runner-up:** Anthropic — see above.

---

## Project exercises

### B3.1 — Extract a buffr chain's prompt into four named sections

- **Exercise ID:** `[B3.1]`
- **What to build:** pick `caption.ts` (the longest chain). Extract its single template-literal prompt into four named constants: `CAPTION_SYSTEM`, `CAPTION_CONTEXT_FORMAT` (a function), `CAPTION_EXAMPLES`, `CAPTION_USER_FORMAT`. Compose them at call time inside a `buildCaptionPrompt(entryText, date, yesterdaySummary)` helper. Keep the wire-level request shape identical; verify the same prompt text is produced.
- **Why it earns its place:** the act of extracting forces you to discover which lines were genuinely system-level vs which were context-leaked or user-leaked. The first 30 minutes of the exercise teaches more about prompt anatomy than reading any blog post.
- **Files to touch:** `src/services/ai/caption.ts`. Optional: a tiny `src/services/ai/captionPrompt.ts` if you want to move the constants out of the call file.
- **Done when:** `npx tsc --noEmit` passes and a fresh sync run produces caption output identical to what the device showed yesterday (verify by diffing the captions on today's entry with both the old and new code paths).
- **Estimated effort:** 1–4hr.

### B3.2 — Add an inline diagram comment block at the top of one chain

- **Exercise ID:** `[B3.2]`
- **What to build:** add a comment block at the top of `caption.ts` that names the four sections explicitly with what each contains. This is half-step toward extraction — it labels the implicit anatomy so the next contributor knows the structure even if you don't refactor yet.
- **Why it earns its place:** the cheap version of B3.1. Gets you 60% of the readability benefit at 5% of the cost. Worth doing on every chain before deciding which to fully extract.
- **Files to touch:** all five chain files in `src/services/ai/`.
- **Done when:** every chain file starts with a `// SYSTEM: … / CONTEXT: … / EXAMPLES: … / USER: …` comment block describing its anatomy in 8–12 lines.
- **Estimated effort:** <1hr.

---

## Summary

### Part 1 — concept recap

A production prompt has four sections — system (the constants), context (per-call data), few-shot examples (input/output pairs), user message (the actual request) — and the SDK collapses them into the two-role wire shape `{system, user}` at call time. Buffr's five chains carry the anatomy implicitly in single template-literal strings of 150–220 lines each; the discipline is present in spirit but not yet enforced in code. The constraint forcing this concept is locality of change: prompts that survive production are the ones where each kind of edit (new rule, new datum, new example) has one obvious place to land. The cost being paid for the current shape is that the first hard refactor in any chain (adding a label that interacts with a buried forbidden-pattern clause) costs more than the up-front separation would have.

### Part 2 — key points to remember

- The wire-level API is two roles (system + user); the four sections are an authoring convention that composes into that shape.
- System is constant across calls; user holds context + examples + request, in that order.
- Few-shot examples constrain output more than instructions do — see [08-few-shot](./08-few-shot.md).
- A prompt past 150 lines without internal structure is a prompt one edit away from a regression.
- The decomposition is the same principle as locality-of-change in any well-organized code: each kind of edit gets one obvious place.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "how do you structure a production prompt," they're probing whether you've shipped real LLM features or just played with the chat UI. The right answer names the four sections, ties them to the wire-level two-role API, and gives a concrete example of a bug that anatomy would have prevented. The wrong answer talks about "best practices" without showing you've ever had to change a prompt under pressure.

### Likely questions

**Q [mid]:** How do you decide whether a line of a prompt goes in the system prompt vs the user message?

**A:** The test is whether the line changes per call. System is constant — role, output format, rules, forbidden patterns. User is per-call — context fields like today's date, retrieved data, the actual request. If a line names a specific user's data, it goes in user. If it names what the model should always do, it goes in system. The wire-level API enforces nothing; this discipline lives in the codebase. In buffr's classify chain, "you classify thinking modes into one of {todo, idea, knowledge, study, reflect, reduce}" is system; "Classify this todo: {currentTodo.text}" is user. Swap them and the model's instruction-following weakens.

```
   line                          → section
   ───────────────────────────────────────
   "you are a classifier"        → system
   "labels: todo/idea/study"     → system
   "never invent labels"         → system
   "today: 2026-05-24"           → context (user)
   "the todo: ..."               → user request
```

**Q [senior]:** Buffr's prompts are 200-line template literals today. Why haven't you extracted them into separate files yet?

**A:** Because the cost hasn't bit hard enough yet. Five chains, one author, slow evolution — the "one file per chain" cost has been smaller than the 15-extra-files cost an extraction would carry. The breakpoint is the first time I have to add a feature that requires editing two sections of the same chain together and a code reviewer can't tell from the diff which is which. I'd say `caption.ts` crossed that breakpoint about a month ago when the 4-variant rotation logic landed; I haven't paid the refactor cost yet because no individual change has been painful enough to force it. It's deferred debt, not absent debt.

```
   what extraction buys         what extraction costs
   ────────────────────────     ─────────────────────────
   per-section diffs            +3 files per chain
   reviewable edits             +1 composition function
   onboarding clarity           small indirection
   ─────                        ─────
   value compounds              cost is one-time
```

**Q [arch]:** What happens to this anatomy when chains stop being single calls and become agent loops?

**A:** The four sections become *per-step* sections, plus a new layer above — the agent loop's own system prompt (what the loop is trying to accomplish) and its memory layer (what previous steps have done). Each tool call inside the loop has its own four-section anatomy; the loop orchestrates them. The wire-level shape changes — `messages` becomes a multi-turn history with tool calls and tool results interleaved — but the per-call anatomy stays the same. The risk at 10× scale is that the loop's "memory" layer becomes a context fire hose that starves the per-call user message of tokens; lost-in-the-middle gets worse the longer the conversation goes. See [04-token-budgeting](./04-token-budgeting.md).

```
   single call                   agent loop
   ────────────                  ──────────
   [system]                      [loop-system]
   [user]                        [step 1: system + user + tool call]
   ─────                          ⮡ [tool result becomes context]
                                 [step 2: system + user + tool call]
                                 ─────
   1 four-section anatomy        N four-section anatomies + 1 loop frame
                                 breaks first at step ~10 (context bloat)
```

### The question candidates always dodge

**Q:** Your prompts are inline in TypeScript files as template literals. That means non-engineers can't edit them. How is that a defensible choice?

**A:** It isn't, fully. The cost is that the PM can't tweak a tone instruction without filing a PR or asking an engineer. The benefit is that every prompt change goes through code review and gets paired with the model version it was validated against. Buffr is a solo-developer codebase right now, so "non-engineers can't edit" is a hypothetical cost — the developer is the PM. The day a real PM joins, the right move is to extract prompts into markdown files (one per chain) and give the PM read+edit access via a docs-style PR flow. That's a 2-day extraction, not a 2-month rewrite, because the anatomy already separates per-call data from constant rules — only the constant rules need to move.

```
   what was picked                 what the PM-edit world looks like
   ───────────────                 ─────────────────────────────────
   prompts in .ts                  prompts in .md (system + examples)
   inline template literals        composed at call time from .md
   engineer edits in PR            PM edits via docs-style PR
   ─────                           ─────
   cost: PM-edit gated by engineer cost: 2-day extraction
   benefit: type-safe composition  benefit: prompt iteration unblocked
                                            for non-engineers
```

### One-line anchors

- Four sections, two wire roles. The discipline lives in your authoring code, not the API.
- System is constant. User is per-call. Mix them and the model weighs your instructions less.
- A 200-line prompt without internal structure is one edit away from a regression.
- The anatomy is the prompt-engineering equivalent of "props at the top, render at the bottom."
- Extracting the four sections into files is the structural payoff of taking prompt engineering seriously as code.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Close this file. Draw the two-layer diagram from memory: the wire layer (provider API with `messages: [system, user]`), the authoring layer (the four sections), and the engineer's perspective (which kind of edit lands in which section). Label every box.

Open the file. Compare.

✓ Pass: your diagram names all four sections and ties them to the two-role wire shape
✗ Fail: re-read the diagram section, wait 10 minutes, try again

### Level 2 — Explain it out loud

Explain prompt anatomy to a colleague who just asked "how do you structure a production prompt?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the four sections by what they contain (system / context / examples / user)?
- Tie them to the wire-level two-role API?
- Name a specific consequence of mixing sections (the buried-forbidden-pattern bug)?

If you skipped any: you described the structure, you didn't explain it.

### Level 3 — Apply it to a new scenario

A new requirement lands for buffr's `expand` chain: when expanding a todo of type `knowledge`, the prompt should include the user's three most recent journal entries on related topics (a retrieval pass) so the expansion feels in-context to the user's writing voice.

Without looking at the file: which section does the retrieved-entries data go in? Where do the rules about *how* to use it ("be in the user's voice, don't quote them verbatim") go? What changes about the few-shot examples? What stays the same?

Write your answer (3–5 sentences). Then open `src/services/ai/expand.ts` and check whether your answer matches how the chain is actually structured today.

### Level 4 — Defend the decision you'd change

Pick the biggest tradeoff in the Tradeoffs section. Answer in writing:

"If you were starting buffr today with the same constraints (solo dev, fast feature iteration, no PM yet), would you make the same decision to keep prompts as inline template literals? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the code:
- Point to `src/services/ai/caption.ts` (the longest chain) for the current shape.
- Point to what `caption.ts` would look like if the four sections were extracted.

### Quick check — code reference test

Without opening any files, answer:
- Which file holds buffr's caption chain?
- What's the function name?
- How many lines is the prompt template approximately?

Then open the file and verify.
