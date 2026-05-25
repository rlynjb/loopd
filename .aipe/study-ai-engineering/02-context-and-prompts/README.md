# 02 — Context and prompts

Three patterns for managing the model's input: budgeting the context window, placing content where attention is strong, and chaining single-purpose calls into pipelines.

## Concepts

1. **[Context window](./01-context-window.md)** — fixed token budget per call; input and output share it; quality degrades around 80% utilisation (lost-in-the-middle).
2. **[Lost in the middle](./02-lost-in-the-middle.md)** — attention is U-shaped across context position; place important content at start or end, never in the middle.
3. **[Prompt chaining](./03-prompt-chaining.md)** — split multi-step tasks into single-purpose chains piped via Zod-shaped contracts; cache at chain boundaries.

## What buffr exercises today

- **Case A (passive):** context window utilisation is far under 5% across all chains — context isn't the constraint today.
- **Case A (passive):** position-aware ordering in `prompt.ts` puts the user's question at the strongest position (end); the rule is implicit, not yet documented.
- **Case A (active):** prompt chaining is live in two pipelines (`summarize → caption` via `compose.ts`; `classify → expand` via `reconcileMeta.ts`); both cache at the chain boundary.

## Reading order

Read 1 first to establish the budget; 2 for the position rule that emerges from it; 3 for how chains compose under the budget constraint. All three apply to buffr's existing chains as `compose.ts` and `prompt.ts` show.
