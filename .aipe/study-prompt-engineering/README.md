# Prompt engineering — study guide

Topic-focused companion to `/aipe:study`. Per-repo scope — describes how **this codebase (buffr — daily-journaling app with 5 production AI chains under `src/services/ai/`)** uses each pattern. Other meta-tooling codebases (aipe and similar) appear only as illustrative pattern references where they sharpen a take; the file you're reading is about buffr.

Voice: working AI engineer who has shipped production LLM systems. Hedging is banned. First-person where it earns its place. Concrete bugs, specific dates, specific phrasings — not "best practices" prose.

## Reading order

**Operational discipline first** (01–05) — these are the habits that distinguish amateur from professional prompt work. Read these before any of the techniques.

- **[01 — Anatomy of a production prompt](./01-anatomy.md)** — the four sections (system / context / examples / user) and why mixing them is how prompts drift.
- **[02 — Structured outputs via tool calling and schemas](./02-structured-outputs.md)** — schema-first prompting, parser-fail retry loops, the courteous-markdown-fence bug.
- **[03 — Prompts as code: versioning and observability](./03-prompts-as-code.md)** — markdown templates as source code, the prompt-and-model-version pairing, deployment.
- **[04 — Token budgeting and context window management](./04-token-budgeting.md)** — count tokens or one model bump truncates your chain. The 80% rule, lost-in-the-middle, prefix caching.
- **[05 — Eval-driven prompt iteration](./05-eval-driven-iteration.md)** — the senior-vs-junior line. Golden set, regression suite, LLM-as-judge. Hamel Husain's writing as the canonical reference.

**Specific techniques** (06–13) — each addresses a named failure mode.

- **[06 — Single-purpose chains](./06-single-purpose-chains.md)** — one chain, one job. When something fails, you know which chain failed.
- **[07 — Output mode mismatch](./07-output-mode-mismatch.md)** — chain A returns JSON, chain B expects markdown, parser breaks. The bug class.
- **[08 — Few-shot prompting](./08-few-shot.md)** — examples constrain output more than instructions. Three good ones beats twenty mediocre.
- **[09 — Chain-of-thought (CoT)](./09-chain-of-thought.md)** — when reasoning helps, when it wastes tokens, the modern caveat (frontier models do it internally).
- **[10 — Self-critique and self-consistency](./10-self-critique.md)** — 2–5× the token budget for one extra step of reliability. When the cost is worth it.
- **[11 — Meta-prompting](./11-meta-prompting.md)** — using an LLM to write prompts for another LLM call. aipe's hidden engine.
- **[12 — Prompt injection defenses (author side)](./12-prompt-injection-defense.md)** — defense-in-depth for prompts that interpolate user input.
- **[13 — Forbidden patterns and rotating formulas](./13-forbidden-patterns.md)** — LLMs converge on phrasings. Enumerate forbidden openings. Rotate formulas.

## The 13 concepts at a glance

| # | Concept | What it gets wrong if you skip it |
|---|---|---|
| 01 | Anatomy | Prompts drift because system/user/context get mixed; no one place to look. |
| 02 | Structured outputs | Parser breaks when a model courteously wraps JSON in a markdown fence. |
| 03 | Prompts as code | A working Sonnet-3 prompt regresses 30% on Sonnet-4 and there's no version log. |
| 04 | Token budgeting | A chain truncates at scale because nobody counted; the 80% rule was crossed last month. |
| 05 | Eval-driven iteration | The "better" prompt regresses on the one critical edge case nobody was tracking. |
| 06 | Single-purpose chains | A multi-purpose chain fails silently because nothing tells you which step broke. |
| 07 | Output mode mismatch | Two chains in a pipeline disagree on JSON-vs-markdown; integration tests don't catch it. |
| 08 | Few-shot | A classifier reads the instruction "respond with one of these labels" and invents new labels anyway. |
| 09 | CoT | A simple classifier gets slower and more expensive because someone added "think step by step." |
| 10 | Self-critique | A high-stakes journal-edit chain ships a bad rewrite the user has to manually undo. |
| 11 | Meta-prompting | Prompts that read like LLM output instead of engineering specs. |
| 12 | Prompt injection | User input contains "ignore previous instructions" and the system prompt loses. |
| 13 | Forbidden patterns | Every caption variant starts with "As you reflect on…" because nobody banned it. |

→ **Start with [00-overview.md](./00-overview.md)** if you want the discipline summarised on one page. → **Skip to the file matching the bug you're chasing** if you came here from a production failure.

---
