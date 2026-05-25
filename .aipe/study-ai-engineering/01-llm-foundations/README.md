# 01 — LLM foundations

The 9 operational patterns that distinguish a production LLM application from a working demo. Reading buffr's 5 chains in `src/services/ai/` requires understanding each of these — they're the discipline that makes the chains survive provider swaps, model changes, and user growth.

## Concepts

1. **[What an LLM actually is](./01-what-is-an-llm.md)** — function from string to string, stateless every call. The mental model that prevents 80% of LLM bugs.
2. **[Tokenization](./02-tokenization.md)** — text becomes tokens; tokens are what get priced, budgeted, and capped. Estimating from characters is unsafe past development.
3. **[Sampling parameters](./03-sampling-parameters.md)** — temperature, top-p, top-k. Wrong temperature is one of the most common LLM bugs (classifiers at 0.7; variants at 0).
4. **[Structured outputs](./04-structured-outputs.md)** — schema-enforced output at the provider API, plus runtime Zod validation. Prompt-only "respond in JSON" fails ~5% of the time.
5. **[Streaming responses](./05-streaming.md)** — token-by-token rendering for perceived latency. JSON chains can't meaningfully stream; markdown chains can.
6. **[Token economics](./06-token-economics.md)** — output tokens cost 3–5× input; per-chain logging is what enables targeted cost optimisation.
7. **[Heuristic-before-LLM](./07-heuristic-before-llm.md)** — rules for predictable inputs, LLM for the ambiguous remainder. Biggest cost lever buffr exercises.
8. **[Provider abstraction](./08-provider-abstraction.md)** — factor the request/response shape; keep messages, schema, validation uniform. Swap cost reducer.
9. **[User-override locks](./09-user-override-locks.md)** — any AI-written, user-editable field needs an override flag. Without it, re-runs silently erase corrections.

## What buffr exercises today

- **Case A (live):** structured outputs (all 4 JSON chains), sampling parameters (per-chain temperature), heuristic-before-LLM (classifier), provider abstraction (per-chain dispatch + `config.ts`), user-override locks (`todo_meta.user_overridden_type`).
- **Case B (not yet implemented):** tokenization-aware budgeting (`B1.2` adds `ai_call_log`), streaming (`interpret` is the build target), token economics logging (same `B1.2`).

## Reading order

If you're new to LLM application engineering: read in numeric order. The first three (what-is-an-LLM, tokenization, sampling) are foundational. The next two (structured outputs, streaming) are the I/O patterns. The last four (token economics, heuristic routing, provider abstraction, user-override locks) are the operational disciplines that make production possible.

If you're auditing buffr's AI surface: read 4, 7, 8, 9 first — those are the Case A patterns the codebase actively uses. Then 1, 2, 3 for grounding.
