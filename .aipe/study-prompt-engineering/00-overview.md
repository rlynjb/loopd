# Prompt engineering — overview

Prompt engineering is the discipline of designing, versioning, evaluating, and defending the text inputs you send to a large language model so the outputs survive production. Most of it is operational hygiene, not clever phrasing: counting tokens, keeping prompts in version control with the model version they were validated against, building an eval set, treating user input as data not instructions. The clever phrasing matters too — few-shot examples constrain harder than instructions, chain-of-thought helps multi-step problems and wastes tokens on simple ones — but a codebase that nails the operational discipline and ignores the techniques outperforms the reverse every time.

## The portfolio anchors

- **buffr** (formerly loopd) — daily-journaling app at `/Users/rein/Public/buffr/`. Five production AI chains: `summarize` (structured daily summary), `caption` (4 tonal variants per day), `expand` (per-todo typed structured expansion), `classify` (thinking-mode classifier with heuristic-first short-circuit), `interpret` (long-form markdown reflection). Two providers (Anthropic primary, OpenAI alternate). All chains live under `src/services/ai/`.
- **aipe** — meta-tooling at `/Users/rein/Public/aipe/`. Owns the curriculum (`prompts/aieng-curriculum.md`), the skill specs (`specs/study.md`, `specs/refactor.md`, etc.), the slash commands (`commands/`), and the skill wrappers (`skills/`). Every spec is itself a production prompt — when a user invokes `/aipe:study`, that spec is the prompt the agent runs against.

## Operational discipline first (01–05)

These are non-negotiable for production prompt work. Skipping them isn't faster — it's slower, because you iterate in circles.

- **01 Anatomy.** Four sections per prompt: system, context, few-shot examples, user message. Each has one job. Mixing them is how prompts drift. **Skip-cost:** instructions land in user-message that should be in system; system-message accumulates per-call context that should be in context; nobody can find where to change what.
- **02 Structured outputs.** Schema-first prompting + parser validation + retry-on-fail. Telling the model "respond only in JSON" in 2026 is amateur — use the provider's structured output mode and validate the parse. **Skip-cost:** a courteous model wraps your JSON in a markdown code fence the day a new model version ships, parser breaks, prod 500s.
- **03 Prompts as code.** Markdown files in git, reviewed in PRs, paired with the model version they were validated against. **Skip-cost:** a prompt that worked on Sonnet-3 regresses 30% on Sonnet-4 and there's no version log showing which prompt produced which bad output.
- **04 Token budgeting.** Count tokens. Allocate budget per section. Stay under 80% of the context window. Know about lost-in-the-middle and prefix caching. **Skip-cost:** a chain that worked fine on small inputs starts truncating or timing out at scale because the retrieval set grew.
- **05 Eval-driven iteration.** Golden set of 20–50 hand-curated cases. Regression suite that grows from production failures. Change prompt → run evals → keep change only if it improves without regressions. Hamel Husain's writing is the canonical reference. **Skip-cost:** a "better" prompt improves average score but regresses on one critical edge case nobody was tracking.

## Specific techniques (06–13)

These are tools, not discipline. Reach for them when the diagnosis matches the pattern — applying them without the underlying problem is how prompts get cluttered.

- **06 Single-purpose chains.** One chain, one job. Pipeline them. **Skip-cost:** a multi-purpose chain fails silently because nothing tells you which step broke.
- **07 Output mode mismatch.** Each chain declares one output mode. **Skip-cost:** chain A returns JSON, chain B expects markdown, integration tests don't catch it.
- **08 Few-shot.** Three good examples beat twenty mediocre ones. Use for classifiers and format-sensitive tasks; skip for open-ended generation. **Skip-cost:** a classifier reads the label list and invents new labels anyway.
- **09 Chain-of-thought.** Helps multi-step reasoning. Wastes tokens on simple lookups. Frontier models do CoT internally now — explicit asks matter less than they did. **Skip-cost:** every classifier got slower and more expensive after someone added "think step by step" globally.
- **10 Self-critique and self-consistency.** Ask the model to evaluate its own output, or run the prompt N times and vote. 2–5× the cost. **Skip-cost:** a high-stakes generation (journal-edit) ships a bad output the user has to manually undo, and there's no second pass to catch it.
- **11 Meta-prompting.** Use an LLM to draft prompts for another LLM call. Useful for initial drafting, dangerous if the output enters the codebase unedited. **Skip-cost:** prompts that read like LLM output instead of engineering specs.
- **12 Prompt injection defenses.** Instruction hierarchy, input delimiters, structured-output-as-defense. Not fully solved — defense-in-depth is the framing. **Skip-cost:** user input contains "ignore previous instructions" and the system prompt loses.
- **13 Forbidden patterns and rotating formulas.** LLMs converge on phrasings. Enumerate forbidden openings. **Skip-cost:** every caption variant starts with "As you reflect on…" because nobody banned it.

## What this guide does not cover

Vendor-specific syntax quirks (those live inside individual files' Tech reference blocks, not as standalone concepts). Tree-of-Thoughts and academic prompt research (real research, not production practice). Constitutional AI / alignment-style prompting (important for safety-critical apps, not what this guide is for). Vision and multi-modal prompting (not exercised by buffr or aipe). Jailbreak research from the attacker side (the defender side is concept 12). The history of prompt engineering as a field.

## How to read this

If you came from a production failure, skip directly to the file matching the bug. If you're new to the discipline, read 01–05 in order, then jump around the techniques as the codebase calls for them. If you're auditing a system that uses LLMs, the Validate block at the end of each file tells you what good looks like — a reader who can pass Level 4 on each of 01–05 has the operational discipline; the techniques follow from that base.
