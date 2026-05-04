# Preface — What this project is really about

loopd looks like a daily-vlogging app. That framing is the trap. The interesting part isn't the video — it's the data model underneath the journal text. A user types `[] call mom` on a Tuesday and `** banana 105 kcal` on a Wednesday and `#loopd shipped the scanner` on a Thursday, and three different scanners watch the same prose and project it into three different typed tables. The journal is the canonical input. Everything else — todos, nutrition rows, thread mentions, the dashboard, the streak counter, the LLM-driven vlog caption — is a derived view of prose the user already wrote. That's what the project is really about: an invariant that says *prose is the source, structured rows are projections*, and every line of code that holds that invariant up against the obvious failure modes (autosave races, focus cleanup races, out-of-order scanners, user overrides, AI ambiguity).

I built it solo, on Android only, with SQLite as the source of truth and Supabase as a sync mirror. The choices that matter aren't React Native vs Flutter or Anthropic vs OpenAI. They're: writes hit the database before they hit React state; scanners run at commit time, not on keystroke; the AI classifier never overrides a user-set type; the cloud lags by 5 seconds and the user's typed character is durable before any network call begins. These are not opinions, they are rules — and each one traces back to a specific data-loss bug or a specific cost decision.

What an interviewer should take from this project before asking me a single question:

1. I can name the rule that holds each subsystem together, and the failure mode that justifies it.
2. The "AI features" are not the architecture; they are the cheapest layer in a heuristic-first pipeline.
3. The complexity of the journal-to-typed-record projection is the real engineering work — every two-pass scanner is a tiny CRDT-style problem in disguise.
4. The project ships. It has eleven SQLite tables, ten of them mirrored to Postgres, and an FFmpeg-backed export pipeline. It is not a demo.

What this prep guide is for: I built the system; the guide turns what I already know into language I can use under pressure. It is targeted at the three things I most want to talk about — system design, DSA, and AI engineering — drawn from real files in this repository, not from a LeetCode set.
