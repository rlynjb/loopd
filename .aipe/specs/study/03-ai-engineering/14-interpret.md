# Interpret — long-form markdown chain

**Industry name(s):** Inline summarization, interpret chain
**Type:** Project-specific

> A user-triggered AI chain that reads a journal entry and writes back a multi-section markdown reflection. Different shape from the other 4 chains — markdown out, no JSON, no schema validation, ephemeral.

**See also:** → [02-single-purpose-chains](./02-single-purpose-chains.md) · → [08-validation-gate](./08-validation-gate.md) · → [13-ai-features-in-this-app](./13-ai-features-in-this-app.md) · → [11-failure-modes](./11-failure-modes.md)

---

## Why care

Most AI features in a product are invisible to the user — the model output is parsed, validated, written to a database, and rendered later as if it had been there all along. But some AI features are different: the model's output *is* the artifact the user reads. There's no database row, no derived state, no downstream consumer — just text that appears on screen because a human asked for it. That second category needs a completely different posture toward validation, persistence, and trust.

The user-facing generation chain is the pattern where the model's output is the final product, not an intermediate value. It belongs to the family of "render-time" or "ephemeral" AI surfaces — the same shape as ChatGPT's main chat panel, GitHub Copilot Chat's reply pane, Notion AI's "improve writing" popover, and every "ask me anything" sidebar shipped in the last three years. The other category (data-producing chains) is closer to a structured-output API like OpenAI's function calling or LangChain's Pydantic parsers: parse, validate, store. This category is closer to streaming markdown into a renderer and trusting the model to follow formatting cues in the prompt. The diagram below shows the shape it takes here.

---

## Interpret — diagram

```
  Journal screen "Interpret" button
              │
              ▼
   ┌──────────────────────────┐
   │  InterpretModal opens    │  (src/components/journal/InterpretModal.tsx)
   └──────────┬───────────────┘
              │  rawText = entries[date].text
              ▼
   ┌──────────────────────────┐
   │  interpretEntry(rawText) │  (src/services/ai/interpret.ts)
   └──────────┬───────────────┘
              │
              │  guard 1: text.length < MIN_TEXT_LENGTH (20)
              │           → { ok: false, reason: 'too-short' }
              │
              │  guard 2: no API key
              │           → { ok: false, reason: 'no-ai' }
              │
              │  truncateTail(text, MAX_INPUT_CHARS = 2000)
              │  ↑ keeps most-recent 2000 chars (not first)
              ▼
   ┌──────────────────────────┐
   │  callClaude / callOpenAI │  Sonnet 4.6 / gpt-4o
   │  TEMPERATURE = 0.7       │  max_tokens = 1800
   │  SYSTEM_PROMPT = long-form mirror prompt (32 lines)
   └──────────┬───────────────┘
              │  raw markdown string
              ▼
   ┌──────────────────────────┐
   │  cleanMarkdown(raw)      │  strip ``` fences, trim, reject < 20 chars
   └──────────┬───────────────┘
              │  string | null
              ▼
   ┌──────────────────────────┐
   │  Interpretation object   │  { markdown, sourceText, generatedAt, model }
   │  rendered in modal       │  via InterpretMarkdown.tsx (selectable text)
   └──────────────────────────┘
              │
              ▼
        UI shows it.
        Modal closes.
        Nothing persists.
