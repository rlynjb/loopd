# Meta-prompting

**Industry name(s):** Meta-prompting, prompt-generation, prompt-of-prompts, LLM-authored prompts
**Type:** Industry standard · Language-agnostic

> Use an LLM to draft prompts for another LLM call. Useful for initial drafting; dangerous if the output enters the codebase unedited. Buffr does not use meta-prompting — the 5 chain prompts were hand-written and stay that way; this file describes the discipline that would apply if a future complex chain ever made the draft-and-edit workflow earn its keep here.

**See also:** → [03-prompts-as-code](./03-prompts-as-code.md) · → [05-eval-driven-iteration](./05-eval-driven-iteration.md) · → [01-anatomy](./01-anatomy.md)

---

## Why care

### Move 1 — The grounded scenario

You need a prompt for a new chain. You know the goal ("classify these support tickets into urgency tiers") but writing a good prompt from scratch is slow — system instructions, label list, few-shot examples, edge-case rules. Instead you ask Claude: "draft me a production-quality prompt that classifies support tickets into low/medium/high/critical, with 5 few-shot examples and rules for edge cases." Claude writes 400 lines of plausible-looking prompt in 30 seconds. You paste it into your chain file. Three weeks later you're debugging it and discover the few-shot examples are inconsistent (two of them use "high" for cases that should be "critical"), the system prompt assumes a "company name" field that doesn't exist in your data, and the edge-case rules cite SLA tiers from some other company's documentation that Claude hallucinated.

### Move 2 — Name the question the pattern answers

That should-I-let-an-LLM-write-this question is what meta-prompting answers. Not "is LLM-generated prompt content useful" (yes, sometimes) — just *what's the workflow that uses LLM-drafted prompts safely, where does the human review fit, and what kinds of prompts is this approach appropriate for*. The pattern is a workflow: human writes the goal + constraints, LLM drafts the prompt, human reviews and edits (treating the draft as raw material, not the final artefact), the edited prompt enters the codebase via the same review process as any other code change.

### Move 3 — Why answering that question matters

**What breaks without the discipline:** LLM-authored prompts ship without human review, look right, fail in production with subtle issues nobody catches because nobody read them carefully. The cost is invisible until it's the prompt's behaviour that's wrong. In buffr today, no chain uses meta-prompting; the 5 chain prompts in `src/services/ai/` were written by hand and that's the correct choice for prompts of this size that change only when their consumer model changes. The risk surface meta-prompting introduces — a draft that looks plausible but cites fields buffr doesn't have, labels buffr doesn't use, edge cases for some other app — is the risk this file is protecting buffr against if someone ever reaches for the workflow.

### Move 4 — Concrete before/after

Without discipline (LLM draft ships unedited):
- Engineer asks Claude for a classifier prompt
- Claude generates 400 lines of plausible-looking content
- Engineer skims, ships
- Production rate: 75% accurate (Claude hallucinated rules, inconsistent few-shot)
- Debug cost: 2-3 days to identify which sections are wrong

