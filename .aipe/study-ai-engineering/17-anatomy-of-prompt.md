# Anatomy of a production prompt

**Industry name(s):** Production prompt structure, system-prompt anatomy, prompt scaffolding
**Type:** Industry standard · Language-agnostic

> The four-section shape — role / task / constraints / output — that every chain in this codebase uses, with the user message carrying only the per-call payload.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [16-structured-outputs](./16-structured-outputs.md) · → [18-forbidden-patterns-rotation](./18-forbidden-patterns-rotation.md)

---

You've got a React component file with 200 lines of code all in one function — props read at the top, state hooks scattered through the body, effects mixed in with handlers, JSX returned from a single block. You change a `useState` and three handlers drift along with it because nothing has its own home. Refactor the same file: props at the top in one block, state hooks together, effects together, handlers together, JSX at the bottom. Now changing the `useState` only touches the state block; the diff maps to behavior one-to-one. The structure didn't make the file shorter; it made each edit's blast radius smaller.

A production prompt has the same shape: role, task, constraints, output — four named sections so the rule about hashtags lives in constraints, the JSON shape lives in output, and changing one section doesn't ripple through the others.

**What depends on getting this right:** every chain's behaviour stays editable without regressions. In this codebase `summarize.ts:prompt.ts` (L4 role, L17–L27 output spec), `caption.ts` (L24 role, L73–L82 `UNIVERSAL RULES` constraints), `classify.ts` (L12 role + five-mode task), and `interpret.ts` (L19 role, L21 voice constraints, L38–L46 `Voice rules`) all follow the same four-section shape. Lose the structure and a tweak to caption's tone bleeds into the JSON output spec; a contributor adding a new constraint puts it in the role section by accident; the validator catches the malformed output but you can't tell from the prompt diff what changed.

Without the four-section shape:
- A wall-of-text system prompt mixing role / task / constraints / output
- Edit "tone is wry" and the JSON shape lines drift along with it
- Contributors add new rules at random positions; the prompt grows without structure
- Output drift shows up in production; the prompt diff doesn't point at a cause

With the four-section shape:
- Role at the top (one line), task in the middle, constraints as a `RULES` block, output spec at the bottom
- Edit caption.ts L75 (`UNIVERSAL RULES`) and you know exactly what surface changed
- New rule? It goes in the constraints block. New output field? Output section.
- Prompt diffs map to behaviour changes one-to-one

A typed config with four named sections, not a wall of text — each section has its own job, and edits map to behaviour one-to-one.

---

## How it works

Four ordered text sections in the system prompt — Role, Task, Constraints, Output — each one a named block with one job. Same shape as a JSDoc that has `@description` + `@param` + `@throws` + `@returns` instead of one prose paragraph: the structure makes each piece editable in isolation. The model reads the whole system prompt before generating; the four sections give every instruction a home so that changing the tone in section 2 doesn't drift the JSON shape in section 4.

The four sections in one picture:

```
   SYSTEM PROMPT (the static briefing — same across every call)
   ────────────────────────────────────────────────────────────
   ┌─ Section 1: Role ──────────────────────────────────────┐
   │   "You are composing a daily vlog summary for a         │
   │    personal journal app called buffr."                  │
   │   (1 line; the "you are")                               │
   └─────────────────────────────────────────────────────────┘
   ┌─ Section 2: Task ──────────────────────────────────────┐
   │   The work + the rules of the work.                     │
   │   Tone instructions, content constraints, validity      │
   │   rules ("clipOrder must only reference clip IDs from   │
   │   the provided clips list", "max 4 textOverlays").      │
   │   (largest section)                                     │
   └─────────────────────────────────────────────────────────┘
   ┌─ Section 3: Constraints ───────────────────────────────┐
   │   The "never" / "always" list.                          │
   │   "Never write 'I' / 'you' / 'we'."                     │
   │   "No hashtags. No emojis."                              │
   │   (rules-as-forbidden-patterns)                          │
   └─────────────────────────────────────────────────────────┘
   ┌─ Section 4: Output ────────────────────────────────────┐
   │   The return type.                                      │
   │   "Respond with ONLY valid JSON matching this shape:    │
   │    { headline: string, summary: string, ... }"          │
   │   (strictest phrasing in the whole prompt)              │
   └─────────────────────────────────────────────────────────┘

   USER MESSAGE (the dynamic payload — changes every call)
   ────────────────────────────────────────────────────────────
   per-call data: today's entries, recent captions, mood, ...
   (no behaviour rules here; this is just the input)
```

The six sub-sections below trace each of the four sections, the user-message split, and how buffr's prompts have evolved across chains.

### Section 1 — Role (the "you are")

The role section names what the model is supposed to be in this call. It's the first thing the system prompt says. For buffr's chains:

- **summarize.ts** (`prompt.ts` L4): *"You are composing a daily vlog summary for a personal journal app called buffr."*
- **caption.ts** L24: *"You generate four variant captions for a daily vlog from the user's raw log."*
- **classify.ts** L12: *"You classify short personal thoughts into one of five thinking modes."*
- **interpret.ts** L19: *"You are an emotionally intelligent journal interpreter."*

If you're coming from frontend, this is the same shape as the first line of a function's JSDoc comment — `/* @description Render a single todo item with check toggle */` — a one-line statement of purpose that frames everything that follows. Practical consequence: when the model gets confused mid-generation (the chain output drifts into a different shape), the role sentence is what pulls it back. The classifier with role *"You classify ... into one of five thinking modes"* is far less likely to write a chatty multi-sentence response than the same prompt without the role.

The role line across buffr's five chains:

```
   summarize.ts L4    "You are composing a daily vlog summary for a
                       personal journal app called buffr."
   caption.ts   L24   "You generate four variant captions for a daily
                       vlog from the user's raw log."
   classify.ts  L12   "You classify short personal thoughts into one
                       of five thinking modes."
   expand.ts    (varies per type — idea / knowledge / study / reflect)
   interpret.ts L19   "You are an emotionally intelligent journal
                       interpreter."

   one line each, declarative, naming the JOB.
```

### Section 2 — Task (the "your job is")

The task section describes the work and the rules of the work. This is the largest section in most prompts. For summarize, it's the tone instruction and the constraints on what counts as valid output ("clipOrder must only reference clip IDs from the provided clips list", "textOverlays max 4 items", "mood must be one of: flat, ok, good, great, fired"). For caption, it's the four variant voice descriptions with examples. For classify, it's the definition of each mode. For interpret, it's the multi-section markdown structure with voice rules.

If you're coming from frontend, this is the body of a function specification — the rules and behaviour the function has to honour. Practical consequence: the model treats every line in the task section as a hard rule. Loose phrasing here ("try to be brief") gets ignored; tight phrasing ("max 60 chars per overlay text") gets honoured. The task section is where the trade between prompt length and output quality plays out — every additional rule is a token in every call, but also a guardrail the validator doesn't have to enforce afterward.

Loose vs tight phrasing — same intent, different model behaviour:

```
   loose phrasing                               tight phrasing
   ─────────────────────────────────────        ─────────────────────────────────────
   "Try to be brief in the summary."             "Summary: max 280 chars."
   "Avoid using too many overlays."              "textOverlays: max 4 items, each
                                                  max 60 chars."
   "Make the tone reflective."                   "Mood field must be one of:
                                                  flat / ok / good / great / fired."
   "Don't reference clips that don't exist."     "clipOrder must only contain IDs
                                                  from the input clips list."

   the model treats:
     "try to be brief"     → suggestion, often ignored
     "max 280 chars"       → hard rule, almost always honoured
```

Loose phrasing gets ignored; tight phrasing is what the validator can later confirm landed.

### Section 3 — Constraints (the "never / always")

Constraints are the negative space — what the model must not do. In buffr's chains these are sometimes inline with the task (the caption prompt's `UNIVERSAL RULES` block at L73–L82 is constraints; the interpret prompt's `Voice rules` block at L38–L46 is constraints). The distinction from "task" is subtle: task says *what success looks like*; constraints say *what failure looks like*. Examples:

- caption.ts L75: *"First-person implied — never write 'I' / 'you' / 'we'."*
- caption.ts L76: *"No hashtags. No emojis. No 'today I…' / 'Today was…' framings."*
- interpret.ts L21: *"Never diagnose. Never use clinical labels ('trauma', 'paranoid', 'anxious', 'avoidant'). Never moralize, never motivate, never lecture."*

If you're coming from frontend, this is the same shape as a `RuleSet` in a linter config — `no-console`, `no-unused-vars` — rules expressed as forbidden patterns. Practical consequence: explicit "never" rules are far more effective than positive phrasing. Saying *"never write 'I'"* eliminates the construction; saying *"prefer third-person"* gets the model 60% there. The model treats negative constraints as hard rules and positive preferences as suggestions.

Positive preference vs negative constraint — same intent, different effectiveness:

```
   positive preference (60% effective)         negative constraint (~95% effective)
   ─────────────────────────────────────      ─────────────────────────────────────
   "Prefer third-person."                      "Never write 'I' / 'you' / 'we'."
   "Try to avoid hashtags."                    "No hashtags. No emojis."
   "Keep the voice neutral."                   "Never moralize, never motivate,
                                                never lecture."
   "Be careful with clinical labels."          "Never use clinical labels:
                                                'trauma', 'paranoid', 'anxious',
                                                'avoidant'."

   the model treats negatives as RULES; positives as preferences.
   the constraints block is where the codebase encodes hard refusals.
```