```

---

## How it works

The user taps an "Interpret" button next to the Vlog button on a journal entry. The modal opens, calls `interpretEntry(entries[date].text)`, and renders the markdown response with selectable text for copy/paste.

The chain is structurally identical to the other 4 (provider read → key read → branch on `'claude' | 'openai'` → single call → return) but the output contract is different. The other chains emit JSON that drives the editor / classifier / dashboard. Interpret emits a markdown essay the user reads once and probably never again.

Two guards run before the network call. `MIN_TEXT_LENGTH = 20` skips entries too short to mirror — a one-word entry produces no interpretation. `MAX_INPUT_CHARS = 2000` truncates very long entries to the **most recent** 2000 chars (`truncateTail`, not head — recent thoughts matter more for reflection than morning notes). After the call, `cleanMarkdown` strips an outer triple-backtick fence if the model wrapped its response, then rejects empty/whitespace-only output as `'malformed'`.

The output isn't persisted to SQLite. The result lives in the modal's React state until close. There is no `interpretations` table, no `last_interpretation` field on `entries`, no caching. Re-opening the modal re-fires the chain.

The system prompt is the longest in the codebase — 32 lines — and prescribes a structural template (opening bold + blockquote → numbered themes → "healthy side" / "part to watch" / "deeper fear" / "honest interpretation" / "strongest line" / "final thought" sections with emoji-prefixed H2 headings). The prompt explicitly says **"skip any section that doesn't fit the user's actual content; do not pad"** — a 3-section response on a flat day is better than a forced 11-section read of nothing.

---

## In this codebase

**Chain:**           `src/services/ai/interpret.ts` → `interpretEntry()` L114–L149
**System prompt:**   `src/services/ai/interpret.ts` L19–L50 (the longest SYSTEM_PROMPT in the codebase, 32 lines)
**Provider branch:** `src/services/ai/interpret.ts` → `callClaude()` L63–L74, `callOpenAI()` L76–L93
**Validator:**       `src/services/ai/interpret.ts` → `cleanMarkdown()` L98–L108 — strips outer ``` fences, rejects empty/short output. The whole "validation gate" is 11 lines.
**Input bounds:**    `MIN_TEXT_LENGTH = 20` at L16, `MAX_INPUT_CHARS = 2000` at L17, `truncateTail()` L58–L61 (keeps tail, not head)
**Result type:**     `InterpretResult` at L52–L54 — discriminated union with reasons `'no-ai' | 'too-short' | 'malformed' | 'network'`
**Modal UI:**        `src/components/journal/InterpretModal.tsx` (~10KB, ~280 lines) — opens on the journal screen
**Renderer:**        `src/components/journal/InterpretMarkdown.tsx` (~8KB) — selectable markdown text for copy/paste
**Type:**            `src/types/ai.ts` → `Interpretation` shape (markdown + sourceText snapshot + generatedAt + model)

---

## Elaborate

### Where this pattern comes from
"Long-form mirror" prompts come from the post-ChatGPT consumer wave — apps like Stoic, Daylio, and Reflectly built variants of "talk to your journal" features. The non-clinical, non-coachy tone constraint comes from feedback loops where users hated being labeled or motivated; the prompt's explicit "you are not a therapist, not a coach" bullet is a reaction to that failure mode.

### The deeper principle
**Some AI outputs are products, not data.** Loopd's other 4 chains produce data the app uses — clip orderings, type labels, expansion JSON. Interpret produces an artifact the *user* uses — a piece of writing they read once. The validation strategy, the persistence strategy, and the failure-mode strategy all change when the user is the consumer, not the app.

```
  Other 4 chains          Interpret
  ──────────────          ─────────
  output: JSON            output: markdown prose
  consumed by: the app    consumed by: the user
  validation: schema      validation: "is it non-empty?"
  persistence: SQLite     persistence: modal state, then gone
  retry on failure: yes   retry on failure: user re-taps the button
  cost: per-event         cost: per-tap (user-controlled)
```

### Where this breaks down
- Models that don't follow the structural suggestions reliably. The prompt asks for emoji H2 headings and blockquoted re-statements; a model that flattens to plain prose still passes `cleanMarkdown` and renders fine, just less visually rich.
- Adversarial input — a journal entry crafted to elicit clinical language could make the model violate the "never use clinical labels" rule. There's no post-call rejection for that.
- Multi-day reflection (the model only sees one entry at a time). The "deeper fear" and "main themes" sections work best on a meaty entry; a one-paragraph entry produces a polite but thin read.

### What to explore next
- [02-single-purpose-chains](./02-single-purpose-chains.md) → the other 4 chains. Compare their JSON contracts to interpret's prose contract.
- [08-validation-gate](./08-validation-gate.md) → why the gate is 11 lines instead of a schema.
- [03-context-window](./03-context-window.md) → why interpret uses `truncateTail` instead of hand-picked context blocks.

---