With discipline (LLM draft as raw material):
- Engineer asks Claude for a classifier prompt with explicit context (data schema, real labels, real examples)
- Claude generates 400 lines
- Engineer treats draft as starting point: removes hallucinations, fixes label inconsistencies, replaces invented edge cases with real ones
- Final prompt is 200 lines (half of Claude's draft was wrong or redundant)
- Production rate: 92% accurate
- Time saved vs writing from scratch: ~3 hours
- Time spent reviewing/editing: ~1 hour
- Net: ~2 hours saved

### Move 5 — The one-line summary

Meta-prompting is the LLM equivalent of an autocomplete starter — useful when you treat it as the first draft, dangerous when you treat it as the final draft, and the discipline that makes it useful is the same discipline that makes any code-review pass useful.

---

## How it works

### Move 1 — The mental model

A human writes a goal + constraints ("draft a prompt that classifies X into Y, using format Z, with examples from this data"). An LLM produces a prompt draft. A human reviews the draft, edits for accuracy + alignment with real codebase context, commits the final prompt to the repo via the same PR process as any other change. The LLM is the autocomplete; the human is the author.

```
   meta-prompting workflow
   ───────────────────────
   1. human:  write goal + constraints + real context
   2. LLM:    draft a prompt (typically 200-500 lines)
   3. human:  review, edit, remove hallucinations, fix labels
   4. PR:     review by another human, eval against test cases
   5. ship:   the final prompt is fully understood by the team
```

The discipline is that step 3 is the load-bearing one. Skipping it ships LLM hallucinations into production prompts; doing it well saves real time vs writing from scratch.

### Move 2 — The layered walkthrough

**Layer 1 — when meta-prompting saves time.** Initial drafts of complex prompts where the structure is mostly boilerplate (system role, label list, example pairs, edge-case rules). The LLM can produce a plausible scaffold in seconds; a human would take 30-60 minutes for the same structure. Net savings: ~30 minutes for prompts that would otherwise take an hour to scaffold.

```
   high-leverage meta-prompting cases
   ──────────────────────────────────
   initial draft of a new chain's prompt
   reformatting an existing prompt into a new style
   generating a set of few-shot examples covering a label space
   drafting an LLM-as-judge rubric for a new evaluation
```

If you're coming from frontend, this is the same shape as using Copilot to draft a component scaffold — the structure is repetitive, the LLM gets you 70% of the way, you finish the last 30% by hand. Concrete consequence: the workflow is "draft + edit," never "draft + ship."

**Layer 2 — when meta-prompting wastes time.** Small tweaks to existing prompts. The cost of writing the meta-prompt ("change this prompt so it does X instead of Y, keeping the same structure") plus the cost of reviewing the LLM's draft often exceeds the cost of just making the change directly. The break-even is "the change involves at least 50 lines and is mostly structural" — below that, edit directly.

```
   low-leverage meta-prompting cases
   ────────────────────────────────
   "add one more label to this classifier"
   "change the tone of one variant in this caption chain"
   "rename a field in the few-shot examples"
   ─────
   for these, edit the prompt directly; LLM meta-prompting overhead
   exceeds the gain
```

**Layer 3 — the review burden is the load-bearing cost.** The LLM produces a draft that LOOKS plausible. The reviewer's job is to check: are the rules accurate (no hallucinated edge cases)? Are the few-shot examples consistent (none mis-classified)? Do the schema references match the actual schema? Are the field names from the actual codebase? Catching all of this requires the reviewer to know the domain — meta-prompting without domain expertise is dangerous because the reviewer can't spot the hallucinations.

```
   what to check in an LLM-drafted prompt
   ──────────────────────────────────────
   labels: do they match the actual schema?
   examples: are they internally consistent?
   field names: do they exist in the data?
   edge-case rules: are they real (not invented)?
   tone: matches the existing chain's voice?
   token cost: did the LLM pad with unnecessary instructions?
   forbidden patterns: did the LLM include any banned phrases?
```

If you're coming from frontend, this is the same as code review for an autocomplete-suggested function — the suggestion may compile and look right; you still verify the logic. Boundary: meta-prompting with a model that's STRONGER than the prompt's target model often produces drafts the target model can't reliably follow (Claude Opus drafts a prompt with subtle instruction-following requirements; Sonnet running the prompt misses them). Match the drafter model's capabilities to the consumer model's capabilities.

**Layer 4 — amortisation decides whether the workflow earns its keep.** The reason a prompt becomes a meta-prompting candidate isn't "it's complex" — it's "it's complex AND it runs many times." A one-off prompt for a single chain saves you the ~30 minutes of scaffolding once; a prompt that gets re-invoked across thousands of contexts amortises every accuracy improvement across every invocation. An illustrative example outside buffr: the aipe meta-tooling project at `/Users/rein/Public/aipe/specs/` ships ~3000-line spec files (e.g. `specs/study.md`) that get invoked many times across different codebases; each spec is hand-curated rather than meta-prompted because at that amortisation level the accuracy cost of letting hallucinations slip through review outweighs every draft-time saving. The pattern recognition for buffr: none of buffr's 5 chain prompts hits that amortisation threshold. They're small, they run on a single codebase, they change rarely. Meta-prompting would cost more than it saved.

### Move 2.5 — Current state vs future state

Buffr today doesn't use meta-prompting for its 5 chains. The chain prompts were authored by hand, evolved through iteration, and live in their respective `.ts` files. That stays true unless a future chain crosses two thresholds at once: structurally complex draft (system role + 5+ few-shot + label list + edge cases) AND enough runtime amortisation to justify the review burden.

```
          Now (buffr)                          Later (hypothetical)
┌──────────────────────────────┐  ┌──────────────────────────────────┐
│ 5 chain prompts hand-written │  │ same 5 chains, hand-written      │
│ no meta-prompting in buffr   │  │ NEW: a complex chain (e.g.       │
│                              │  │ "themes across entries" or       │
│                              │  │ "tomorrow's prompts") whose      │
│                              │  │ initial draft justifies a        │
│                              │  │ meta-prompted scaffold + heavy   │
│                              │  │ human review pass                │
└──────────────────────────────┘  └──────────────────────────────────┘
   correct for current chains        meta-prompting appropriate only
                                     when complexity + amortisation
                                     both clear the threshold
```

### Move 3 — The principle

Meta-prompting is autocomplete. The LLM is the drafter; the human is the author and reviewer. The draft is raw material, never the final artefact. Skipping the review step ships LLM hallucinations into production; doing it well saves real time on the initial scaffolding.

The full picture is below.

---

## Meta-prompting — diagram

```
┌─ Human author ──────────────────────────────────────────────────────────┐
│  defines goal + constraints + real context (data shape, labels, etc.)   │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
┌─ Drafter LLM ───────────────────────────────────────────────────────────┐
│  generates draft prompt (200-500 lines)                                  │
│    structure: complete                                                    │
│    accuracy: needs verification                                          │
│    hallucinations: likely (invented rules, mismatched field names)       │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
┌─ Human reviewer ────────────────────────────────────────────────────────┐
│  reviews draft against real codebase + data                              │
│    remove hallucinations                                                  │
│    fix label inconsistencies                                              │
│    replace invented edge cases with real ones                            │
│    trim padding                                                          │
└──────────────┬──────────────────────────────────────────────────────────┘
               │
               ▼
┌─ Codebase ──────────────────────────────────────────────────────────────┐
│  final prompt enters via PR + eval pass                                  │
│  version-controlled (concept #3)                                         │
│  validated against eval set (concept #5)                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## In this codebase

**Not yet implemented — Case B.**

**Files:** `src/services/ai/summarize.ts`, `caption.ts`, `expand.ts`, `classify.ts`, `interpret.ts` — all 5 chain prompts were authored by hand and live as template literals in their respective chain files (roughly L40–L150 in each). No prompt in buffr is meta-prompted today; no draft-attribution convention exists in git history; no helper exists for invoking a drafter model against buffr's schema.

This is the correct shape for the current scope. Each chain prompt is small enough (under 200 lines), changes rarely enough (only on consumer-model upgrades or eval-driven iteration), and lives close enough to the code that consumes it that the meta-prompting workflow would add more review-burden cost than draft-time saving. The buildable target for meta-prompting in buffr is Project exercise `B3.19` below — applied to a future chain (not the existing 5) only if that chain crosses both the complexity and amortisation thresholds.

For an illustrative example of meta-prompting *at scale* (a setting where the workflow visibly earns its keep), the aipe meta-tooling project at `/Users/rein/Public/aipe/specs/*.md` is a clean reference — every spec is a hand-curated meta-prompt that, when invoked, generates substantial output (study guides, audit reports, refactor specs). The point of citing it here is the amortisation math: aipe's specs run thousands of times across many codebases, which is why even there the specs are hand-curated rather than meta-prompted themselves. None of buffr's chains are anywhere near that amortisation level.

---

## Elaborate

### Where this pattern comes from

The pattern is named in OpenAI's own developer documentation as far back as 2023; the practice of "use GPT to write your GPT prompts" was common enough by mid-2023 that the term meta-prompting was already in use. The discipline of "draft + edit" emerged from the production engineers who shipped meta-prompted prompts unedited and watched them fail.

### The deeper principle

Generated content is starting material, never finished material. Whether the generator is an LLM, a code template, or a scaffold tool, the discipline of human review before shipping doesn't change.

### Where this breaks down

When the reviewer lacks domain expertise — they can't spot the hallucinations, so the review is rubber-stamping. When the prompt is so small that meta-prompting overhead exceeds the gain. When the drafter model is significantly more capable than the target model (the draft uses instruction-following the target can't honour).

### What to explore next

- [03-prompts-as-code](./03-prompts-as-code.md) — meta-prompted prompts still enter the codebase as code; the prompts-as-code discipline still applies.
- [05-eval-driven-iteration](./05-eval-driven-iteration.md) — the eval set is what catches the drafter's hallucinations if the human review misses them.
- [13-forbidden-patterns](./13-forbidden-patterns.md) — LLM-drafted prompts often include the LLM's preferred phrasings (which become forbidden patterns the moment you notice the convergence).

---

## Tradeoffs

```
┌──────────────────┬───────────────────────────┬───────────────────────────┐
│ Cost dimension   │ Meta-prompting + review   │ Write prompts by hand     │
├──────────────────┼───────────────────────────┼───────────────────────────┤
│ Initial draft    │ ~30 sec (LLM call)        │ ~30-60 min (hand-write)   │
│ Review/edit      │ ~30-60 min (catch errors) │ Zero (just writing)       │
│ Net time saved   │ ~30 min on complex draft  │ Baseline                  │
│                  │ Negative on small tweaks  │                           │
│ Hallucination    │ Real — must be reviewed   │ Zero (you wrote it)       │
│ risk             │                           │                           │
│ Drafter model    │ Costs tokens per draft    │ Zero                      │
│ cost             │                           │                           │
│ Discipline       │ Required (review)         │ Required (write)          │
│ requirement      │                           │                           │
└──────────────────┴───────────────────────────┴───────────────────────────┘
```

### What we gave up

Meta-prompting costs you the review burden — every drafted prompt requires careful read-through to catch hallucinations, mismatched field names, invented edge cases, inconsistent few-shot examples. The cost is real engineering time; underestimating it is how meta-prompting fails.

### What the alternative would have cost

Writing complex prompts by hand from scratch costs 30-60 minutes per prompt. For prompts you'd write once and iterate forever (chain prompts), the meta-prompted draft saves ~30 minutes on the initial scaffolding. For prompts you'd write once and forget (one-off scripts), the savings barely register.

### The breakpoint

Meta-prompting earns its keep when the initial draft is structurally complex (system role + label list + 5+ few-shot examples + edge cases) AND the prompt runs often enough to amortise the review-burden cost. Below that, edit by hand. Buffr's 5 chain prompts sit below both thresholds today; if a future chain crosses them, meta-prompting becomes a real candidate for the initial scaffold.

---

## Tech reference (industry pairing)

### Drafter LLM (Claude Opus / GPT-4o for prompt drafting)

- **Codebase uses:** Not used in buffr for chain prompts. Could be used for new chain prompts via Anthropic's Claude Opus or OpenAI's frontier models.
- **Why it's here:** the drafter must be at least as capable as the target model. Drafting with a weaker model produces weaker drafts.
- **Leading today:** Claude Opus 4.x for prompt drafting — `adoption-leading` for high-quality drafts, 2026.
- **Why it leads:** strongest instruction-following + reasoning capability; understands the meta-task ("draft a prompt that will be consumed by an LLM").
- **Runner-up:** GPT-4o / o3 for cross-family drafts; useful when the consumer model is Claude and you want a drafter that doesn't share Claude's blind spots.

---

## Project exercises

### B3.19 — Use meta-prompting to draft a new chain prompt (if a new chain ships)

- **Exercise ID:** `[B3.19]`
- **What to build:** when a new chain is added to buffr (e.g., the hypothetical "tomorrow's prompts" generator), use Claude Opus to draft the initial prompt: provide goal, output schema, real example inputs from buffr's data, the existing chain prompts as style reference. Then EDIT the draft heavily: trim hallucinations, fix field-name mismatches, ensure consistency with buffr's tone. Commit the edited prompt with `Draft by Opus, edited by hand` in the commit message.
- **Why it earns its place:** captures the discipline in a commit-message convention. Anyone reading git blame later can see "this was meta-prompted but reviewed" — provides traceability.
- **Files to touch:** TBD — depends on which new chain ships.
- **Done when:** the chain's prompt is committed with the draft-attribution note; an eval pass against the chain's golden set is included in the commit.
- **Estimated effort:** comparable to writing the chain by hand, with ~30 min saved on the initial scaffolding offset by ~30 min of review.

---

## Summary

### Part 1 — concept recap

Meta-prompting uses an LLM to draft prompts for other LLM calls — useful for initial drafts of structurally-complex prompts where the draft saves significant scaffolding time, dangerous if the draft enters the codebase without human review. The workflow is: human writes goal + real context, LLM drafts, human reviews and edits, edited draft enters via PR. Buffr's 5 chain prompts are hand-written and that's the right call: they sit below both the complexity threshold (under 200 lines each) and the amortisation threshold (one codebase, rare changes) at which meta-prompting earns its keep. The pattern stays in this guide so the discipline is in hand if a future complex chain ever crosses both thresholds at once.

### Part 2 — key points to remember

- LLM is the drafter; human is the author and reviewer.
- The draft is raw material, never the final artefact.
- Review burden is the load-bearing cost — meta-prompting without careful review is worse than writing by hand.
- Earns its keep on structurally complex prompts; wastes time on small tweaks.
- The drafter should be at least as capable as the consumer; better, use cross-family for blind-spot independence.

---

## Interview defense

### What an interviewer is really asking

When an interviewer asks "do you use LLMs to write your prompts," they're testing whether you understand the review discipline. The answer that names "draft + edit, never draft + ship" is the answer of someone who's been burned. The answer that says "yes, it saves time" without naming the review is the answer of someone who hasn't.

### Likely questions

**Q [mid]:** When is meta-prompting worth doing?

**A:** When the initial draft is structurally complex enough that the LLM saves you ~30 minutes of scaffolding, and you have the domain expertise to review the draft for hallucinations. Concretely: new chain prompts with system + label list + 5+ few-shot + edge cases — meta-prompting saves time. Small tweaks to existing chains — write by hand, the overhead of drafting + reviewing exceeds the gain.

**Q [senior]:** When is hand-curating a prompt the right call instead of meta-prompting it, even when the prompt is large and structurally complex?

**A:** When the prompt's runtime amortisation is high enough that the accuracy cost of letting hallucinations slip through review outweighs every draft-time saving. The math is simple: a prompt that runs once costs you ~30 minutes if you write it by hand; a prompt that runs 3000 times costs you ~30 minutes × 3000 if a hallucinated rule produces a subtly wrong output every time. Hand-curating widely-used prompts trades draft-time for accuracy-over-many-invocations — correct trade for an artefact run repeatedly. For buffr, none of the 5 chain prompts hit that amortisation level (one app, one consumer, low change rate), so the question is moot today; the answer matters the moment a future chain or shared prompt template starts to.

```
   amortisation                       hand-curate?
   ─────────────                      ────────────
   prompt runs 1× (one-off script)    no — meta-prompting is fine
   prompt runs ~30× (a chain)         maybe — meta-prompt + careful review
   prompt runs 1000×+ (shared spec)   yes — hand-curate
```

**Q [arch]:** What changes about meta-prompting at scale (100× the number of chains)?

**A:** Two things. (1) The drafter model cost scales linearly — at 100 chains, the LLM draft calls + revision calls add up to real money during a sprint of new-chain development. (2) The review burden compounds — 100 chains × 30 min review each = 50 hours of review time per quarter. The architectural response: standardise the drafter prompt (the meta-prompt that drafts chain prompts) so the drafts are more consistent and the review is faster; build a shared library of vetted few-shot examples and forbidden-pattern blocks that get composed into new chains automatically; do NOT skip review.

### The question candidates always dodge

**Q:** What's the failure mode of LLM-drafted prompts that's invisible to even careful human review?

**A:** Drafter-induced convergence on phrasings. The drafter model (say, Opus) has preferred ways of structuring prompts — preferred system-prompt openings, preferred few-shot framings, preferred forbidden-pattern lists. When you meta-prompt 5 chains with Opus, all 5 chains inherit those phrasings. A reviewer reads each chain's prompt and sees "this looks fine"; the convergence across chains is invisible until someone notices that the captions across 4 buffr-style chains all start with "As we reflect..." because Opus generated the same forbidden-pattern reminder format four times. The fix is awareness — when you meta-prompt N chains, audit them as a SET for convergence, not just each one individually.

### One-line anchors

- LLM is the drafter; human is the author and reviewer.
- Draft is raw material; never the final artefact.
- Review burden is load-bearing; skipping it ships hallucinations.
- Worth it on complex new prompts; wastes time on small tweaks.
- Amortisation decides hand-curate vs meta-prompt: low-runtime prompts can be meta-prompted; high-runtime prompts get hand-curated because accuracy compounds.

---

## Validate your understanding

### Level 1 — Reconstruct the diagram

Draw the four-layer flow: human author defines goal → drafter LLM generates draft → human reviewer edits → codebase via PR + eval pass.

### Level 2 — Explain it out loud

Explain meta-prompting in under 90 seconds.

Checkpoints — did you:
- Name "draft + edit, never draft + ship" as the discipline?
- Name when meta-prompting is worth it vs not?
- Name aipe (or another example) as a meta-prompted system?

### Level 3 — Apply it to a new scenario

A new requirement: buffr should add a `themesAcrossEntries(entries: Entry[]) → Promise<Theme[]>` chain that identifies recurring themes across the user's writing.

Would you meta-prompt this chain's prompt? Why or why not? If yes, who's the drafter, what's the context you'd provide, what's the review focus? Sketch in 3-5 sentences.

### Level 4 — Defend the decision you'd change

Defend or oppose: "buffr should retroactively run all 5 chain prompts through a meta-prompted refactor pass — Opus drafts new versions, human reviews, ship the better ones."

### Quick check — code reference test

Without opening files:
- Are any of buffr's 5 chain prompts meta-prompted today?
- What are the two thresholds a future buffr chain would need to cross before meta-prompting earned its keep?
- What's the load-bearing cost of meta-prompting?

---
Updated: 2026-05-24 — voice/scope realignment per v1.38.0 spec (`In this codebase` rewritten as Case B for buffr; Layer 4 aipe block, Move 2.5, breakpoint paragraph, Summary Part 1, senior interview Q, and one-line anchors all reframed so aipe appears only as illustrative reference and amortisation/complexity thresholds become the load-bearing point).
