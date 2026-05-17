# 08 — Developer process

> **Spec-driven, phased shipping, manual test on physical device.** No CI, no test suite, no hot-reload. Each of those is a deliberate tradeoff at solo-app scale, and I should be ready to defend the *absence* of each as honestly as I defend the *presence* of the rest.

The development loop on buffr is opinionated and tight. I write the spec before I write the code. Major features get a separate plan document. Build-and-install runs against a physical Android device — no metro, no emulator, no hot reload. The whole round trip from edit-to-installed-build is about 30 seconds for incremental builds, 3-5 minutes for cold builds. This is slower than a hot-reload setup, but the gain is that I'm always testing what users would actually run — release builds with bundled JS, production-mode optimizations, and the actual filesystem and SQLite paths that a real install would have.

The thinking-modes feature is the cleanest example of how the spec-and-phase pattern works in practice. The original spec was 33-50 hours estimated as a monolith. I sliced it into four phases — foundation + UI restructure (no LLM), classifier + boot catch-up, expansion modal + per-type prompts, Notion sync extension — and shipped each phase independently. After Phase A I had categorized todos with no LLM cost at all. Phase B added classification. Phase C added expansion. Phase D added sync. Each phase was a complete, defensible feature on its own, documented in [`docs/buffr-thinking-modes-spec.md`](../../../docs/buffr-thinking-modes-spec.md).

The thing I'm honestly weakest on is testing. There's no automated test suite. The pure functions in [`scanTodos.ts`](../../../src/services/todos/scanTodos.ts) and [`scanNutrition.ts`](../../../src/services/nutrition/scanNutrition.ts) are *the most testable code in the project* — clear input/output contracts, no I/O dependencies, deterministic behavior — and I haven't written tests for them. The reason is solo-scale dogfood: I run the app every day, on my own data, and bugs surface within a day of shipping. At any larger scale this is non-negotiable Day-1 work.

```
              Build / install / debug loop

  edit source code
       │
       ▼
  ┌──────────────────────────────────┐
  │  npx tsc --noEmit                │  ~3-5s
  │  (catch type errors before       │  (every change)
  │   any rebuild)                   │
  └──────────────────┬───────────────┘
                     │
                     ▼
  ┌──────────────────────────────────┐
  │  cd android && ./gradlew         │  ~25-50s incremental
  │    :app:assembleRelease          │  ~3-5min cold build
  │                                  │
  │  release builds, not dev —       │
  │  matches what users actually run │
  └──────────────────┬───────────────┘
                     │
                     ▼
  ┌──────────────────────────────────┐
  │  adb install -r                  │  ~10s
  │    app/build/outputs/apk/...     │
  └──────────────────┬───────────────┘
                     │
                     ▼
  ┌──────────────────────────────────┐
  │  Manual smoke-test on physical   │
  │  Samsung device — actual user    │
  │  flow, end-to-end                │
  └──────────────────────────────────┘

  Round trip: ~30s for incremental builds.
  Tradeoff: lose hot reload, gain "what users actually run."
  Mitigation: batch 2-5 related edits per cycle.

  No CI today. At a job, npx tsc + emulator smoke test
  would gate every PR.
```

## Interview questions

### Q1 [mid] How do you test this code?

Mostly by hand. I install the release APK on a physical Android device after every meaningful change and verify the user-facing behavior. There's no automated test suite.

What I do have: strict TypeScript catches a class of bugs at compile time. CHECK constraints in SQLite catch enum violations at insert time. Discriminated unions force exhaustive case handling in the type system. Together these catch maybe 40% of bugs that would otherwise be runtime issues.

What's missing and I'd prioritize: unit tests for [`scanTodos.ts`](../../../src/services/todos/scanTodos.ts) and [`scanNutrition.ts`](../../../src/services/nutrition/scanNutrition.ts) — they're pure functions with clear input/output contracts, perfect for testing. Tests for [`sync/conflict.ts`](../../../src/services/sync/conflict.ts) — `chooseWinner(local, cloud)` is pure and the LWW semantics are exactly the kind of code that breaks subtly when refactored. A fixture-based eval for the heuristic classifier — accuracy on a real corpus of `[]` lines.

The honest answer to "why no tests": I prioritized shipping the feature surface fast, and I'm the only user. Bugs that would matter to other users surface in my own data within a day. At a job I'd treat the parser tests as Day-1 invariants, not Day-30 cleanup. I'm fluent in Vitest and Jest; I just haven't established the loop here.

### Q2 [senior] Walk me through your build → install → debug loop.

The sequence: `npx tsc --noEmit` first to catch type errors before any compile, then `cd android && ./gradlew :app:assembleRelease` (~25-50s incremental, ~3-5 minutes cold), then `adb install -r android/app/build/outputs/apk/release/app-release.apk` to deploy to my Samsung. Round trip is about 30 seconds for incremental changes.

