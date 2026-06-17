# Status — Settings dryrun-parity plan

**Parent plan:** `.aipe/plans/settings-dryrun-parity.md`
**Last updated:** 2026-06-17

## Progress checklist

### ✓ Commit 1+2 — Gemma local-only + per-chain routing — SHIPPED

| | |
|---|---|
| Commit | `4ac3771 refactor(ai): Gemma local-only + per-chain routing (dryrun-parity 1+2)` |
| Held-cleanup commit | `e22e20a chore(settings): remove App Updates + Export/Import + draft dryrun-parity plan` |
| Pushed to | `origin/main` |
| tsc | clean |
| Device | rebuild + reload required to pick up JS bundle changes |

What landed:
- [x] Ripped Together / cloud-Gemma path entirely (`callGemmaCloud`, `GEMMA_CLOUD_MODEL`, `TOGETHER_ENDPOINT`, key APIs, `'gemma'` from `AIProvider` union)
- [x] New `providers/cloud.ts` with `orchestrateCloud()` — Anthropic primary + OpenAI fallback (dryrun's `RoutingLlmClient` pattern)
- [x] `RouteChoice` (`'on-device' | 'cloud'`) + `ChainName` + `getChainRoute`/`setChainRoute` in `config.ts`
- [x] Defaults: `classify` → `'on-device'`; `summarize`/`caption`/`interpret` → `'cloud'`
- [x] 4 chains refactored — uniform `runXxxLLM(strictLocal, route, system, user)` shape
- [x] Cache key — `provider` field narrows to `RouteChoice`; `PROMPT_VERSION` bumped to `v2` everywhere
- [x] Settings UI interim patch — 3-button → 2-button toggle, Together key UI removed

### ⏳ Commit 3 — `LlmProgress` + tracker + `onProgress` wiring — PENDING

| | |
|---|---|
| Scope | Streaming progress callback through every chain LLM call |
| Native dep | None (uses llama.rn's existing callback) |
| Reach | `LlmProgress.ts` (new), `useLlmProgressTracker.ts` (new), `providers/gemma.ts`, `providers/cloud.ts`, 4 chains |
| Blocked by | Nothing — could ship now |

Deliverables:
- [ ] `LlmProgress.ts` — `LlmProgress` (per-tick) and `LlmLoadState` (UI snapshot) types matching dryrun's data classes
- [ ] `useLlmProgressTracker.ts` — React hook returning `{state, track(label, block), clear()}`. 250ms timer + token fold-in
- [ ] `callGemmaLocal` — accepts optional `onProgress` callback; wires llama.rn's `(data) => { const { token } = data }` callback to emit `LlmProgress` events with climbing `outputTokens`. Final emission has `done: true`
- [ ] `callCloud` (i.e. orchestrateCloud) — accepts optional `onProgress`; emits single `done: true` event after response parsed (cloud doesn't stream in this implementation)
- [ ] Per-chain `runXxxLLM` helpers grow an optional `onProgress` parameter, threaded through
- [ ] Chain entry points (`summarize`, `interpretEntry`, `generateCaption`, `classifyTodo`) grow optional `onProgress` param

### ⏳ Commit 4 — Tabbed Settings UI — PENDING

| | |
|---|---|
| Scope | Full Settings rewrite — 5 tabs matching dryrun's structure |
| Reach | `settings/ai.tsx` substantial rewrite; `settings/index.tsx` smaller |
| Blocked by | Nothing (could ship before Commit 3) |

Deliverables:
- [ ] Hand-rolled `Tabs` component (RN doesn't ship one; horizontal scrollable row of styled Pressables; ~30 LOC)
- [ ] `KeyField` component — TextInput + show/hide eye toggle
- [ ] `Chip` component — two-button row using existing `providerBtn` style
- [ ] **Routing tab** — per-chain rows (summarize / caption / interpret / classify); chip pair (on-device / cloud); on-device disabled when device class is 'disabled' or model not downloaded; strict-local toggle below
- [ ] **On-Device tab** — device class + RAM, model state, Download / Remove. Stats: per-chain auto-skip status + reset-skip button
- [ ] **Anthropic tab** — Key field with eye toggle, Save / Clear / Test Connection, description
- [ ] **OpenAI tab** — same shape
- [ ] **Cloud Sync tab** — move existing cloud-sync content into a tab
- [ ] Cloud-primary picker preserved (user's choice — keep the Anthropic/OpenAI toggle); placed at top of Routing tab or in a small affordance

### ⏳ Commit 5 — Wire `onProgress` into feature components — PENDING

| | |
|---|---|
| Scope | Per-feature live loaders surface in user-facing UI |
| Reach | vlog editor (caption + summarize), interpret modal, `/todos` banner |
| Blocked by | Commit 3 |

Deliverables:
- [ ] Vlog editor — show summarize phase + tokens + elapsed during AI summary generation
- [ ] Caption variants panel — show caption phase during 4-variant generation
- [ ] Interpret modal — show interpret phase + tokens during long-prose generation
- [ ] `/todos` banner — replace the existing `_inFlight` counter with the per-call `LlmLoadState` (per-todo progress)
- [ ] Optional convenience: a global "AI is busy" status bar at app level (deferred unless needed)

## Behavior matrix as of `4ac3771`

| User configuration | Per-chain routing behavior |
|---|---|
| Anthropic key only | All 4 chains → cloud → Claude (no fallback needed) |
| OpenAI key only | All 4 chains → cloud → OpenAI (primary toggle becomes the secondary; fallback fires) |
| Both keys, primary=claude | Cloud calls Claude first; falls back to OpenAI on 5xx/429/network |
| Strict-local + model downloaded | All 4 chains on-device; cloud never tried |
| Default fresh install + Gemma downloaded | `classify` on-device; summarize/caption/interpret cloud |
| Default fresh install + no Gemma + Anthropic key | All 4 chains cloud |

## Open items (not blocking)

- KV cache persistence across calls (llama.rn API unclear — deferred from Phase C)
- Variant-aware `MODEL_FILENAME` (4B + 1B currently share path; only matters if a user switches device class)
- Token usage tracking (dryrun's "Usage" tab; no data layer yet)
- Eval substrate `tests/evals/classify.gold.json` — recon TRACK #1, gates flipping defaults to on-device for the quality-sensitive chains

## Cross-references

- `.aipe/plans/settings-dryrun-parity.md` — the parent plan
- `.aipe/plans/gemma-integration.md` — Phase B + C of the originating Gemma plan
- `.aipe/audits/recon-2026-06-03.md` — readiness audit
- `.aipe/TODO.md` — single-item user todo list (eval gold.json)
