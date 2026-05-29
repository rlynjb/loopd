# Agentic coding system design

- **The prompt:** "Design an agentic coding assistant that takes a natural-language task, reads the relevant code, plans changes, edits files, runs tests/checks, and iterates until the task is done."

- **Standard architecture:**

  ```
  user task ("add a new endpoint that does X")
       │
       ▼
  ┌──────────────────────────────────┐
  │ Repo intake                       │  reads project context (existing
  │  (single-shot, deterministic)     │  index, conventions, recent edits)
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ Coding agent                      │  ReAct loop over a tool set:
  │  (ReAct loop)                     │
  │                                   │   tools:
  │  ┌─ tool surface ────────────┐   │     read_file(path)
  │  │ search_code(query)          │   │     write_file(path, content)
  │  │ list_files(dir)             │   │     run_tests(suite)
  │  │ read_file(path)             │   │     run_typecheck()
  │  │ write_file(path, content)   │   │     ask_user(question)
  │  │ apply_diff(diff)            │   │
  │  │ run_tests(suite)            │   │
  │  │ run_typecheck()             │   │
  │  │ ask_user(question)          │   │  Termination:
  │  └─────────────────────────────┘   │   tests pass + typecheck pass +
  │                                   │   no diff to suggest
  └──────────────┬───────────────────┘
                 │
        ┌────────┴────────┐
        ▼ success          ▼ blocked
   ┌────────────┐      ┌─────────────────────┐
   │ Patch      │      │ Surface blocker to  │
   │ submitted  │      │ user (ask_user tool │
   │ for review │      │ or partial-result   │
   └────────────┘      │ summary)            │
                       └─────────────────────┘
  ```

- **Data model:**
  - Task envelope: `{task_id, prompt, repo_id, branch_strategy, tool_caps, max_iters}` — the per-task config.
  - Tool call log: `{task_id, tool_name, args, result, ts}` — both for replay/debug and for tool-call-accuracy eval.
  - Trajectory: `{task_id, turn: [{thought, tool_call, observation}]}` — for trajectory eval and re-runs from a checkpoint.
  - Test/check results: `{task_id, suite, passed, failed, output}` — the feedback signal the agent reads each loop.
  - Patch: `{task_id, diff, files_touched, branch_name, base_sha}` — the artifact the agent produces.
  - Sandbox state: working tree + dirty file set per agent iteration; reset on retry, preserved across iterations within a task.

- **Key components:**
  - *Repo intake*: deterministic, not agentic. Reads project metadata once (file tree, language detection, test commands, code-conventions config). Decision: single-shot because the intake doesn't need to discover; the repo doesn't change mid-task.
  - *Coding agent*: ReAct loop with file-system and command-runner tools. Decision: this is a textbook ReAct agent — the path is genuinely data-dependent (which files to read depends on what `search_code` returns), and the model must decide when tests/typechecks pass well enough to stop.
  - *Tool surface*: read tools cheap and free-flowing, write tools gated (every `write_file` and `apply_diff` shows a diff; user confirms before commit if interactive; auto-applies in agentic mode). Decision: separate read from write at the tool boundary so the agent's autonomy is granular — it can explore freely, but state-changing actions are explicit.
  - *Test/check loop*: the agent's feedback signal. Decision: this is what makes the coding agent's loop work — the agent has an objective ground-truth signal (tests pass / typecheck passes) for "am I done?" Without this, the agent's stopping criterion is the model's self-assessment, which is unreliable.

- **Scale concerns:**
  - At ~10 tasks/hour per repo: per-tool latency dominates (test runs, typechecks). Fix: parallel test execution; cache typecheck results; pre-warm sandbox.
  - At ~100 concurrent agents (multi-tenant): rate limits on the provider hit before the tool surface does. Fix: per-task LLM-call budgets + provider rate-limiting (cross-ref [`../../study-ai-engineering/06-production-serving/04-rate-limiting-and-backpressure.md`](../../study-ai-engineering/06-production-serving/04-rate-limiting-and-backpressure.md)).
  - At repo-size scale (10M+ LOC): `search_code` becomes the bottleneck; full-text grep doesn't return useful top-k. Fix: code embeddings + symbol index (LSP-derived) + hybrid retrieval (cross-ref [`../../study-ai-engineering/03-retrieval-and-rag/06-hybrid-retrieval-rrf.md`](../../study-ai-engineering/03-retrieval-and-rag/06-hybrid-retrieval-rrf.md)).

- **Eval framing:**
  - Offline: trajectory eval (did the agent take a reasonable path?), tool-call accuracy (right args, right tool), patch quality (does it pass tests + typecheck + match style?), and pass@k for benchmarks (SWE-bench, HumanEval-derived).
  - Online: task success rate (final patch accepted), iteration count distribution (how many turns to converge?), human override rate (did a human intervene mid-task?), regression rate (did patches introduce new test failures?).
  - Critical metric: "silent destructive edits" — agent writes a file that removes important code while passing tests. Sample audits on `write_file` calls catch this; the model's self-assessment doesn't.

- **Common failure modes:**
  - Test gaming → agent edits tests to make them pass instead of fixing the underlying code. Mitigation: hard rule in the system prompt; sanity check that no test file changed unexpectedly; flag for review.
  - Infinite tool loop → agent re-runs the same `search_code` query expecting different results. Mitigation: loop detection (see [`../../study-ai-engineering/04-agents-and-tool-use/06-error-recovery.md`](../../study-ai-engineering/04-agents-and-tool-use/06-error-recovery.md)); force-stop on repeated identical tool calls.
  - Context-window overflow on large repos → the trajectory plus retrieved code exceeds the model's effective window; reasoning degrades. Mitigation: per-iteration trajectory summarisation; selective context (keep only currently-relevant files in the prompt, drop the rest).
  - Confident wrong patch → typecheck passes, tests pass, but the patch doesn't do what the user asked. Mitigation: light HITL (diff review before commit); regression tests; user acceptance step.

- **Applies to this codebase:** **no.** buffr is a daily-journaling app, not a developer tool. There is no code to edit, no tests to run, no patch to produce. The architecture's components (file-editing tools, test/check feedback loop, patch artifact) have no analogue in buffr's domain.

- **How to make it apply:** It doesn't, and there's no realistic refactor of buffr that would land here. This template applies to dev tools (Cursor, Claude Code, GitHub Copilot's agentic mode, Cline, Devin) — entirely different product domains. Read it for the interview-prep value: agentic coding assistants are a hot 2024–2026 interview topic, and walking this architecture lets you answer "design Cursor's agent mode" or "design Claude Code" without inventing. For buffr, the honest answer to "how would you adopt this?" is "I wouldn't — the domain doesn't match the architecture, and an interviewer asking 'design Cursor' expects you to walk this shape, not stretch buffr to fit it."
