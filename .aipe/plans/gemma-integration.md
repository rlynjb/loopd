# Plan — Gemma on-device as default LLM for buffr

**Status:** Phase A complete; Phase B scaffolding in progress 2026-06-16
**Original direction approved:** 2026-06-16
**Latest revision:** v3 — folded in Phase A research findings (Together.ai
serves Gemma 3 4B free; llama.rn confirmed for Phase C; caption is text-only;
classify has two callers including a boot-time foot-gun in migrateMeta).

## The decision (unchanged)

Gemma 3 4B runs on-device as the default for `summarize`, `classify`,
`caption`, and `interpret`. The user controls a **strict local mode** toggle;
default behavior is "on-device first, cloud Gemma fallback" when the device
can't serve. Eval substrate ships next but doesn't block infrastructure work
— it gates the moment we **flip the default** for the quality-sensitive
chains.

Marketing line earned by this work: **"100% local AI by default."**

## Real chain inventory (verified against code)

| Chain | File | Provider call shape | Tokens | Notes |
|---|---|---|---|---|
| classify | `src/services/todos/classify.ts:88` | "cheapest first" — OpenAI mini → Claude Haiku fallback | 50 max | 5-class output: `todo \| idea \| knowledge \| study \| reflect`; in-flight counter for UI banner |
| summarize | `src/services/ai/summarize.ts:42` | `getProvider()` user preference | 1024 max | Outputs JSON for AISummary; triggers inline caption call |
| caption | `src/services/ai/caption.ts:201` | `getProvider()` user preference | 768 max | **Text-only** (raw log bullets + recent captions; no image input); 4-variant tonal output |
| interpret | `src/services/ai/interpret.ts:114` | `getProvider()` user preference | 1800 max, temp 0.7 | Long-form markdown; truncates input to last 2000 chars |

Three of four chains live in `src/services/ai/`. Classify lives in
`src/services/todos/` because it's part of the todo pipeline, not the
journal-summary pipeline.

No `expand` chain exists. No `compose.ts` chain orchestrator exists — the file
`compose.ts` is post-summary (clips/text overlays from validated AISummary).

## Cloud provider — Together.ai (verified in Phase A)

Together.ai serves the **Gemma 3 family free** as of mid-2026: Gemma 3 1B,
Gemma 3 4B, Gemma 3 27B, and Gemma 3 270M Instruct. Gemma 3n E4B is $0.02/M.

This means **cloud Gemma uses the same weights as on-device** (Gemma 3 4B).
A/B testing measures the same model running on different compute — eliminates
the "model-mismatch" risk that v2 of this plan flagged.

