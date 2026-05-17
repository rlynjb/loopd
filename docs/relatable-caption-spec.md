# Relatable Vlog Caption Generator — Spec & Prompt

> **Superseded 2026-05-05** by [`docs/buffr-caption-variants-plan.md`](./buffr-caption-variants-plan.md).
> The 2-variant output shape (`caption` + `alternate` + `detectedTheme`) and the
> 3-beat structured prompt described below are retained for **read-side
> backward-compat only** — older `ai_summaries` rows cached before the
> 4-variant pass shipped still parse against the legacy AISummary fields
> and render as a 3-chip group (PRIMARY / ALT / SUMMARY) in the editor.
> All new caption generation uses the 4-variant prompt. Voice rules,
> forbidden patterns, and theme detection from this spec are preserved
> in the new prompt verbatim.

## 1. Intent

Transform a raw daily log (tasks, actions, ideas) into a short, reflective caption that feels like an authentic personal thought — not a summary or checklist.

**Core principle:** Turn actions into realizations.

---

## 2. Behaviour Contract

### Input
```ts
type CaptionInput = {
  date: string;                    // ISO date (e.g. "2026-05-02")
  rawLog: string[];                // bullet list of tasks/actions/ideas
  recentCaptions?: string[];       // last 3–5 captions, for tonal continuity & anti-repetition
  mood?: string;                   // optional self-reported mood/state
  themeHint?: 'growth' | 'discipline' | 'clarity' | 'struggle' | 'shift' | 'curiosity' | null;
};
```

### Output
```ts
type CaptionOutput = {
  caption: string;                 // 2–4 lines, plain text, no hashtags, no emojis unless input had them
  detectedTheme: string;           // theme the model inferred
  alternate: string;               // shorter 2-line variant
};
```

### Structure (every caption must follow this 3-beat shape)

1. **Hook** — an emotion, realization, or noticing. *Internal state, not action.*
2. **Light summary** — 1–2 actions max, simplified. *What actually happened.*
3. **Reflection** — what's shifting, clicking, or becoming clearer. *The takeaway.*

### Ratio
- ~70% feeling / reflection
- ~30% what was done

---

## 3. Transformation Rules

| Rule | Do | Don't |
|---|---|---|
| Voice | "Realizing I…", "Starting to see…", "Feels like…" | "Today I built X, then Y, then Z" |
| Density | Keep 1–2 key actions | List every task |
| Tone | Grounded, calm, reflective | Hyped, motivational, performative |
| Length | 2–4 lines, TikTok-readable | Paragraphs |
| Specificity | Concrete enough to feel real ("AI tool idea", "interview prep guide") | Vague platitudes ("worked on stuff") |
| Framing | Why it matters / what it means | Just what happened |

---

## 4. Forbidden Patterns

- ❌ Generic motivational closers ("keep grinding", "let's go", "stay locked in")
- ❌ Hashtag soup
- ❌ Hustle language ("crushed it", "executed", "shipped 3 things today")
- ❌ Overexplaining the lesson
- ❌ Starting with "Today I…"
- ❌ Listing more than 2 actions
- ❌ Self-help phrasing ("the journey", "the grind", "trust the process")

---

## 5. Caption Formulas (model picks the best fit)

**Formula A — Lately/Today/Starting**
```
Lately I've been noticing ___
Today I ___
I think I'm starting to ___
```

**Formula B — Realization-first**
```
Realizing ___
[1 action] + [1 action]
[shift]
```

**Formula C — Feeling-first**
```
Feels like ___
[what happened, simplified]
[what it means]
```

The model should rotate formulas across days to avoid pattern fatigue (check `recentCaptions` for the last formula used).

---

## 6. Worked Example

**Input**
```
- New AI dev tool idea
- Journaling vlog app learnings
- Codebase → interview prep guide
```

**Output (caption)**
> Lately I've been drawn to building things with more depth, not just surface ideas
> Came up with a new AI tool idea and started organizing my learnings
> Feels like I'm finally understanding what I actually want to build

**Output (alternate)**
> Realizing I care more about depth than just building for the sake of it
> New AI tool idea + organizing my learnings — things are starting to click

**Detected theme:** `clarity`

---

## 7. System Prompt (drop into Anthropic API call)

```
You are the caption writer for buffr, a daily vlog journal app. Your job is to turn a user's raw daily log into a short, reflective caption that reads like an authentic personal thought — not a summary.

CORE PRINCIPLE: Turn actions into realizations.

STRUCTURE (always 3 beats):
1. Hook — an emotion, realization, or noticing (internal state, not action)
2. Light summary — 1–2 actions max, simplified
3. Reflection — what's shifting, clicking, or becoming clearer

RATIO: ~70% feeling/reflection, ~30% what was done.

VOICE:
- Grounded, calm, reflective
- First person, present-progressive ("noticing", "realizing", "starting to")
- Specific enough to feel real, never vague
- 2–4 lines total, TikTok-readable

NEVER:
- Start with "Today I…"
- List more than 2 actions
- Use hustle language ("crushed", "shipped", "executed", "locked in")
- Use motivational closers or hashtags
- Use self-help phrasing ("the journey", "trust the process")
- Overexplain the lesson

FORMULAS (rotate across days; check recent captions to avoid repetition):
A) "Lately I've been noticing ___ / Today I ___ / I think I'm starting to ___"
B) "Realizing ___ / [actions] / [shift]"
C) "Feels like ___ / [what happened] / [what it means]"

OUTPUT FORMAT (strict JSON, no markdown fences):
{
  "caption": "string — 2–4 lines, \\n separated",
  "alternate": "string — shorter 2-line version",
  "detectedTheme": "growth|discipline|clarity|struggle|shift|curiosity"
}

Return ONLY the JSON object. No preamble, no explanation.
```

---

## 8. User Prompt Template

```
Raw log for {{date}}:
{{rawLog joined by newlines}}

{{#if mood}}Mood: {{mood}}{{/if}}
{{#if themeHint}}Theme hint: {{themeHint}}{{/if}}

Recent captions (avoid repeating phrasing or formula):
{{recentCaptions joined by "---"}}

Generate the caption.
```

---

## 9. Success Criteria (eval checklist)

A caption passes if it:
- [ ] Opens with internal state, not an action verb
- [ ] Mentions ≤2 concrete actions
- [ ] Ends with a reflection/shift, not a task
- [ ] Is 2–4 lines
- [ ] Contains no forbidden patterns (§4)
- [ ] Doesn't repeat the formula used in the previous 2 captions
- [ ] Reads like a thought, not a report

A caption fails if a friend reading it would say "this sounds like an AI summary."

---

## 10. Edge Cases

| Case | Behaviour |
|---|---|
| Empty `rawLog` | Return caption based purely on `mood` or a generic noticing; don't fabricate actions |
| Very long log (10+ items) | Pick the 1–2 most thematically connected items; ignore the rest |
| Highly emotional mood (e.g. "burnt out", "grieving") | Drop the action beat entirely; deliver a 2-line reflection only |
| User logged only ideas (no actions) | Reframe ideas as "noticing I keep coming back to…" rather than "did" |
| Repetitive day (same as yesterday) | Lean into the repetition itself as the reflection |

---

## 11. Future Extensions

- Auto-detect theme from a rolling 7-day window (not just today's log)
- Tone slider: more reflective ↔ more matter-of-fact
- Series detection: when a theme spans multiple days, generate captions that subtly reference the arc
- A/B variant generation for the user to pick their preferred voice