I install release builds rather than dev builds. The reason is that I want to test what users would actually run, and I don't need React Native's Metro bundler for this workflow — the JS is bundled into the APK. The deliberate tradeoff: I lose hot reload, so every change is a full rebuild and install. The mitigation is *batching* — I make 2-5 related edits before I install. For UI tweaks where iteration matters, I'll occasionally use Metro for live reload, but for anything touching the DB schema, the AI integrations, or native code, release builds are the only honest test.

What I'd add at a job: a CI pipeline that builds and runs an emulator-based smoke test on every PR. Right now my "CI" is `npx tsc --noEmit` run before every install. That catches the type errors but nothing else. A modest emulator suite — boot the app, navigate to /todos, tap a todo, verify the modal opens — would catch rendering and integration regressions that typecheck doesn't.

### Q3 [arch] How do you make architectural decisions on a solo project?

I write specs before code, and I phase big features.

[`docs/spec.md`](../../../docs/spec.md) is the living architectural reference — every major decision is documented there with rationale. Major features get a separate plan document. The thinking-modes feature shipped via a 4-phase plan documented in [`docs/buffr-thinking-modes-spec.md`](../../../docs/buffr-thinking-modes-spec.md). Each phase was independently shippable and each had its own scope estimate, success criteria, and explicit non-goals.

When I disagreed with a spec the AI assistant produced — like the original drops spec assuming a Next.js / Netlify stack instead of RN/Expo — I rewrote the plan from scratch with the right substrate before any code was written. The willingness to push back on a specification is what makes the AI useful instead of dictatorial.

The principle: big features die in long branches. Slice by *value-delivery*, not by *layer*. Phase A of thinking-modes gave me categorized todos with no LLM at all (heuristic + manual override + restructured UI). Phase B added the classifier. Phase C added expansion. Phase D added Notion sync. Each phase shipped a complete, testable feature.

The same discipline carried into a much bigger migration: replacing Notion sync with Supabase Postgres. That work shipped across 7 milestones (M0–M7) documented in [`docs/buffr-cloud-sync-plan.md`](../../../docs/buffr-cloud-sync-plan.md). M0 was schema-only (no app changes); M1 was push-only on a single table (entries); M2 added pull and the remaining 9 tables; M3 was the riskiest milestone — soft-delete migration with a read-path audit (every `SELECT` on a synced table needed `WHERE deleted_at IS NULL`); M4 wired in boot-time auto-sync and debounced edit push; M5 polished the settings page with a hidden dev menu; M6 was the dogfooding window; M7 was the satisfying delete (–3,357 lines of Notion code in one commit). Each milestone left the app in a working state. Each one was independently revertible. The whole migration was conservative on purpose — Notion stayed live alongside Supabase from M2 through M6 so I had a safety net while the new system earned trust. That dual-run window was the most important design choice in the plan; it bought confidence without slowing the rollout.

The thing I'd improve: I don't have post-ship retros documented anywhere. The "what surprised me" loop happens in my head; at a job I'd write it down. Retro-as-documented-artifact is a discipline I haven't built yet on this project.

## The hard question

> "You shipped without tests. Why should I trust your code?"

Honestly, the trust isn't *because of* my process — it's despite the gap in it. I shipped without tests because at solo-scale my dogfood loop catches regressions within a day, and I have type system + DB constraints catching the most common bug class. That works *for me*. It doesn't work for a multi-engineer codebase where someone else's refactor breaks my untested code months later.

What I can defend: I know exactly what I'd test first. The pure parsers are the highest-risk, highest-testability code in the project — they're functions with clear input/output, they're called from the autosave path so silent bugs would corrupt user data, and they're the kind of code that drifts subtly when you refactor. Fixture-based tests covering edit-in-place, delete-line, insert-line, reorder-lines, and identical-text-twice — maybe 30 cases — would catch 90% of the bugs I'd worry about.

I also know what I *wouldn't* test first: React component snapshots, end-to-end flows that touch the LLM, or anything in `app/`. Component snapshots are noise; LLM E2E tests are non-deterministic and expensive; UI flow tests are flaky and the dogfood loop already covers them. The right place to spend testing budget is where the cost of a silent bug is highest and the test is cheapest to write.

The deeper answer: ownership of a gap is stronger than pretending it isn't there. I shipped without tests because the math was right at this scale. At a job the math is different and I'd treat parser tests as a hard prerequisite for a feature like the scanner. I'm not going to dress this up — the gap is real, the fix is straightforward, and the right time to build it is the day before someone else needs to refactor my code.

→ [09 — Ownership and judgment](./09-ownership-judgment.md)
