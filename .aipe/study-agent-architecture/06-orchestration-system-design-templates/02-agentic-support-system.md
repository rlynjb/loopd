# Agentic support system design

- **The prompt:** "Design an agentic customer support system that handles incoming tickets, classifies intent, retrieves relevant context, drafts a response, escalates when needed, and learns from resolved tickets."

- **Standard architecture:**

  ```
  incoming ticket (channel: email / chat / web form)
       │
       ▼
  ┌──────────────────────────────────┐
  │ Intent router                     │  heuristic-first (keyword + regex)
  │  (heuristic → LLM fallback)       │  then LLM classifier on ambiguous
  └──────────────┬───────────────────┘  cases. Output: {intent, confidence}
                 │
        ┌────────┴────────┐
        │ confidence high?│
        └────────┬────────┘
                 │
        ┌────────┴────────┐
        ▼ yes              ▼ no — escalate to human
   ┌────────────────────┐  ┌────────────────────┐
   │ Support agent       │  │ Human-in-the-loop  │
   │ (ReAct loop)        │  │ queue              │
   │  tools:             │  └────────────────────┘
   │   search_kb         │
   │   lookup_customer   │
   │   get_ticket_history│
   │   draft_response    │
   │   request_handoff   │
   └──────────┬─────────┘
              │
       ┌──────┴──────┐
       │ confident?  │
       └──────┬──────┘
              │
       ┌──────┴──────┐
       ▼ yes          ▼ no — escalate
   ┌─────────────┐  ┌───────────┐
   │ Send draft  │  │ Human     │
   │ for review  │  │ takeover  │
   │ (light HITL)│  └───────────┘
   └──────┬──────┘
          │
          ▼
   resolution + ticket close
          │
          ▼
  ┌──────────────────────────────────┐
  │ Feedback loop                     │  resolved-ticket → eval set;
  │  (offline)                        │  miscategorised → retraining
  └──────────────────────────────────┘
  ```

- **Data model:**
  - Tickets: `{id, channel, customer_id, body, intent, confidence, status, created_at, resolved_at}` — the canonical record.
  - Knowledge base (KB) chunks: `{kb_id, text, embedding, last_updated, source_doc}` — for the support agent's retrieval tool.
  - Ticket history: `{ticket_id, turn: [{role, content, tool_calls, observations}]}` — the trajectory the agent works against.
  - Customer profile: `{customer_id, plan, tier, recent_tickets, known_issues}` — looked up via tool, not stuffed in every prompt.
  - Eval set: `{ticket_snapshot, expected_intent, expected_resolution_class}` — grown from resolved tickets, curated.
  - Drift log: per-intent classification rate over time, escalation rate per intent — the signal for retraining/re-prompting.

- **Key components:**
  - *Intent router*: heuristic-first dispatch on common patterns (`"refund"`, `"reset password"`, `"cancel subscription"`), LLM classifier on the rest. Decision: same shape as buffr's [`heuristicClassify`](../../study-ai-engineering/01-llm-foundations/07-heuristic-before-llm.md) — the cheap deterministic gate that lets the LLM see only ambiguous cases.
  - *Support agent*: ReAct loop with a tool set, not a chain. Decision: this is genuinely an agent — the path is data-dependent (a refund ticket may or may not need ticket history, may or may not need KB search), and which tools to call in which order depends on what the agent finds. Cross-ref [`../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`](../../study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md) for mechanics.
  - *Human-in-the-loop layer*: two tiers — full escalation (intent or response low-confidence; human takes over), and light review (agent confident, human approves before sending). Decision: light review only on high-stakes intents (refunds, account closure); skip on low-stakes (FAQ, password reset).
  - *Feedback loop*: every resolved ticket flows back into the eval set. Decision: keep this offline (batch) — online eval-driven retraining is a much bigger build that doesn't earn its keep until ticket volume is high.

- **Scale concerns:**
  - At ~1k tickets/day: the support agent's tool calls hit KB-retrieval latency before anything else. First fix: KB embeddings + vector search (see [`../../study-ai-engineering/03-retrieval-and-rag/11-rag.md`](../../study-ai-engineering/03-retrieval-and-rag/11-rag.md)) instead of full-text scan.
  - At ~10k tickets/day: per-agent rate limits hit the provider. Fix: request queue with backpressure (cross-ref [`../../study-ai-engineering/06-production-serving/04-rate-limiting-and-backpressure.md`](../../study-ai-engineering/06-production-serving/04-rate-limiting-and-backpressure.md)); shard by intent class to allow priority for low-stakes (high-volume) over high-stakes (low-volume).
  - At ~100k+ tickets/day: KB freshness becomes the bottleneck. Fix: incremental indexing on doc updates (cross-ref [`../../study-ai-engineering/03-retrieval-and-rag/10-incremental-indexing.md`](../../study-ai-engineering/03-retrieval-and-rag/10-incremental-indexing.md)) + stale-embedding tracking.

- **Eval framing:**
  - Offline: intent classifier per-class F1 (cross-ref the eval-set-types file in study-ai-engineering); agent trajectory + tool-call accuracy + final response quality; escalation precision (was the agent right to escalate?).
  - Online: first-response time, deflection rate (resolved without human), customer satisfaction post-ticket, escalation rate per intent, agent-to-human handoff acceptance rate.
  - Critical metric: "silent wrong answers" — agent confidently sends a response that the customer doesn't push back on but is factually wrong. Sample audits on a fraction of high-confidence resolutions catch this; it's the failure mode you can't see in aggregate metrics.

- **Common failure modes:**
  - Intent mis-classification → ticket routed to the wrong workflow; either escalated unnecessarily (waste) or resolved with the wrong intent's tools (silent wrong answer). Mitigation: confidence threshold + adversarial eval set covering common confusions.
  - KB drift → agent retrieves stale or removed content; cites a policy that no longer applies. Mitigation: `last_updated` on every KB chunk; agent prompted to flag if any retrieved chunk is older than N months for high-stakes intents.
  - Agent loop / non-termination → max-iter cap is the floor; below that, "force-stop on N tool calls without confidence growth." See [`../../study-ai-engineering/04-agents-and-tool-use/06-error-recovery.md`](../../study-ai-engineering/04-agents-and-tool-use/06-error-recovery.md).
  - Escalation cascade → low-confidence threshold escalates 60% of tickets; the human queue saturates; SLAs miss. Mitigation: tune threshold per intent (refund: low threshold acceptable; FAQ: high threshold required); track escalation rate as a SLO.

- **Applies to this codebase:** **no.** buffr is a single-user journal app; there is no support surface, no ticket queue, no customer to route, no KB to retrieve from. The architecture doesn't map to anything buffr does — and importantly, even buffr's heuristic-first classifier (which structurally resembles this template's intent router) is doing a different job (per-todo classification, not per-ticket dispatch).

- **How to make it apply:** It doesn't, in any honest reading of buffr's product. The closest hypothetical is an "AI Q&A assistant" that answers questions about your own journal entries — but that's a single-agent + RAG architecture (see [`../../study-ai-engineering/03-retrieval-and-rag/11-rag.md`](../../study-ai-engineering/03-retrieval-and-rag/11-rag.md)), not a multi-tier support system, because there's no escalation path and no human-in-the-loop in a single-user app. Read this template for the interview-prep value: when a question matches the shape (any system with classify → retrieve → respond → escalate), you can walk the architecture; when it doesn't (like buffr), say so plainly and name what shape the actual feature would take instead.
