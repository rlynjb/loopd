# 05 — Evals and observability

Five patterns for measuring and monitoring LLM systems. Eval sets gate prompt change; eval methods score; LLM-judge bias is the discipline that makes scores trustworthy; observability is the trace data; drift detection catches silent degradation.

## Concepts

1. **[Eval set types](./01-eval-set-types.md)** — golden / adversarial / regression. Three sets, three failure modes.
2. **[Eval methods](./02-eval-methods.md)** — six on a cheap-to-expensive ladder; match method to output mode.
3. **[LLM-as-judge bias](./03-llm-judge-bias.md)** — position, verbosity, self-preference; randomize, cap, cross-family.
4. **[LLM observability](./04-llm-observability.md)** — traces, spans, replay; local `ai_trace` table is minimum-viable.
5. **[Drift detection](./05-drift-detection.md)** — distribution shift over time; threshold alerts.

## What buffr exercises today

- **Case A (passive):** `validate.ts` does parse-shape validation (not quality eval).
- **Case B (everything else):** no eval sets, no eval runner, no observability, no drift detection.

Phase 3 of the curriculum builds the seven-suite eval harness (`B3.1`–`B3.10`) plus local `ai_trace` table (`B3.11`) plus drift detection (`B3.13`).

## Reading order

Read 1 first (what you score against); 2 second (how you score); 3 third (why scores can mislead); 4 fourth (the data that enables scoring + replay); 5 last (the monitoring layer that catches what point-in-time evals miss).
