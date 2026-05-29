# Multi-agent research assistant system design

- **The prompt:** "Design a multi-agent research assistant that takes a complex research question, plans the work, parallel-explores sub-questions across multiple specialist agents, and synthesises a grounded final report with citations."

- **Standard architecture:**

  ```
  user question
       │
       ▼
  ┌──────────────────────────────────┐
  │ Planner agent                     │  decomposes question into sub-questions
  │  (single-shot LLM call)           │  returns ordered task plan
  └──────────────┬───────────────────┘
                 │  task list (5–15 sub-questions)
                 ▼
  ┌──────────────────────────────────┐
  │ Supervisor agent                  │  routes sub-questions to workers;
  │  (ReAct loop)                     │  decides when enough material has been
  └──────────────┬───────────────────┘  gathered; calls synthesis
                 │
            fan-out
        ┌────────┼─────────┬──────────┐
        ▼        ▼         ▼          ▼
   ┌────────┐┌────────┐ ┌────────┐┌────────┐
   │worker 1││worker 2│ │worker 3││worker N│  per-worker ReAct loop:
   │        ││        │ │        ││        │  search → read → cite → return
   └────┬───┘└────┬───┘ └────┬───┘└────┬───┘
        │         │          │         │
        └────┬────┴──────────┴─────────┘
             │  findings + citations
             ▼
  ┌──────────────────────────────────┐
  │ Synthesizer agent                 │  integrates findings; resolves
  │  (single-shot LLM call)           │  contradictions; writes grounded
  └──────────────┬───────────────────┘  report with inline citations
                 │
                 ▼
            Final report
  ```

- **Data model:**
  - Task plan: `{question, sub_questions: [{id, text, depends_on, status}]}` — the planner's output, the supervisor's working state.
  - Per-worker trajectory: `{worker_id, sub_question_id, trace: [{thought, action, observation}], findings, citations}` — both for synthesis and for trajectory eval.
  - Citation index: `{citation_id, source_url, snippet, retrieved_at}` — keyed by stable id so the synthesizer can refer back without re-fetching.
  - Inter-agent message log: `{from, to, payload, timestamp}` — the audit trail for coordination eval.
  - Final report: `{question, report_md, citations: [citation_id], task_plan_id}` — links back to the plan and citations so the trace is reproducible.

- **Key components:**
  - *Planner*: produces the task plan once per question. Decision: single-shot structured-output call (not a loop) because the plan benefits from being deterministic per input; the supervisor re-plans only if it needs to.
  - *Supervisor*: the ReAct-style coordination agent. Decision: ReAct over plan-and-execute because real research surfaces dead ends and the supervisor needs to re-route. Termination conditions are non-negotiable (max parallel workers, max total LLM calls, time budget).
  - *Worker agents*: per-sub-question ReAct loops with search + read + cite tools. Decision: same prompt for every worker (specialised by the sub-question, not by an agent persona) — sub-domain specialisation is the wrong wall to chase here. If the sub-domains genuinely diverge (e.g. legal vs medical), wall 2 from the [`when-not-to-go-multi-agent`](../03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md) file justifies specialist workers.
  - *Synthesizer*: single-shot integration over the workers' findings. Decision: not a loop because integration is one pass over fixed input; if integration needed iteration, the supervisor would re-route, not the synthesizer.

- **Scale concerns:**
  - At ~100 questions/day: worker fan-out hits API rate limits at the provider before anything else. First fix: per-worker request queue + provider rate-limiting (see [`../../study-ai-engineering/06-production-serving/04-rate-limiting-and-backpressure.md`](../../study-ai-engineering/06-production-serving/04-rate-limiting-and-backpressure.md)).
  - At ~10k questions/day: supervisor's trajectory token count grows with the number of sub-questions; lost-in-the-middle starts degrading routing accuracy. Solution: per-sub-question summaries in the supervisor's context, not full traces.
  - At ~100k+: the synthesizer is the bottleneck — it receives every worker's findings. Solution: tiered synthesis (per-cluster synthesizers feeding a final synthesizer) — but only when measured.

- **Eval framing:**
  - Offline: planner sub-question quality (rubric LLM-judge); worker trajectory + tool-call accuracy + finding quality; supervisor routing decisions (correct worker per sub-question); synthesizer integration quality (faithfulness to findings, citation accuracy).
  - Online: end-to-end task completion rate (did the final report address the question?), citation hallucination rate (audit a sample), per-worker latency p95, supervisor termination correctness (stopped at the right time, not max-iter cap).
  - Mandatory triple eval: trajectory + tool-call + final, per agent type. Single end-to-end eval misses coordination bugs.

- **Common failure modes:**
  - Planner produces non-MECE sub-questions → workers do overlapping work; synthesizer can't integrate. Mitigation: planner output schema includes a `coverage_check` field with rubric.
  - Worker dead end → silently returns "no findings"; supervisor doesn't notice; final report is incomplete. Mitigation: workers return confidence; supervisor re-routes low-confidence sub-questions.
  - Citation hallucination → synthesizer writes a citation that doesn't appear in any worker's findings. Mitigation: hard schema constraint that every citation in the final report MUST match a `citation_id` in the index; reject and retry on violation.
  - Coordination loop / non-termination → supervisor keeps re-routing without progress. Mitigation: per-task LLM-call cap + monotonic progress check (sub-questions resolved per N iterations).

- **Applies to this codebase:** **no.** buffr is a daily-journaling app, not a research-assistant. There is no question-decomposition need, no parallel-exploration need, no synthesis stage. The chain shape covers buffr's compose pipeline; multi-agent orchestration would be paying coordination cost for no capability gain. None of the planned features cross into the research-assistant shape.

- **How to make it apply:** It doesn't, in any honest reading. The closest hypothetical: a "year in review" feature that researches recurring themes across a year of entries, produces sub-summaries per theme, and synthesises a final reflection. Even that's not really this architecture — themes aren't sub-questions, retrieval isn't open-web research, and a single agent with vector retrieval (see [`../../study-ai-engineering/03-retrieval-and-rag/11-rag.md`](../../study-ai-engineering/03-retrieval-and-rag/11-rag.md)) would cover the same ground without the planner/supervisor/synthesizer split. Read this template for the interview-prep value: when a question matches the shape, you can walk the architecture; when it doesn't match (like buffr), say so plainly.