## Tradeoffs

| Choice | Cost | Alternative | When you'd pick the alternative |
|---|---|---|---|
| Markdown output, not JSON | No structural validation possible | Force JSON with `{ themes: [...], finalThought: '...' }` | When the modal needs to filter/reorder sections programmatically |
| Ephemeral (no persistence) | Re-tapping costs another LLM call | Cache last interpretation per entry | When users start re-reading old interpretations regularly |
| `truncateTail`, not hand-picked context | Misses "this connects to yesterday" insights | Add `getRecentEntries(date, 3)` to the prompt | When users ask why interpretations don't notice cross-day patterns |
| `MAX_INPUT_CHARS = 2000` cap | Long entries get the tail only, not the whole arc | Summarise long entries first, then interpret | When entries routinely exceed 2000 chars and the morning matters as much as the evening |
| 32-line system prompt | Every model upgrade risks tone regression | Shorter, less prescriptive prompt | When voice consistency stops mattering or the model gets reliably good at "mirror" without instruction |

---

## Quick summary

Interpret is the user-facing generation chain — the pattern where the model's output is the final artifact the user reads, not an intermediate value the app stores and re-renders. In this codebase `interpretEntry()` at `src/services/ai/interpret.ts` L114–L149 calls Sonnet/4o with a 32-line opinionated SYSTEM_PROMPT, runs two input guards (`MIN_TEXT_LENGTH = 20`, `MAX_INPUT_CHARS = 2000` via `truncateTail`), validates output with the 11-line `cleanMarkdown`, and returns the markdown to `InterpretModal` for render — nothing is persisted to SQLite. The constraint that drove it is that the consumer is the user, not the app: the value-per-bit of a one-time read doesn't justify a new `interpretations` table, sync mapping, conflict resolution, and soft-delete columns. The cost is no hard validation gate — model drift shows up as visibly worse output rather than a rejected call, and re-tapping the same entry costs another LLM call.

Key points to remember:
- Markdown out, no JSON, no schema — `cleanMarkdown` strips outer ``` fences and rejects empty/short output.
- Ephemeral by design — re-opening the modal re-fires the chain; closing it discards the result.
- `truncateTail` keeps the most-recent 2000 chars, not the first — recent thoughts matter more for reflection.
- Some AI outputs are products, not data — that's why interpret breaks the JSON convention.
- Prompt-level constraints (no clinical labels, no coachy language) are a soft guarantee; the user is the integrity check.

---

## Interview defense

### What an interviewer is really asking
"You added a 5th AI chain that breaks every convention of the other 4 — markdown not JSON, no validator, no persistence. Is this a deliberate exception to your single-purpose-chain rule, or did you cut corners because the user-facing output didn't fit the pattern?" The interviewer wants to see that I noticed the conventions were doing structural work for the other chains and that interpret genuinely needed a different shape, not that I forgot to apply them.

### Likely questions

[mid] Q: Walk me through what happens when a user taps "Interpret" on a 3-line journal entry.

A: The modal opens and calls `interpretEntry(text)`. The first guard is `text.length < MIN_TEXT_LENGTH`, which is 20 chars — a 3-line entry probably exceeds that, so it passes. The second guard is the API key check. Then `truncateTail` runs (no-op at 3 lines). Provider branches: Claude path uses `@anthropic-ai/sdk`, OpenAI uses raw `fetch` with `temperature: 0.7, max_tokens: 1800`. The model returns markdown; `cleanMarkdown` strips an outer ``` fence if present and rejects empty output. The result is a discriminated union: `{ ok: true, interpretation: { markdown, sourceText, generatedAt, model } }` or one of four `ok: false` reasons. The modal renders the markdown via `InterpretMarkdown` (selectable text for copy/paste). Nothing is persisted — closing the modal discards the result.

[senior] Q: Why no persistence? Re-tapping costs the user another LLM call (~$0.02 on Sonnet). That feels wasteful.