Explicit "never" rules eliminate the construction; positive preferences get partial compliance at best.

### Section 4 — Output (the "return ___ matching ___")

The output section names the format and shape. For JSON chains it's the literal JSON shape with field types. For interpret it's the markdown structure with section headings. Examples:

- prompt.ts L17–L27: *"Respond with ONLY valid JSON matching this exact shape: { headline: string, summary: string, mood: ... }"*
- caption.ts L26–L34: *"OUTPUT: a single valid JSON object with EXACTLY this shape: { clean: ..., smoother: ..., reflective: ..., punchy: ..., detectedTheme: ... } No prose preamble, no markdown fences, no commentary. JSON only."*
- interpret.ts L23: *"Output valid markdown — no preamble, no JSON, no code fences around the whole thing."*

If you're coming from frontend, this is the same shape as the return type of a function. The output section is what the validator (`validate.ts`, `parseAndValidate`) implicitly checks the model honoured. Practical consequence: this section earns the strictest phrasing in the whole prompt. *"No prose preamble"* + *"JSON only"* is repetitive on purpose — the model has been trained on millions of "Here's the JSON you asked for: {...}" examples, and the output section is what fights that prior.

The output section as a return type, with the matched validator:

```
   chain         output section says                       validator checks
   ──────────    ────────────────────────────────────      ────────────────────────
   summarize     "Respond with ONLY valid JSON              parseJson + validateSummary
                  matching: { headline, summary,             (every clipId ∈ input,
                  mood, clipOrder: [], textOverlays: } "      filter ∈ enum,
                                                              mood ∈ 7 strings)
   caption       "OUTPUT: a single valid JSON object         parseJson +
                  with EXACTLY this shape:                    parseAndValidate
                  { clean, smoother, reflective,              (all 4 variants present,
                    punchy, detectedTheme }                    non-empty)
                  No prose preamble, no markdown
                  fences, no commentary. JSON only."
   interpret     "Output valid markdown — no preamble,       cleanMarkdown
                  no JSON, no code fences around              (strip fence, reject
                  the whole thing."                            empty)

   strictest phrasing in the whole prompt — fighting the model's
   "Here's the JSON: {...}" training prior.
```

The output section is where the validator's tightening starts.

### The user message — payload only

The system prompt holds the four sections; the user message holds only the per-call payload. For summarize, the user message is the entries + clips + habits (built by `buildPrompt` in `prompt.ts` L29–L58). For caption, it's the raw log lines + mood + recentCaptions (built by `buildUserPrompt` in `caption.ts` L102–L121). For classify, it's literally the todo text. If you're coming from frontend, the system prompt is to `const Component = () => …` what the user message is to `<Component prop={value} />` — the component shape is fixed once; the prop changes every call. Practical consequence: changing the chain's behaviour means changing the system prompt; changing the data the chain operates on means changing how the user message is built. The two never bleed together.

What's in the system prompt vs the user message:

```
   ┌─ SYSTEM PROMPT (the component declaration) ──────────────────┐
   │  static — same across every call                              │
   │                                                                │
   │  Role + Task + Constraints + Output                            │
   │                                                                │
   │  changing this = changing the chain's BEHAVIOUR                │
   │  edited in prompt.ts / caption.ts SYSTEM constants            │
   └──────────────────────────────────────────────────────────────┘

   ┌─ USER MESSAGE (the prop being passed) ───────────────────────┐
   │  dynamic — built per call                                     │
   │                                                                │
   │  summarize:  entries[date].text + clips + habits               │
   │  caption:    rawLog[] + recentCaptions + mood                  │
   │  classify:   todo.text (single string)                         │
   │  expand:     todo.text + siblingTodos + recentSummaries        │
   │  interpret:  truncateTail(entry.text, 2000)                    │
   │                                                                │
   │  changing this = changing the DATA the chain operates on       │
   │  edited in buildPrompt / buildContext / buildUserPrompt        │
   └──────────────────────────────────────────────────────────────┘

   the two never bleed together — that's the split.
```

Behaviour and data have separate edit surfaces; the prompt diff maps to which one changed.

### Move 2.5 — How buffr's prompts have evolved

**Phase A (caption, summarize, classify, expand):** four-section system prompt + payload user message. All four chains follow the same shape.

**Phase B (interpret, added 2026-05-10):** same shape, but the output section permits markdown rather than enforcing JSON. The voice rules section is longer than in any other chain because the failure mode (clinical language, motivational platitudes) is more subtle than a missing field.

**What didn't have to change:** the system prompt structure. interpret slotted into the same four-section shape as the others; the only field that changed was the output format. That's the architectural payoff — once the structure is settled, adding a chain is a system-prompt write, not a refactor.

Phase A vs Phase B side by side:

```
            Phase A (caption / summarize /             Phase B (interpret —
            classify / expand)                          added 2026-05-10)
   ┌──────────────────────────────────────┐    ┌──────────────────────────────────────┐
   │ Role:        one line                  │    │ Role:        one line                  │ unchanged
   │ Task:        JSON-shape rules          │    │ Task:        markdown structure rules  │  shape
   │ Constraints: "never X / never Y"       │    │ Constraints: voice rules (longer —     │  same;
   │                                        │    │              clinical language ban)    │  contents
   │ Output:      "Respond with ONLY        │    │ Output:      "Output valid markdown —  │  vary
   │              valid JSON matching       │    │               no JSON, no fences."     │
   │              this shape: { ... }"      │    │                                        │
   └──────────────────────────────────────┘    └──────────────────────────────────────┘
                            │                                          │
                            └──────────────────┬───────────────────────┘
                                               ▼
                              structure didn't have to change between phases
                              adding a new chain = write a new system prompt
                              in the same four-section shape, NOT a refactor
```

The architectural payoff: once the structure is settled, every new chain slots in.

This is what people mean by "treat the prompt like code." A prompt with sections has structure; a prompt without sections has prose. Code reviewers can read a sectioned prompt; they can only stare at a prose prompt. The full picture is below.

---

## Anatomy of a production prompt — diagram

```
                        The four sections, in order

  ┌─ SYSTEM PROMPT ───────────────────────────────────────────────────┐
  │                                                                   │
  │  ROLE                                                             │
  │  ─────                                                            │
  │  "You are X."  → one sentence at the top                          │
  │                                                                   │
  │  TASK                                                             │
  │  ─────                                                            │
  │  "Your job is to do Y."                                           │
  │  - Specific rules: clip IDs must match, max N items, etc.         │
  │  - Tone / voice description                                       │
  │  - Examples where they help                                       │
  │                                                                   │
  │  CONSTRAINTS                                                      │
  │  ───────────                                                      │
  │  "Never do A. Never do B. Always do C."                           │
  │  → negative space — what failure looks like                       │
  │                                                                   │
  │  OUTPUT                                                           │
  │  ──────                                                           │
  │  "Return JSON matching {literal shape}." or                       │
  │  "Output valid markdown — no preamble, no JSON, no fences."       │
  │  → strictest phrasing in the prompt                               │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
  ┌─ USER MESSAGE ────────────────────────────────────────────────────┐
  │                                                                   │
  │  Payload only — the data for this call.                           │
  │                                                                   │
  │  For summarize: entries + clips + habits + date                   │
  │  For caption:   raw log lines + mood + recentCaptions             │
  │  For classify:  the todo text                                     │
  │  For interpret: the journal entry                                 │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
```

```
              buffr's five chains by section, side by side

  Chain      Role                Task          Constraints   Output
  ─────────  ──────────────────  ────────────  ───────────   ──────────────
  summarize  vlog summary        tone + JSON   inline w/      JSON shape
                                  rules         task         spelled out
  caption    4-variant caption   4 voices +   UNIVERSAL     JSON shape
                                  examples      RULES         + "JSON only"
  classify   5-mode classifier   mode defs    "ONLY JSON"   {type,confidence}
  expand     per-type expand     type spec    inline         typed schema
  interpret  journal interp      structure    Voice rules   markdown body
                                  guide
```

---

## In this codebase

**summarize prompt (cleanest example of the structure):**
**File:** `src/services/ai/prompt.ts`
**Function / class:** `SYSTEM` constant + `buildPrompt(entries, clips, habits, date)`
**Line range:** L4–L27 (system prompt with all four sections), L29–L58 (user-message builder)

**caption prompt (longest task section, strictest constraints):**
**File:** `src/services/ai/caption.ts`
**Function / class:** `SYSTEM_PROMPT` constant + `buildUserPrompt(input)`
**Line range:** L24–L100 (system prompt), L102–L121 (user-message builder)

**classify prompt (shortest — fits the cheap fast call):**
**File:** `src/services/todos/classify.ts`
**Function / class:** `SYSTEM_PROMPT` constant
**Line range:** L12–L23

**interpret prompt (markdown output — the structural exception):**
**File:** `src/services/ai/interpret.ts`
**Function / class:** `SYSTEM_PROMPT` constant
**Line range:** L19–L50

---

## Elaborate

### Where this pattern comes from
The four-section structure formalised around 2023 in the LLM-tooling community — LangChain's prompt templates, OpenAI's prompt engineering guide, Anthropic's "Be Clear and Direct" Claude prompting documentation. Before that, prompts were prose and every team rediscovered the structure independently. The reason it converged: every section serves a different attention pattern in the transformer. The role section anchors the model's identity priors; the task section provides the planning context; constraints carve negative space; the output section overrides the model's training prior to ramble.

