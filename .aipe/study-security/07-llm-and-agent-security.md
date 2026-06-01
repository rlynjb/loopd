# LLM and agent security

**Industry name(s):** Prompt injection (Willison 2022), output-as-code, tool-permission scope
**Type:** Industry standard · Language-agnostic

## Zoom out, then zoom in

LLM security is the new frontier of injection. The classic categories — prompt injection (the user's text overrides system instructions), output-as-trusted (the model's output flows into a sink that interprets it), and tool/permission scope (an agent's tool set exceeds what its task needs) — all have buffr-specific answers. The Phase A threat model narrows them sharply.

```
  Zoom out — buffr's LLM surface

  ┌─ chains in src/services/ai/ ─────────────────────┐
  │  user prose ──► system prompt + user message ──► │
  │  Anthropic/OpenAI ──► tool-call constrained ──►  │
  │  validate.ts ──► cached as data (no side effects) │
  └─────────────────────┬────────────────────────────┘
                        │
  ┌─ what buffr DOES NOT have ──────────────────────┐
  │  no agents (no autonomous loops)                  │
  │  no tools (no chain emits tool requests)          │
  │  no RAG (principle #11 — hand-picked context)     │
  │  no LLM output flowing into code paths            │
  └──────────────────────────────────────────────────┘
```

The audit's main finding: buffr's chain design already implements the strongest single defense (structured output via tool calling + Zod re-validate + side-effect isolation). The Phase A threat model (single user) further narrows surface to near zero. Phase B widens it; the layered defense buffr has is the right shape for that future.

## Structure pass

The axis is **what flows where, and what interprets it**.

```
  axis = "where does user-controlled content become model-controlled content?"

  user prose          ── interpolated into ──►  chain prompt
                                                  │
                                                  ▼
                                           model output
                                                  │  constrained by tool schema
                                                  ▼
                                           validate.ts (Zod re-check)
                                                  │  enforces shape
                                                  ▼
                                           cached as data
                                           (never executed; never SQL'd;
                                            never a tool call)
```

The seam where injection would matter is "model output → side-effect path." Buffr has no such path — outputs land in `ai_summaries` (data); the UI renders them; nothing else runs them.

## How it works

### Move 1 — the four LLM security categories

```
  ┌─ prompt injection ──────────────────────────────────┐
  │  user prose contains "ignore previous instructions"  │
  │  → model follows the injected instruction            │
  └─────────────────────────────────────────────────────┘
  ┌─ output-as-trusted ─────────────────────────────────┐
  │  model output flows into a sink that runs it          │
  │  (SQL, shell, eval, browser DOM)                      │
  └─────────────────────────────────────────────────────┘
  ┌─ tool / permission scope ───────────────────────────┐
  │  an agent's tool set exceeds what its task needs     │
  │  (a read-only summarizer with delete tools)           │
  └─────────────────────────────────────────────────────┘
  ┌─ data exfiltration via tool calls ──────────────────┐
  │  a compromised agent calls a tool that leaks data    │
  │  to an attacker-controlled endpoint                   │
  └─────────────────────────────────────────────────────┘
```

### Move 2 — buffr's four categories, walked

**Prompt injection — real surface, Phase A narrow.** `entries.text` flows into every chain's user message. A malicious entry could attempt to redirect the model. Defenses already in place:

- **Tool-calling constrains output.** Anthropic tool calling makes the model emit values matching the schema (`AISummary { headline, narrative, tone, tags }`). "You have been hacked" doesn't fit `tone: 'positive' | 'neutral' | 'negative'`; injected free-form responses violate the schema.
- **validate.ts re-validates.** Even if the provider drift produces a slightly off-schema output, Zod safeParse catches it before any consumer sees it. Defense in depth at the schema layer.
- **Output is data, not code.** Chain outputs land in `ai_summaries.summary_json` and feed the UI. They never become SQL, never become a tool call, never become anything executed.

```
  the layered defense

  user prose ──► chain prompt
                    │  (injection attempt could be here)
                    ▼
                model output ──► tool-call schema enforces shape
                                  │  (constrains free-form)
                                  ▼
                                validate.ts (Zod) ──► schema match or throw
                                                       │
                                                       ▼
                                                     cached (data)
                                                     never executed
```

**Output-as-trusted — DOES NOT APPLY in buffr.** No chain output flows into SQL, shell, eval, or a tool call. The strongest preventive measure: the application never gives the model a code execution path. Phase B agentic features would re-open this surface; concept 01 of `study-agent-architecture` walks why buffr stays at the chain shape.

**Tool / permission scope — N/A (no tools).** No chain emits tool requests; no agent exists; therefore no tool scope to bound.

**Data exfiltration via tool calls — N/A (no tools).** Same reason.

### Move 3 — the principle

The strongest LLM defense is *structural*: constrain output via schema, re-validate, and never let model output flow into a code path. Buffr does all three. Phase B's threat model widens — prose from any user becomes hostile by default — but the defense shape stays the same; it just needs explicit prompt-site wrapping (`<entry>...</entry>` delimiters + system-prompt instructions to treat the content as data) to harden further.

## Primary diagram

```
  buffr's LLM defense layers — and what each catches

  layer 1: tool-calling schema           catches: free-form output drift
  layer 2: validate.ts Zod re-check       catches: provider edge-case drift
  layer 3: output-as-data isolation      catches: any attempt at code injection
  layer 4 (Phase B): prompt-site wrapping  catches: explicit prompt injection
   ─ NOT YET; Phase A threat model is narrow enough

  WHAT BUFFR DOES NOT HAVE (and therefore needs no defense for)
   ─ no tools, no agents, no RAG, no LLM-output-into-code path
   ─ Phase B agentic features would re-open these surfaces; deferred
     by principle "single agent + better tools" (study-agent-architecture)
```

## Implementation in codebase

### The strongest layered defense — tool calling + validate.ts

```
  src/services/ai/summarize.ts (the chain call)

  const messages = buildSummaryPrompt(entry, lastNDays);
  const result = await anthropic.messages.create({
    model, messages,
    tools: [summaryTool],                          ← ★ output constrained
    tool_choice: { type: 'tool', name: 'emit_summary' }
  });
  const parsed = result.content[0].input;          ← provider enforced shape
  return validate.validateAISummary(parsed);       ← Zod re-validate
       │
       └─ three defenses stacked: provider schema enforcement, then Zod
          re-check, then the result flows into ai_summaries cache —
          a data sink, not a code sink.
```

### What's NOT there — and why

```
  the absent vector — no tools, no agents

  buffr has zero LLM-emitted tool calls
   ─ every chain returns typed data
   ─ no chain decides what to do next
   ─ no chain has access to file system, shell, or DB

  result: even if prompt injection succeeded at the model layer, there
          is no downstream path that interprets the model's output as
          code. Defense by absence.
```

## Elaborate

Prompt injection was named as a security class by Simon Willison in 2022 and has driven prompt-engineering security discipline ever since. The defenses fall into four layers (instruction hierarchy in the system prompt, input delimiters, structured-output enforcement, side-effect isolation). Buffr implements the strongest two — structured output and side-effect isolation — and relies on Phase A's threat model for the others.

For the AI-engineering view of these defenses (mechanics and layered details), see `.aipe/study-ai-engineering/06-production-serving/03-prompt-injection.md`. For the broader agent-security framing, see `.aipe/study-agent-architecture/03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — buffr's chain shape avoids agent surfaces entirely.

## Interview defense

**Q [mid]:** Is buffr vulnerable to prompt injection?

**A:** Phase A: narrowly, no — the single user's own prose isn't hostile. Phase B: in theory, yes; the chain prompts interpolate `entries.text` without delimiter wrapping. But the layered defenses limit blast radius: tool-calling schema constrains output (the model can't emit "you've been hacked" as `tone: 'positive' | 'neutral' | 'negative'`); validate.ts re-validates; outputs flow into a data cache, never into code. The strongest defense isn't preventing injection — it's making successful injection harmless.

```
  the layered defense, drawn

  injection attempt → model output → schema constraint → Zod check → data cache
                                       ✗ free form blocked   ✗ shape blocked

  one-line anchor: "make injection harmless, not impossible"
```

**Q [senior]:** Why does buffr have NO tools and NO agents?

**A:** Two reasons. (1) The product doesn't need them — chains cover the feature set; principle #11 in `docs/spec.md` and the agent-architecture guide both defend the chain choice. (2) Security: every tool an agent has is a code path the model can trigger. Fewer tools = smaller attack surface. The principle "single agent + better tools beats multi-agent" from the agent-architecture audit applies one layer further: "single chain + no tools beats single agent" until the feature genuinely needs autonomy.

**Q [arch]:** What changes if buffr ever ships an agent?

**A:** The chain-design defenses still hold for output-as-code (the agent's tool calls are typed; tools the model doesn't have don't exist), but a new layer is needed: tool scope. An agent that classifies todos should not have a `delete_todo` tool. The principle is least-privilege — each tool the agent has needs to be justified by the task. And every tool call's args need validation before execution (same `validate.ts` pattern, applied to tool inputs).

## Validate

### Level 1 — reconstruct the diagram

Sketch the four LLM security categories with buffr's status for each (applies / N/A).

### Level 2 — explain it out loud

Under 90 seconds: explain why buffr's chain design already implements the strongest defense (structural output enforcement) and what changes in Phase B.

### Level 3 — apply to a new scenario

A new feature: a "chat with your journal" agent that can search past entries and reference them in answers. Walk the new LLM security surfaces it would introduce.

Reference the existing `src/services/ai/summarize.ts` (chain shape) and `src/services/ai/validate.ts` (the schema gate).

### Level 4 — defend the decision

Defend or oppose: "Buffr should wrap `entries.text` in `<entry>...</entry>` delimiters in chain prompts right now, even in Phase A."

Reference `src/services/ai/summarize.ts` (the interpolation site) and the Phase A threat model.

## See also

- [`03-input-validation-and-injection.md`](./03-input-validation-and-injection.md) — the LLM prompt sink in the general injection framing.
- [`08-security-red-flags-audit.md`](./08-security-red-flags-audit.md) — LLM red flags as checklist items.
- `.aipe/study-ai-engineering/06-production-serving/03-prompt-injection.md` — the AI-engineering mechanics.
- `.aipe/study-agent-architecture/03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — why buffr stays chain-shaped.
