# buffr — AI engineering study guide

Topic-focused companion to `/aipe:study`. Covers AI engineering and machine learning concepts as they apply to **buffr** — a daily-vlogging journaling app with 5 production LLM chains under `src/services/ai/` and no ML surface (no trained models, recommenders, on-device inference).

Persona: staff engineer voice — same as `/aipe:study`. Hedging is banned. Diagrams first, prose second. Every concept file describes how buffr implements (or doesn't yet implement) the pattern; concepts buffr doesn't implement are explicitly Case B with the build target named.

## Codebase shape

**LLM application engineering.** Single-purpose chains, hand-picked retrieval, no RAG today, no agents, no on-device models. The detailed system map is in [`00-overview.md`](./00-overview.md); the per-feature pattern inventory is in [`ai-features-in-this-codebase.md`](./ai-features-in-this-codebase.md).

`ml-features-in-this-codebase.md` is intentionally **not generated** — buffr has no ML surface. Sub-sections `08-machine-learning/` and `09-ml-system-design-templates/` are skipped per the spec.

## Reading order

**If you're onboarding to the codebase:** read `00-overview.md` → `ai-features-in-this-codebase.md` → `01-llm-foundations/` in order. That covers what's actually live before walking the patterns that explain why.

**If you're prepping for interviews:** read `07-system-design-templates/` first (both files) — those reframe the codebase as standard interview prompts. Then walk concepts in the order the templates cite them.

**If you're working through the curriculum:** read sub-sections in numeric order. Case B files name the build target in the Project exercises block; they're how the curriculum's Phase 2A / Phase 3 / Phase 4 / Phase 5 maps into buffr-specific exercises.

## Sub-sections

- **[01-llm-foundations/](./01-llm-foundations/README.md)** — what an LLM is and the 9 operational patterns buffr exercises (tokenization, sampling, structured outputs, streaming, token economics, heuristic routing, provider abstraction, user-override locks).
- **[02-context-and-prompts/](./02-context-and-prompts/README.md)** — context window mechanics, lost-in-the-middle, multi-step prompt chaining (buffr's `summarize → caption` is live).
- **[03-retrieval-and-rag/](./03-retrieval-and-rag/README.md)** — embeddings, chunking, vector storage, the full RAG pipeline. Mostly Case B (principle #11: no RAG until above threshold).
- **[04-agents-and-tool-use/](./04-agents-and-tool-use/README.md)** — chains vs agents, tool calling, ReAct, routing, memory, error recovery. All Case B.
- **[05-evals-and-observability/](./05-evals-and-observability/README.md)** — golden / adversarial / regression sets, eval methods, judge bias, LLM observability, drift. Mostly Case B.
- **[06-production-serving/](./06-production-serving/README.md)** — caching, cost optimization, prompt injection, rate limiting, retry + circuit breaker. Partly Case A.
- **[07-system-design-templates/](./07-system-design-templates/README.md)** — Search ranking + Tech support chatbot reframed as interview prompts.

## What's not here

- **Prompt engineering as a discipline** — covered separately in [`.aipe/study-prompt-engineering/`](../study-prompt-engineering/) with a different persona (working AI engineer, not staff engineer).
- **System design + DSA** — covered in [`.aipe/study-system-design-dsa/`](../study-system-design-dsa/).
- **Machine learning** — buffr has no ML surface; sub-sections 08 and 09 are skipped.
