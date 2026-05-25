# Tech support chatbot system design

**Industry name(s):** Customer support chatbot, RAG-grounded support assistant, tech support chatbot (IK Module 5)
**Type:** Industry standard

> Design a tech support chatbot that answers user questions grounded in a product's documentation and escalates when it can't.

**See also:** → [07-rag](../07-rag.md) · → [11-failure-modes](../11-failure-modes.md) · → [20-prompt-injection](../20-prompt-injection.md) · → [40-llm-caching](../40-llm-caching.md)

---

- **The prompt:** Design a tech support chatbot that answers user questions grounded in a product's documentation and escalates to a human when it can't.

- **Standard architecture:**

  ```
  Tech support chatbot — RAG + escalation gate

  ┌─ User turn ───────────────────────────────────────────┐
  │  user_message → safety filter → ingest                 │
  └───────────────────────────────────────────────────────┘
            │
            ▼
  ┌─ Conversation state ──────────────────────────────────┐
  │  Load conversation history (last N turns)              │
  │  Identify session, user_id, channel                    │
  └───────────────────────────────────────────────────────┘
            │
            ▼
  ┌─ Retrieval (RAG) ─────────────────────────────────────┐
  │  Reformulate query (history-aware)                     │
  │  Embed → vector store → top-K doc chunks               │
  │  Optional: BM25 hybrid for proper-noun questions       │
  └───────────────────────────────────────────────────────┘
            │
            ▼
  ┌─ Generation ──────────────────────────────────────────┐
  │  Prompt: system rules + retrieved docs + history       │
  │  Generate response with citation markers               │
  │  Structured output: { answer, confidence, citations,   │
  │                       should_escalate }                │
  └───────────────────────────────────────────────────────┘
            │
       ┌────┴────────────────────────┐
       │                             │
       ▼                             ▼
  ┌─ Confident answer ───┐    ┌─ Escalation gate ────────┐
  │ Stream to user        │    │ Hand off to human queue  │
  │ Log impression        │    │ Pre-fill conversation    │
  └──────────────────────┘    │ context for the agent    │
                              └──────────────────────────┘
  ```

- **Data model:**
  - `docs` — `{doc_id, content, version, product_area, updated_at}`. Source product documentation.
  - `doc_embeddings` — `{doc_id, chunk_index, vector, model}`. Indexed for retrieval.
  - `conversations` — `{conv_id, user_id, channel, started_at, status, ...}`. Long-lived support threads.
  - `messages` — `{message_id, conv_id, role, content, citations, confidence, ts}`. Turn-by-turn log.
  - `escalation_queue` — `{conv_id, escalation_reason, priority, agent_assigned}`. The handoff record.
  - `feedback` — `{message_id, user_thumbs_up_down, follow_up_resolved}`. Online metric source.

- **Key components:**
  - *Retrieval layer*: history-aware query reformulation followed by hybrid retrieval. Critical to handle multi-turn references ("the error I mentioned earlier"). Common choice: GPT-4o-mini for query rewriting, `text-embedding-3-small` for retrieval, `pgvector` for storage.
  - *Generator + grounding gate*: structured output with explicit `confidence` and `citations` fields. The LLM must cite which doc_ids it used; if no doc supports the claim, confidence is low and the gate escalates. Common choice: Sonnet 4.6 with JSON output and citation markers in the prompt.
  - *Escalation gate*: rule-based threshold on `confidence` + topic detection (refund / cancel / security keywords always escalate). Cheap to implement; high impact on user trust.
  - *Safety filter*: detect prompt injection, PII leaks, and content-policy violations on input AND output. See [20-prompt-injection](../20-prompt-injection.md).
  - *Cache layer*: prompt cache for the static system prompt + retrieved docs (Anthropic cache_control); semantic cache for FAQ-shaped repeated questions. See [40-llm-caching](../40-llm-caching.md).

- **Scale concerns:**
  - At ~10k conversations/day: doc retrieval latency starts mattering; cold-cache HNSW lookups hit ~50-100ms. Solution: pgvector with HNSW or a dedicated vector DB; query-embed caching for repeated questions.
  - At ~100 escalations/day: human queue depth becomes the bottleneck. Solution: priority queue with SLA targets; auto-routing by topic; pre-filled handoff context to halve agent triage time.
  - At ~1M docs (per-tenant in multi-tenant SaaS): per-tenant index isolation matters; cross-tenant data leakage is a real risk. Solution: separate indexes per tenant or strict metadata filtering on every retrieval.

- **Eval framing:**
  - Offline: rubric LLM-as-judge on (question, retrieved docs, generated answer) tuples — score for correctness, citation accuracy, escalation appropriateness.
  - Online: resolution rate (did the user stop asking?), escalation rate, time-to-resolution, CSAT post-conversation.
  - Adversarial: prompt-injection attempts, off-topic questions, requests for unsupported features, hostile users.
  - Regression set: every false-positive ("escalated when it shouldn't have") and false-negative ("answered when it should have escalated") goes into the set.

- **Common failure modes:**
  - *Hallucinated answers*: model generates plausible-sounding answer with no doc support. Mitigation: structured citations + grounding gate; refuse to answer when no doc cited.
  - *Stale docs*: product changed; docs not yet updated; bot confidently gives wrong instructions. Mitigation: doc-versioning column; surface "last verified" date; route to escalation on stale-doc detection.
  - *Multi-turn confusion*: bot forgets context after N turns; user has to restart. Mitigation: summary-of-conversation prompt component refreshed every M turns.
  - *Escalation flood*: every question escalates because confidence calibration is wrong. Mitigation: confidence calibration on a labelled set; tune threshold based on false-positive cost.
  - *Prompt injection via doc content*: malicious content in retrieved docs influences output. Mitigation: treat retrieved docs as untrusted input; separate system instructions from doc content in the prompt structure.

- **Applies to this codebase:** `no`. buffr is a journaling app, not a support product. There's no doc corpus to ground on and no users-with-questions to support. The template applies as a *thought experiment* — useful for interview prep, not as a buildable target in this repo.

- **How to make it apply:** Thought-experiment only. To make this template real, you'd need a different product: a hosted SaaS with documentation, paying users, support volume, and escalation infrastructure. The architectural patterns (RAG, escalation gate, citation-grounding, prompt-injection handling) are reusable across many domains, including buffr's own AI chains — they share retrieval, grounding, and output-validation discipline even though buffr doesn't have the chat-shaped surface.
