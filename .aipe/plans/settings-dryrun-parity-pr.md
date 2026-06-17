# PR — Settings dryrun-parity (Commits 1+2)

> **Status:** merged via `git push origin main` 2026-06-17. This doc serves as the GitHub-ready PR description for the two commits.

## Summary

Refactors buffr's AI routing to match dryrun's mental model: cloud is **Anthropic primary + OpenAI fallback**; on-device is **Gemma via llama.rn only**. Drops the Together/cloud-Gemma path that earlier phases introduced (it conflated two unrelated concerns under one provider key). Adds per-chain routing storage so a user can pin individual chains to on-device or cloud independently.

Companion change: cleans up Settings → menu items that aren't pulling their weight (App Updates, Export Database, Import Database) and seeds the design doc for the upcoming tabbed Settings UI.

## Commits

| SHA | Subject |
|---|---|
| `e22e20a` | `chore(settings): remove App Updates + Export/Import + draft dryrun-parity plan` |
| `4ac3771` | `refactor(ai): Gemma local-only + per-chain routing (dryrun-parity 1+2)` |

## Why

The previous Gemma integration treated "Gemma" as both a cloud provider (via Together) and an on-device provider (via llama.rn). That made the provider toggle a UI seam over two unrelated decisions (which cloud / whether to use on-device). dryrun separates the two concerns cleanly and routes per-feature; this PR ports that mental model.

## Behavior changes

| User configuration | Before | After |
|---|---|---|
| Together API key set, no Anthropic | Calls Together (cloud Gemma) | Falls through to Anthropic (now the only cloud); errors if no key |
| Anthropic key + Together key | User-toggle picked one | Cloud calls Anthropic; Together key is ignored |
| Provider = `'gemma'` in UI | Routed to Together first | Provider only picks cloud-primary (Anthropic / OpenAI); on-device is per-chain |
| classify chain | Cheapest-first cascade (OpenAI mini → Claude Haiku regardless of provider toggle) | Honors the cloud-primary toggle; falls back to the other on transient error |
| Per-chain routing | Global provider preference | Per-chain SecureStore keys (`route_summarize` etc.) — defaults: classify→on-device, others→cloud |

**Non-breaking for the dominant configuration** (Anthropic key only, no Together key): all 4 chains continue to call Claude exactly as before.

## What's added

- `src/services/ai/providers/cloud.ts` — `orchestrateCloud()` encapsulates the Anthropic-primary + OpenAI-fallback pattern. Generic enough to work for both Sonnet/gpt-4o (summarize/interpret/caption) and Haiku/gpt-4o-mini (classify) — each chain still owns its own `callClaude` / `callOpenAI` since the models differ.
- `config.ts` gets `RouteChoice` (`'on-device' | 'cloud'`), `ChainName`, `getChainRoute(chain)`, `setChainRoute(chain, route)`. Backed by `SecureStore` keys `route_summarize` / `route_caption` / `route_interpret` / `route_classify`. Defaults applied when unset.
- `.aipe/plans/settings-dryrun-parity.md` — the design doc for the full Settings UI rewrite that lands in a follow-up.
- `.aipe/TODO.md` — first item is the eval substrate gold.json from the recon's load-bearing gap.

## What's removed

- All Together / cloud-Gemma plumbing: `callGemmaCloud`, `GEMMA_CLOUD_MODEL`, `TOGETHER_ENDPOINT`, `getGemmaCloudKey` / `setGemmaCloudKey` / `clearGemmaCloudKey`, `KEY_GEMMA_CLOUD`.
- `'gemma'` from `AIProvider` (now strictly `'claude' | 'openai'`).
- Cloud-Gemma branch in each chain's run helper.
- Settings → AI Gemma provider button + Together API key field (interim patch — full tabbed rewrite lands in the next commit).
- Settings menu entries: App Updates (+ its page + boot-time OTA-check), Export Database, Import Database.

## Cache compatibility

`CacheKeyInput.provider` narrowed from `AIProvider` to `RouteChoice`. The schema column stays `TEXT`; only the value semantic changed (now `'on-device'` or `'cloud'` rather than a specific provider name). `PROMPT_VERSION` bumped to `v2` in every chain so existing cache rows naturally expire by missing the new key. No migration needed.

## Files changed

```
M  app/_layout.tsx                       (boot-time OTA check removed)
M  app/settings/ai.tsx                   (interim cloud-only patch; tabbed rewrite next)
M  app/settings/index.tsx                (menu items removed)
D  app/settings/updates.tsx              (page deleted)
M  src/services/ai/cache.ts              (provider field → RouteChoice)
M  src/services/ai/caption.ts            (run helper simplified; PROMPT_VERSION v2)
M  src/services/ai/config.ts             (Together rip; per-chain route APIs)
M  src/services/ai/interpret.ts          (run helper simplified; PROMPT_VERSION v2)
M  src/services/ai/providers/gemma.ts    (Together rip; doc refresh)
M  src/services/ai/summarize.ts          (run helper simplified; PROMPT_VERSION v2)
M  src/services/todos/classify.ts        (cascade simplified; predictClassifyRoute)
A  src/services/ai/providers/cloud.ts    (new: orchestrateCloud helper)
A  .aipe/plans/settings-dryrun-parity.md (new: design doc for the full UI rewrite)
A  .aipe/TODO.md                         (new: single-item user todo)
```

## Test plan

- [x] `tsc --noEmit` clean
- [ ] Manual regression on the connected Android device:
  - [ ] **Anthropic-only configuration** — summarize, interpret, classify, caption all serve via Claude (matches pre-PR behavior).
  - [ ] **OpenAI-only configuration** — chains serve via OpenAI (regardless of the primary toggle since it's the only key).
  - [ ] **Both keys, primary=claude** — first call uses Claude; if Claude fails (manually break a request), fallback to OpenAI kicks in with a `[buffr ai] cloud primary (claude) failed, trying fallback (openai)` log line.
  - [ ] **Strict-local + Gemma downloaded** — all chains route on-device; no cloud calls.
  - [ ] **Default install + Gemma downloaded** — classify auto-uses on-device; other chains still cloud.
  - [ ] Settings page renders correctly with the 2-button provider toggle.
- [ ] No automated tests in repo per `.aipe/project/rules.md`; manual e2e is the gate.

## Follow-ups (deliberately deferred)

- **Commit 3 of the parent plan** — `LlmProgress` types + `useLlmProgressTracker` hook + `onProgress` callback threaded through every chain LLM call. Wires llama.rn's streaming token callback to a UI-facing state machine matching dryrun's `LlmProgressTracker`.
- **Commit 4 of the parent plan** — Tabbed Settings UI (Routing / On-Device / Anthropic / OpenAI / Cloud Sync) replacing the current single scrolling page. KeyField with show/hide eye toggle. Per-chain routing chips on the Routing tab.
- **Commit 5 of the parent plan** — Wire `onProgress` into the feature components (vlog editor, interpret modal, /todos banner) for live loaders.

See `.aipe/plans/settings-dryrun-parity.md` for the full plan and `.aipe/plans/settings-dryrun-parity-status.md` for the progress checklist.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