A: It's a deliberate trade. The other 4 chains produce derived state the app *needs* — a missing classifier output is a stuck `type='todo'` badge, a missing summary is a broken editor render. Interpret produces a piece of writing the user reads once and usually doesn't return to. Persisting it would mean a new `interpretations` table, a `last_interpretation` field on `entries`, sync-mapper plumbing, conflict resolution, soft-delete columns — all carrying weight for a feature whose value-per-bit is low. The user can copy-paste the markdown if it matters to them. If I started seeing users re-tapping the same entry repeatedly I'd cache the last result on the modal state with a "regenerate" button, but I haven't observed that pattern.

[arch] Q: Your other chains have hard schema validators. Interpret's "validator" is 11 lines that strip code fences. How does this design degrade if you switch to a model that hallucinates differently — say, GPT-5 starts wrapping outputs in `<output>` XML tags?

A: It degrades visibly in the user-facing output, not silently in the data layer. `cleanMarkdown` would return the raw string with the XML tags intact; the modal renders it; the user sees `<output>` in their interpretation and reports it. With JSON-emitting chains, a similar drift would mean `validateExpansion` rejects the response and the user sees "couldn't expand". The interpret design assumes user-visible degradation is the right error surface for a user-facing artifact. The migration if I did want to defend against this would be to add a list of "known wrapper patterns to strip" to `cleanMarkdown`, or push markdown rendering into a sanitiser that drops unrecognized tags. The deeper architectural lever is: the validator's complexity should match the consumer's tolerance for malformed output.

### The question candidates always dodge
Q: The system prompt is 32 lines and very opinionated. It even says "you are not a therapist." What's the failure mode you're protecting against, and why is that the *prompt's* job rather than a post-call filter?

A: The failure mode is the model writing something that sounds like clinical advice — "this suggests an avoidant attachment pattern" or "you might be experiencing rumination" — which is harmful when the user is trying to journal honestly. I've watched generic LLM outputs slip into this register on emotional content, and the user response is bad: they either feel labeled or they take the advice seriously when it isn't qualified. Putting it in the prompt is the cheapest viable mitigation — every call carries the rule. The alternative would be a post-call filter that searches for clinical vocabulary and rejects, but that has two problems: (1) it's a deny-list which is always behind the failure cases, and (2) rejecting an interpretation forces the user to retry with no understanding of why. The honest answer is that prompt-level rules are a soft guarantee, not a hard one — a model that's been jailbroken or that picks up clinical framing from the user's input *will* leak it through. I treat this as a known-tolerable failure surface because the consumer is the user, the user can see the failure, and the cost of a wrong interpretation is "the user dismisses the modal", not "the journal data corrupts." If I were running this for many users with no way to see individual outputs, I'd add the filter.

### One-line anchors
- "Some AI outputs are products, not data — that's why interpret breaks the JSON convention."
- "The validator is 11 lines because the consumer is the user, not the app."
- "Persistence costs schema, sync, conflict, soft-delete — too much weight for a feature whose value-per-bit is low."
- "`truncateTail`, not `truncateHead` — recent thoughts matter more for reflection than morning notes."
- "Prompt-level constraints are a soft guarantee. The user is the integrity check."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain the Interpret chain to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/ai/interpret.ts:interpretEntry`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user writes a 2400-char journal entry, taps Interpret, gets a great reflection, closes the modal, then 5 minutes later wants to read it again so they tap Interpret a second time on the same entry. Walk both runs:
- Run 1: which 2000 chars does the model see? Is it the first 2000 or the last 2000? What does the result object's `sourceText` field hold?
- Run 2: does the model see anything different? Is the markdown the same? What's persisted between runs?
- What's the user's recovery path if they wanted to keep run 1's interpretation?

Write your answer. 3–5 sentences minimum. Then open `src/services/ai/interpret.ts` L114–L149 and L58–L61 (`truncateTail`) to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/ai/interpret.ts:cleanMarkdown` (the 11-line validator) to support what exists
→ Point to where a JSON-output alternative would land (interpret.ts SYSTEM_PROMPT rewrite + new schema in validate.ts + InterpretMarkdown.tsx switching from a markdown renderer to a structured renderer) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block.
Updated: 2026-05-10 — added Why care block + normalized subtitle to plural `**Industry name(s):**` (template v1.18.0).
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).
