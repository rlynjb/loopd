# buffr — todo

## Up next

- [ ] **Build `tests/evals/classify.gold.json`** — ~10 hand-labeled real entry lines as the seed for the eval substrate. Walks through the six-step drill at `.aipe/drills/eval-design-llm-judge-classify.md` (build naive LLM-as-judge → induce verbosity/confidence bias → rubric'd-judge fix → bias-trap regression set). This file is the **first concrete commit** the Gemma plan (`.aipe/plans/gemma-integration.md`) calls out as a gate for Phase D — flipping per-chain defaults from Claude/OpenAI to Gemma. The recon (`.aipe/audits/recon-2026-06-03.md`) names "no evals" as the **load-bearing L0 cap** on every chain-related competency.

## Cross-references

- Recon TRACK queue (8 items): `.aipe/audits/recon-2026-06-03.md`
- Eval drill writeup (the six-step rep): `.aipe/drills/eval-design-llm-judge-classify.md`
- Gemma plan v3 (Phase D gate condition): `.aipe/plans/gemma-integration.md`