### The deeper principle
**Prompts are code that runs on a probabilistic interpreter.** Every section is a constraint on the model's output distribution. Loose phrasing widens the distribution; tight phrasing narrows it. The four-section shape exists because each section narrows a different dimension — role narrows persona, task narrows behaviour, constraints narrow failure modes, output narrows shape. Removing a section widens that dimension. Mixing two sections (constraints inside the output, role inside the task) creates ambiguity the model resolves arbitrarily.

### Where this breaks down
- **Tiny prompts** — a one-line classifier doesn't need four sections; one paragraph is fine. Below ~3 paragraphs the structure becomes overhead.
- **Long task sections with embedded constraints** — when the rules are about *how* to do the task rather than what to avoid (caption's voice rules), separating constraints from task is artificial. The constraints become subsection bullets inside task.
- **Few-shot examples** — when examples are doing the heavy lifting, they often blur the line between task and output. The interpret prompt has no examples for exactly this reason; the summarize prompt has none either.
- **Multi-turn conversations** — the four sections live in the system prompt; per-turn messages don't get to re-state them. For long conversations the role drifts and needs reminding.

### What to explore next
- [Single-purpose chains](./02-single-purpose-chains.md) → why each chain has its own four-section prompt rather than one mega-prompt.
- [Forbidden patterns and rotating formulas](./18-forbidden-patterns-rotation.md) → how the constraints section evolves when the model converges on a phrasing.
- [Structured outputs](./16-structured-outputs.md) → why the output section earns the strictest phrasing.

---

## Tradeoffs

The codebase uses the four-section shape on all five chains. The cost is prompt-length on every call; the win is that every chain is debuggable in the same shape.

### Comparison table — both costs in one frame

```
┌────────────────────┬────────────────────────────┬────────────────────────────┐
│ Cost dimension     │ Path taken (four-section   │ Alternative (single        │
│                    │ system prompt)             │ paragraph "do this thing") │
├────────────────────┼────────────────────────────┼────────────────────────────┤
│ System-prompt      │ ~100–600 tokens per chain  │ ~30–150 tokens per chain   │
│  tokens per call   │                            │                            │
│ Cost per call      │ +~$0.0003 input on Sonnet  │ baseline                   │
│  (Sonnet input)    │                            │                            │
│ Output reliability │ high — model rarely drifts │ medium — model improvises  │
│                    │ on shape, voice, or scope  │ when prompt is loose       │
│ Validator load     │ low — fewer schema breaks  │ high — JSON.parse fails    │
│                    │                            │ more often                 │
│ Onboarding cost    │ a new chain author reads   │ a new chain author guesses │
│                    │ another chain's prompt and │ at the right shape         │
│                    │ copies the four sections   │                            │
│ Drift surface      │ low — each section can be  │ high — touching one part   │
│                    │ changed independently      │ shifts unrelated behaviour │
│ Audit by reviewer  │ section-by-section read    │ "is this prompt good?" —   │
│                    │                            │ no structure to compare    │
└────────────────────┴────────────────────────────┴────────────────────────────┘
```

### What we gave up

We pay ~100–600 tokens of system-prompt overhead on every call. Sonnet at $3/1M input means each summarize call costs an extra ~$0.0009 in system-prompt-overhead beyond the user message — a fraction of a cent per call. For a solo-user app that's negligible; at 10k calls/day it would be ~$9/month. The cost is real but small.

We gave up the ability to A/B test prompt versions in flight. With a single-paragraph prompt the change is easier — swap one string. With four sections, a meaningful change usually spans two sections (you can't change the output without checking the task that produced it). Each prompt edit becomes a "did I update the right pair of sections?" question rather than "did I rewrite the right line?"

We gave up brevity. The caption prompt is 77 lines long because the four-section shape forces the writer to spell out each section completely. A more terse prompt would say *"Write four tonal variants of the day with anti-repetition. JSON out."* and let the model figure out the voices. That doesn't work — the model converges on safe defaults and the four "different voices" all sound the same — but the verbose prompt is the cost of avoiding that failure.

### What the alternative would have cost

If we had used a single-paragraph prompt per chain, every chain would have written its own structure and they'd drift apart. The classifier's prompt would look one way, the summarizer's another, and adding a sixth chain would mean inventing a third shape. The validator load would climb — every prompt that loosely says "return JSON" gets a higher rate of malformed responses, and `validate.ts`'s 137 lines would have to absorb more drift. The token savings (~70 tokens per chain × five chains × N calls) would have been pennies a month; the maintenance cost would have been compounding.

If we had used few-shot examples instead of constraints (showing 5 examples of what good output looks like instead of writing "never do X"), the prompts would have been longer and the model would have shaped output around the examples — fine for classifier-style chains, but a problem for creative chains (caption) where the examples would have caused style convergence across users.

### The breakpoint

Fine until the prompt grows past ~600 tokens or until the constraints section grows past ~10 items. At that point the prompt becomes unreadable in code review — a contributor opens the file, scrolls, and bounces. The fix isn't to shorten; it's to factor. The four sections become four named template strings (`ROLE`, `TASK`, `CONSTRAINTS`, `OUTPUT`) and the system prompt becomes `${ROLE}\n\n${TASK}\n\n${CONSTRAINTS}\n\n${OUTPUT}`. That's a refactor the codebase hasn't paid for yet because no single prompt has crossed that line.

### What wasn't actually a tradeoff

"No system prompt at all" was never a real option. Both Claude and OpenAI infer a default persona when the system prompt is empty, and that default is "helpful chatbot assistant" — a persona that adds friendly preamble, asks clarifying questions, and refuses ambiguous requests. Every buffr chain would have failed under that default; the system prompt is non-negotiable.

---

## Tech reference (industry pairing)

### Anthropic Messages API (system parameter)

- **Codebase uses:** `client.messages.create({ system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }] })` in every Claude branch (summarize.ts L15–L20, caption.ts L126–L133, classify.ts L41–L46, expand.ts L34–L40, interpret.ts L66–L72).
- **Why it's here:** the typed first-class system-prompt slot. Claude treats system content with different attention than user content — explicit `system` parameter is the way to get that.
- **Leading today:** Anthropic Messages API with `system` parameter — `adoption-leading` for system-prompt-shaped chains, 2026.
- **Why it leads:** the `system` parameter is the only public way to feed Claude a non-conversational role+task. Newer providers (Gemini, Mistral) copy the same shape.
- **Runner-up:** Inline `<system>` tags inside user messages — `adoption-leading` for OpenAI-style Chat Completions where system is the first array element. Same shape, different syntax.

### OpenAI Chat Completions (system role)

- **Codebase uses:** `messages: [{ role: 'system', content: system }, { role: 'user', content: user }]` in every OpenAI branch (summarize.ts L31–L34, caption.ts L145–L148, classify.ts L58–L61, expand.ts L46–L48, interpret.ts L83–L86).
- **Why it's here:** OpenAI's equivalent slot — first message in the array with `role: 'system'`. Identical conceptual shape; different syntactic position.
- **Leading today:** OpenAI Chat Completions — `adoption-leading` for the system-as-array-first-element pattern, 2026.
- **Why it leads:** widest tooling support — every framework (LangChain, Vercel AI SDK, OpenRouter) speaks this shape natively; provider-agnostic libraries default to it.
- **Runner-up:** OpenAI Responses API — `innovation-leading` for agentic / tool-use workloads. Still in beta for typed prompts; Chat Completions remains the production-grade shape.

---

## Project exercises

### [B1.7] Ship template-style-guide.md in aipe (cross-project)

- **Exercise ID:** `[B1.7]` — primary anchor is the *aipe* repo, included here because aipe's templates are the most concentrated example of the four-section prompt shape applied at meta level.
- **What to build:** A `template-style-guide.md` in the aipe repo documenting the prompt engineering principles encoded across the 11 templates (`/aipe:feature`, `/aipe:refactor`, `/aipe:study`, `/aipe:audit`, `/aipe:debugging`, etc.). Each template is a production prompt with its own role / task / constraints / output sections — the guide names the shape and the recurring sub-patterns (e.g., "every template has an UPDATE MODE", "every template has a STOP-and-confirm step").
- **Why it earns its place:** prompt engineering as a discipline is `[C1.7]`. buffr has five concrete chains; aipe has eleven concrete templates that *teach the discipline*. The style guide is the proof artifact for the discipline track.
- **Files to touch:** new `aipe/template-style-guide.md`; cross-reference from aipe's own README.
- **Done when:** the guide names the four-section shape, points at one concrete template per section as an example, and lists the recurring meta-patterns across all 11 templates.
- **Estimated effort:** `1–4hr`.

### Audit buffr's 5 chains against the four-section shape

- **Exercise ID:** *cross-cutting (Phase 1)*
- **What to build:** A short audit of each of buffr's 5 chain SYSTEM_PROMPTs against the four-section structure described in this file. Score each chain: does it have an explicit role line? a single task statement? a constraints section (explicit "never" rules)? an output section that matches the validator?
- **Why it earns its place:** the file claims "all 5 chains use the same four-section shape" — the audit is the receipt. Likely uncovers one chain where role/task are conflated or where the output section drifts from the actual validator.
- **Files to touch:** read `src/services/ai/{summarize,caption,classify,expand,interpret}.ts`; output a `prompt-shape-audit.md` (gitignored or under `docs/`).
- **Done when:** every chain has a passed/failed mark per section; failures have a one-line "what to fix" note.
- **Estimated effort:** `1–4hr`.

---

## Summary

A production prompt has four sections — role, task, constraints, output — and every section has one job. In this codebase all five chains follow the shape: role names what the model is, task describes the work with its rules and examples, constraints draw the negative space ("never write 'I'"), output names the format (JSON shape or markdown structure). The user message carries only the per-call payload, built by per-chain functions (`buildPrompt`, `buildUserPrompt`). The constraint that shaped this is that loose prompts produce loose outputs the validator has to compensate for; structured prompts narrow each dimension separately and let each section be tuned independently. The cost is ~100–600 tokens of overhead per call and longer prompt files in code review.

Key points to remember:
- Four sections in order: role → task → constraints → output. Each has one job; mixing them creates drift.
- The system prompt holds the four sections; the user message holds only payload.
- Negative constraints ("never write 'I'") are more effective than positive preferences ("prefer third-person").
- The output section earns the strictest phrasing — fighting the model's prior to add preamble.
- All five buffr chains use the same shape; `interpret` is the only one whose output section permits markdown rather than enforcing JSON.

---

## Interview defense

### What an interviewer is really asking
"Anatomy of a prompt" tests whether the candidate has shipped LLM features and learned from failures. Anyone can write a prompt that works once; the four-section shape is what you arrive at after watching prompts drift, fail, and be hard to debug. The interviewer wants to hear evidence that the candidate has felt the pain of unstructured prompts and built the structure to avoid it.

### Likely questions

[mid] Q: Show me the structure you'd use for a new chain — say, a "rewrite this todo to be more specific" chain.

A: Four sections in the system prompt. Role: "You are a productivity assistant that rewrites vague todos into specific, actionable items." Task: "Rewrite the input todo to name the concrete action, the object, and a measurable completion criterion. Keep it under 12 words." Constraints: "Never add deadlines the user didn't mention. Never split one todo into multiple. Never use vague verbs like 'check' or 'look at' — replace them with the concrete action implied." Output: "Respond with ONLY a JSON object: `{ \"rewritten\": string }`. No preamble, no markdown fences." User message: the original todo text. That's the whole chain.

```
[four-section prompt]

  ┌──── system ─────────────────┐
  │ ROLE: productivity assistant│
  │ TASK: rewrite vague todo    │
  │ CONSTRAINTS: 3 nevers       │
  │ OUTPUT: {rewritten:string}  │
  └─────────────────────────────┘
            │
  ┌──── user ───────────────────┐
  │ original todo text           │
  └─────────────────────────────┘
```

[senior] Q: Why split task from constraints if they're both rules the model has to follow?

A: Because task says what success looks like and constraints say what failure looks like, and the model handles them differently. Positive instructions in the task section shape the output distribution; negative constraints in the constraints section sharpen the boundaries. Mixing them creates rules-by-implication: a constraint like "never apologise" buried inside the task paragraph gets weighted lower than the same constraint in its own block. The separation is also a debugging tool — when output is wrong, you go to the section that should have prevented it. Wrong shape? Output section. Wrong tone? Task section. Forbidden phrase appeared? Constraints section. One symptom, one section to fix.

```
                Task section                          Constraints section
                ──────────────────────────────         ──────────────────────────────
purpose         "what success looks like"             "what failure looks like"
phrasing        positive ("rewrite as specific")      negative ("never use 'check'")
debug usage     wrong-tone output → fix here          forbidden-phrase output → fix here
attention       shapes the output distribution        sharpens the boundary
                                                      of the distribution
removing it     output drifts to a different shape    forbidden patterns reappear
```

[arch] Q: What if you needed to ship 20 new chains in the next quarter — does the four-section shape still hold?

A: It still holds, but the prompts themselves need to factor. At 5 chains each prompt being a self-contained string is fine; at 20 you'd want shared building blocks — a shared role-of-buffr block, a shared "JSON only, no preamble" output footer, a shared constraints list for "never use clinical language." Each chain becomes the concatenation of its specific sections plus the shared ones. The pattern doesn't change; the implementation does. The Anthropic and OpenAI APIs both allow this — system can be a long string composed from template parts — and the codebase would extract a `lib/promptParts.ts` to hold them.

```
At 20 chains:

  ┌─ Shared prompt parts (lib/promptParts.ts) ─┐
  │ BUFFR_CONTEXT — shared role context        │
  │ JSON_OUTPUT_FOOTER — "JSON only..."        │
  │ CLINICAL_LANGUAGE_BAN — shared constraints │
  └─────────────────────────────────────────────┘
                       │
                       ▼  composed into each chain's system prompt
  ┌─ Per-chain prompt files ───────────────────┐
  │ classify.ts  → CLASSIFY_ROLE + CLASSIFY_TASK│  ◀── BREAKS FIRST if shared
  │              + BUFFR_CONTEXT                │     parts drift unsynced
  │ summarize.ts → SUMMARIZE_ROLE + ...         │     across chain files
  │ ...                                         │
  └─────────────────────────────────────────────┘
                       │
                       ▼
              20 typed chain functions
```

### The question candidates always dodge
Q: Your prompts repeat the same JSON-shape spec inside the prompt and inside `validate.ts`. Isn't that a duplication waiting to bite you?

A: Yes — and I'd own that. The contract lives in three places: the TypeScript type (`AISummary`), the prompt text (the JSON shape spelled out at the bottom of the system prompt), and the validation function (`validateSummary`). When I add a field, all three need to update; if I forget one, the chain fails silently in production. The reason I haven't centralised it yet is that the alternative (zod schemas, with the prompt and type generated from the schema) adds ~70KB to the React Native bundle and adds a code-generation step. At five chains, the manual sync is uncomfortable but tractable. At twenty, it becomes a real liability. I track which chains have drifted by reading them top-to-bottom against the type and the validator; the day a real drift bug ships, I move to zod.

```
                Path taken (3-place contract)         Alternative (zod-driven generation)
                ──────────────────────────────        ──────────────────────────────
sites of truth  3 (type + prompt + validator)         1 (zod schema)
sync method     manual discipline                     code-generation
drift surface   wide                                  narrow
bundle cost     0 KB                                  ~70 KB
build pipeline  none added                            generation step + tests
ship cost       0 (already shipped)                   1–2 days of refactor
visible bug     none yet                              none — would be prevented
```

### One-line anchors
- "Prompts are code that runs on a probabilistic interpreter — structure narrows the output distribution."
- "Four sections: role, task, constraints, output. Each has one job."
- "Negative constraints beat positive preferences — 'never write I' is stronger than 'prefer third-person'."
- "The system prompt holds structure; the user message holds payload."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the four-section system prompt from memory: role at the top, task below, constraints below that, output at the bottom, user message as a separate block carrying payload only.

Open the file. Compare.

✓ Pass: your diagram names all four sections in the correct order with one-line descriptions of each.
✗ Fail: re-read the "How it works" section, wait 10 minutes, try again.

### Level 2 — Explain it out loud
Explain the four-section prompt structure to an imaginary colleague who just asked "where do I start when writing a prompt for a new feature?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name each section's job in one phrase?
- Name where it lives in the codebase? → `src/services/ai/prompt.ts` (summarize is the cleanest example)
- Name the tradeoff (token overhead vs structure) in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

You need to write a sixth chain — a "sentiment of this caption" chain that returns `{ sentiment: 'positive' | 'neutral' | 'negative', confidence: number }`. Write the four sections (one or two lines each): role, task, constraints, output. Specifically: what's one thing you'd put in constraints that someone without the four-section discipline would forget?

Write your answer. Then open `src/services/todos/classify.ts` L12–L23 to compare with the shortest existing chain in the codebase.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you still write the JSON shape inline in the prompt, or would you use a tool-use call where the schema is enforced provider-side? Why or why not? What would that cost?"

Reference the actual code:
→ Point to `src/services/ai/prompt.ts` L17–L27 to support the inline-shape approach
→ Point to where a tool definition would live (`src/services/ai/tools.ts`) if you chose the alternative

There is no right answer. The point is specificity. "Tool use is more reliable" is vague; "Anthropic tool use enforces the schema provider-side but is only available on Claude, so the OpenAI branch would still need prompt-only enforcement and the codebase would carry two patterns" is specific.

### Quick check — code reference test
Without opening any files, answer:
- Which file holds the cleanest example of a four-section system prompt?
- What does the constraints section look like in `caption.ts`?
- Which chain's output section permits markdown rather than JSON?

Then open `prompt.ts`, `caption.ts`, and `interpret.ts` to verify.

✓ Pass: you named `prompt.ts` (summarize), the `UNIVERSAL RULES` block in caption.ts, and `interpret.ts` as the markdown chain.
✗ Fail: that's a sign this concept hasn't fully landed yet — re-read the "How it works" section.

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (new-hire briefing scenario, name the each-rule-has-a-home question, four-section stakes across chains, before/after, single-line metaphor).

---
Updated: 2026-05-14 — v1.32.0 pass: swapped Why care + How it works Move 1 from new-hire / freelancer-briefing physical-world analogies (banned per v1.31.0/v1.32.0) to level-1 primitives (200-line React component refactored from one function into props/hooks/effects/JSX blocks; JSDoc with `@description`/`@param`/`@throws`/`@returns` sections). Swapped Why care Move 5 from "briefing document" metaphor to "typed config with four named sections." Added Move 1 mnemonic diagram (four sections of system prompt + user message split) + 6 Move 2 sub-section diagrams: role-line inventory across chains, loose-vs-tight task phrasing, positive-preference vs negative-constraint effectiveness, output-section + matched-validator table, system-prompt vs user-message split, Phase A vs Phase B side-by-side. Total: 7 new diagrams.