- **Endpoint:** `https://api.together.xyz/v1/chat/completions` (OpenAI-compat)
- **Model identifier:** `google/gemma-3-4b-it` (verify at first call; adjust
  if Together's canonical name differs)
- **Auth:** `Authorization: Bearer ${apiKey}` (Together API key)

Groq deprioritized — Phase A search results showed Gemma 7B / Gemma 2, no
clear Gemma 3 availability in mid-2026.

## Native binding — llama.rn (verified in Phase A)

llama.rn (mybigday/llama.rn) wraps llama.cpp and supports Gemma 3 4B GGUF on
Android Hermes. CPU inference (OpenBLAS) is production-stable; GPU is
"improving but not production-stable" — Phase C plans for CPU-first.

react-native-executorch (Software Mansion) does NOT support Gemma 3 yet —
open feature requests from Oct 2025 (Gemma 3 270M) and Apr 2026 (Gemma 4).
Not the right pick today; reconsider in Phase D if Gemma 4 lands.

## What's missing in the codebase today (relevant to this plan)

- **No content-hash cache.** `ai_summaries` is keyed by `date` only. Adding a
  cache is a new layer — deferred to Phase C when on-device cost makes it
  earn its place.
- **No `providers/` subdirectory** existed before Phase B Commit 1. Now lives
  at `src/services/ai/providers/`. Each chain gets a Gemma branch alongside
  its existing `callClaude` / `callOpenAI` functions.
- **No central routing table.** Two patterns coexist: user-preference
  (`getProvider()`) for summarize / interpret / caption; cheapest-first for
  classify. Phase B preserves both, adds Gemma as a third option in each.
- **Three error-return patterns** across chains. Preserve each chain's
  contract — no consolidation in this work.

## Model choice (unchanged)

**Gemma 3 4B (Q4 quantized, ~2.5 GB) on-device** as universal default.
Falls back to **Gemma 3 1B (~700 MB)** on devices with <4 GB RAM.

Cloud Gemma serves the same Gemma 3 4B via Together.

## Fallback toggle (unchanged)

Single binary setting in Settings → AI:

```
[ ] Strict local mode
    When on: AI features that the device can't serve are disabled.
    Nothing leaves your device.

    When off (default): if Gemma can't run on this device or this chain
    fails locally, buffr falls back to cloud-hosted Gemma. Same Gemma 3 4B
    weights, on a remote GPU.
```

Stored via `expo-secure-store` (key `strict_local_mode`) alongside existing
API keys.

## Per-chain latency budgets (unchanged)

| Chain | Latency budget | Token budget | Gemma 3 4B feasibility (mid-tier Android) |
|---|---|---|---|
| classify | <1.5s | 50 | ✓ (~2s; warm model required) |
| caption | <3s | 768 | ✓ for the 4 text variants; no image input |
| summarize | <10s | 1024 | borderline; needs warm model + KV cache |
| interpret | <15s | 1800 | borderline-to-bad on cold model |

On-device fan-out is **serial**. classify's two callers fan out differently
— see "classify's two callers" below.

## Heuristic short-circuit — the honest scope

The existing `heuristicClassify(rawText)` is **binary** — returns `'todo'`
or `null` (`src/services/todos/heuristicClassify.ts`). It only short-circuits
unambiguous todos. The four other classes (`idea`, `knowledge`, `study`,
`reflect`) ALWAYS hit the LLM.

Phase C considers widening the heuristic conservatively (`idea:`, `TIL:`,
`reflect:`) per the existing file's "speculative leads return null"
discipline.

## classify has two callers (Phase A finding)

| Caller | Path | Heuristic? | Loop shape | On-device risk |
|---|---|---|---|---|
| `reconcileMeta.ts:14` (primary) | per-todo during entry reconcile | ✓ heuristic FIRST; LLM only if `null` | fire-and-forget `.then()` | low; existing async pattern absorbs latency |
| `migrateMeta.ts:83` (secondary) | per-row on app boot for unclassified metas | ✗ **heuristic SKIPPED** — LLM only | sequential `await` in `for` loop | **high** — N stale rows × ~3s/inference on Gemma 3 4B = potentially minutes of boot-time inference |

The migrateMeta path is the foot-gun for on-device. Phase C needs explicit
strategy:

1. **Cap migrateMeta volume per boot** (e.g., 10 rows max per launch; rest
   roll forward to the next boot).
2. **Force cloud Gemma for migrateMeta even when reconcileMeta uses
   on-device.** Boot-time UX should not block on serial inference. Strict
   local mode + many ambiguous rows = those rows wait until either the user
   triggers a manual run or strict-local is disabled.
3. **Or: call heuristic in migrateMeta too.** Today it's skipped — adding it
   shrinks the LLM-bound set even on the boot path. Conservative widening
   amplifies this. Worth doing regardless of the on-device decision.

Recommended combo: (1) + (3) for Phase C; (2) only if (1) + (3) isn't enough.

## Architecture changes (file-by-file)

### `src/services/ai/config.ts` — extend (DONE in Phase B Commit 1)

- `AIProvider` union: add `'gemma'`
- `getProvider()` handles `'gemma'` value
- `getGemmaCloudKey` / `setGemmaCloudKey` / `clearGemmaCloudKey`
- `getStrictLocalMode` / `setStrictLocalMode`
- `isAIConfigured()` checks gemma case

### NEW: `src/services/ai/providers/gemma.ts` (DONE in Phase B Commit 1)

- `callGemmaCloud(apiKey, system, user, maxTokens, temperature?)` — Together
  endpoint, OpenAI-compatible body
- `callGemmaLocal(...)` — stub (throws "not implemented")
- `shouldUseGemmaLocal()` — returns `false` in Phase B; flips in Phase C

### Phase B Commit 2: each chain gets a Gemma branch (pending)

Pattern applied to all 4 chains:

```ts
// new imports
import { callGemmaCloud, callGemmaLocal, shouldUseGemmaLocal } from './providers/gemma';
import { getGemmaCloudKey, getStrictLocalMode } from './config';

// in the chain's main function, after the existing provider resolution:
if (await shouldUseGemmaLocal()) {
  try {
    const text = await callGemmaLocal(system, user, MAX_TOKENS, TEMPERATURE);
    // validate + return per chain's existing shape
  } catch (err) {
    if (await getStrictLocalMode()) {
      // surface failure per chain's existing error contract
      return { /* chain-specific failure */ };
    }
    // fall through to cloud
  }
}

const gemmaKey = await getGemmaCloudKey();
if (gemmaKey) {
  try {
    const text = await callGemmaCloud(gemmaKey, system, user, MAX_TOKENS, TEMPERATURE);
    // validate + return
  } catch (err) {
    if (await getStrictLocalMode()) {
      return { /* chain-specific failure */ };
    }
    // fall through to existing claude/openai path
  }
}

// existing fallback to claude/openai unchanged
```

Note for `classify.ts`: this chain uses "cheapest first" not `getProvider()`.
Gemma slots in as cheapest (free local + free cloud) — try Gemma first, then
existing OpenAI-mini-first-else-Haiku order.

### Phase B Commit 3: Settings → AI page (`app/settings/ai.tsx`)

Existing UI: provider toggle (Claude/OpenAI), shared key input, Save/Test/
Disconnect buttons.

Additions:
1. **Provider toggle gains a third option:** Gemma. Same row of buttons.
2. **Gemma key input** when provider is 'gemma' (placeholder `together_...`
   or generic).
3. **Strict-local toggle** between key input and button row. Off by default.

UI design: extend the existing `providerRow` to 3 buttons. The shared
`currentKey` / `setCurrentKey` derivation pattern (line 75-78) extends
naturally to a 3-way switch.

### Cache layer — DEFERRED to Phase C

Phase B does NOT add a content-hash cache. Cloud Gemma is free on Together;
caching it is over-investment. Phase C adds the cache when on-device cost
(battery + latency) matters.

When Phase C adds the cache, the key includes `model_id` (so cloud Gemma and
on-device Gemma don't share entries; so user-switched providers don't return
stale outputs). New SQLite migration — not the existing `ai_summaries`
table.

## Phase A — preparation (COMPLETE)

Findings folded into this v3 plan:

- Cloud provider: **Together.ai** (Gemma 3 4B free)
- Native binding: **llama.rn** (Gemma 3 4B GGUF supported on Android)
- Caption is text-only; ships with B/C/D
- Settings page: `app/settings/ai.tsx` (single screen, easily extended)
- classify has two callers; migrateMeta is the on-device foot-gun

## Phase B — cloud Gemma + provider scaffolding (~1 week)

**Commit 1 (DONE):** Provider scaffolding
- `src/services/ai/config.ts` extended
- `src/services/ai/providers/gemma.ts` created

**Commit 2 (next):** Wire 4 chains
- Add Gemma branches to `classify.ts`, `summarize.ts`, `interpret.ts`,
  `caption.ts`
- Preserve each chain's existing error contract

**Commit 3:** Settings UI
- `app/settings/ai.tsx`: Gemma button + Gemma key input + strict-local
  toggle
- Verify `tsc --noEmit` clean
- Manual e2e on Android device per `.aipe/project/rules.md`

## Phase C — on-device Gemma 3 4B (~4 weeks)

1. Integrate llama.rn (or backup binding).
2. Implement `callGemmaLocal`.
3. Lazy model download UX (Settings → AI → Download Gemma).
4. Device-class detection: RAM read → Gemma 3 4B vs 1B vs disable.
5. Warm model on app start; persist KV cache.
6. Per-chain latency probe on first run.
7. Content-hash cache layer (new SQLite migration).
8. Heuristic widening for `idea` / `knowledge` / `study` markers.
9. **migrateMeta strategy:** cap per-boot volume (10 rows) + call heuristic
   first; optionally force cloud Gemma for migrateMeta even when
   reconcileMeta uses on-device.
10. Flip `shouldUseGemmaLocal()` to return true under valid conditions.

## Phase D — flip default to on-device (~2 weeks)

1. classify default flips → on-device.
2. caption default flips → on-device.
3. summarize default flips → on-device. ★ requires summarize eval substrate.
4. interpret default flips → on-device. ★ requires interpret eval substrate.
5. Strict-local toggle goes live in user-visible Settings copy.
6. Feature flag retired.

## Phase E — REMOVED

Originally for multimodal caption. caption.ts is text-only (verified in
Phase A) — no multimodal needed for any current chain. If a future chain
takes images, Phase E gets reinstated.

## Eval substrate (gates Phase D)

Per the existing drill (`.aipe/drills/eval-design-llm-judge-classify.md`):
golden sets + rubric'd LLM-as-judge + bias-trap regression. Extend to
`summarize.gold.json` and `interpret.gold.json`. Caption's eval shape is
distinct — 4-variant tonal output — and needs its own design when Phase D
approaches.

Phase D gate condition per chain: on-device Gemma agreement rate within
agreed delta of cloud-Gemma rate (both are Gemma 3 4B; expected close) AND
cloud-Gemma rate within agreed delta of today's Claude/OpenAI baseline.
Pick deltas when the evals exist.

## Risks (revised)

| Risk | Mitigation |
|---|---|
| Heuristic only covers `todo`; on-device load on classify is large | Phase C widens heuristic conservatively; cloud-classify-always opt-out if local latency is bad |
| migrateMeta runs sequentially on boot with no heuristic | Phase C caps per-boot volume + adds heuristic call + optionally forces cloud Gemma for migrateMeta |
| Each chain's error contract differs — refactor risk | Preserve each chain's existing return shape; no consolidation |
| `caption` is called inline from `summarize` — Gemma latency stacks | Time the 4-variant caption budget separately; consider deferring caption to a post-summarize background call |
| Settings → AI page complexity (3 providers + strict-local + Gemma download) | UI grouping in Commit 3; "Gemma" section consolidates its controls |
| Native module install changes Android build (pulls in C++ deps) | Phase C is its own PR; isolate the dependency change for easy revert |
| Together.ai's `google/gemma-3-4b-it` identifier may differ from canonical | Constant exported from `providers/gemma.ts`; one-line fix at first failed call |

## Out of scope (unchanged)

- LoRA fine-tuning Gemma on buffr corpus
- Streaming responses
- "Use top-tier AI (Claude)" opt-in (future)
- Multimodal anything (no current chain needs it)

## The first concrete commit (unchanged)

`tests/evals/classify.gold.json` with ~10 hand-labeled cases from real
entries. Substrate for every chain-quality comparison Phase D depends on.

## Cross-links

- `.aipe/audits/recon-2026-06-03.md` — the L1 readiness audit
- `.aipe/drills/eval-design-llm-judge-classify.md` — eval substrate
- Buffr source files referenced above

## Revision history

- **2026-06-16 v1** — initial plan based on `.aipe/study-*` guide claims.
- **2026-06-16 v2** — revised against actual code after first Phase A read.
  Five divergences fixed (chain count, classify location, providers
  subdirectory, cache existence, routing pattern).
- **2026-06-16 v3** — Phase A research complete. Cloud provider locked to
  Together.ai (Gemma 3 4B free). Native binding locked to llama.rn.
  Caption confirmed text-only — Phase E removed. classify's two-caller
  discovery: migrateMeta foot-gun documented; Phase C strategy added.
  Phase B Commit 1 scaffolding (config.ts + providers/gemma.ts) shipped
  alongside this revision.
- The `.aipe/study-*` guides committed earlier in the session contain
  architectural inaccuracies; separate cleanup, not blocking this plan.
