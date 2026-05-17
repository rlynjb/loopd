# Feature Spec — Interpret

**App:** buffr
**Feature:** AI journal interpretation — "Interpret" button
**Type:** New AI chain feature
**Status:** Ready to implement

---

## Goal

When the user taps **Interpret**, the app analyses the current journal entry and returns a structured, emotionally intelligent interpretation — explaining the deeper meaning, recurring themes, emotional patterns, and a healthy reframe.

This is not a diagnosis. It is a mirror. The output helps the user understand what they are feeling, what themes are surfacing, what patterns are repeating, and what takeaway they can carry forward.

---

## Data model

### New field on `Entry`

```typescript
interpret?: {
  mainInterpretation: string
  coreThemes: { label: string; explanation: string }[]
  emotionalPattern: string
  healthyReframe: string
  keyTakeaway: string
  generatedAt: string   // ISO timestamp
}
```

No new table required. Stored as a JSON field alongside the existing entry.

---

## Input

The raw journal entry text the user has written.

**Example input:**
```
Yesterday, I felt like I let go a little bit. Today, I need
to stick to my routine again and study. I need to stay locked
in, focus on my career, study, workout, and remember why I
shouldn't get too comfortable.
```

**Minimum length to enable button:** 20 characters
**Maximum length passed to model:** 2000 characters
**If entry exceeds 2000 characters:** truncate to last 2000 — the most recent thought is most relevant.

---

## AI prompt

```
You are an emotionally intelligent journal interpreter.

Analyze the user's journal entry and explain what it may
reveal about their mindset, emotional patterns, values,
and deeper themes.

Do not diagnose. Do not judge. Do not over-motivate.
Keep the tone calm, grounded, reflective, and honest.

Use this exact structure and return valid JSON only —
no preamble, no explanation outside the JSON:

{
  "mainInterpretation": "2–4 sentences on the deeper meaning",
  "coreThemes": [
    { "label": "Theme name", "explanation": "One sentence" },
    { "label": "Theme name", "explanation": "One sentence" },
    { "label": "Theme name", "explanation": "One sentence" }
  ],
  "emotionalPattern": "One paragraph explaining the repeating
                       emotional or behavioural pattern",
  "healthyReframe": "Rewrite the intense or protective thought
                     into a more grounded version",
  "keyTakeaway": "One powerful insight the user can carry forward"
}

Tone rules:
  → Calm, honest, reflective, emotionally intelligent
  → Not clinical, not motivational, not judgmental
  → Never diagnose or label the user
  → Never say: "you have trauma", "you are paranoid",
    "you need therapy", "this is unhealthy"
  → Prefer language like: "this sounds like…",
    "a theme here is…", "this may reflect…",
    "a healthier framing could be…"

Minimum 3 core themes, maximum 5.

User journal entry:
{{journal_entry}}
```

---

## Output format

The AI returns structured JSON. The app renders it as five sections displayed below the entry.

### Section 1 — Main Interpretation
2–4 sentences. The deeper meaning of the entry.

```
This entry sounds like you're trying to re-center yourself
after feeling emotionally loose or distracted. The main theme
is security — wanting to stay prepared, focused, and
independent so you don't feel powerless if something changes.
```

### Section 2 — Core Themes
3–5 labelled themes, each with a one-sentence explanation.

```
Security       You want leverage and options.
Self-protection Routine helps you feel grounded.
Ambition       Studying and career growth feel tied to safety.
Distrust       Past experiences make you cautious with people.
Discipline     You're using habits to stay in control.
```

### Section 3 — Emotional Pattern
One paragraph. The repeating emotional or behavioural pattern.

```
The pattern here is: emotional drift → awareness → return to
structure. When you feel like you're getting too comfortable
or distracted, your mind pulls you back toward routine,
studying, and self-improvement.
```

### Section 4 — Healthy Reframe
One reframe. The raw protective thought, turned into a grounded version.

```
Instead of "I can't trust anyone," the healthier version is:
"I can build myself enough that I'm never trapped or dependent
on the wrong people."
```

### Section 5 — Key Takeaway
One sentence. The strongest insight from the entry.

```
You're not just chasing success — you're building safety,
autonomy, and peace that can't easily be taken away.
```

---

## Model config

```typescript
model:       claude-sonnet-4-20250514
max_tokens:  800
temperature: 0.7       // reflective but not mechanical
response:    JSON only — parse immediately after return
```

---

## Button behaviour

```
User taps Interpret
  │
  ├── entry length < 20 chars?
  │     → show inline message: "Write a little more first"
  │     → stop
  │
  ▼
Show loading state on button ("Interpreting…")
  │
  ▼
Send entry to Claude API
  │
  ├── API error?
  │     → show toast: "Couldn't interpret right now. Try again."
  │     → restore button to idle state
  │     → stop
  │
  ▼
Parse JSON response
  │
  ├── parse error?
  │     → retry once automatically
  │     → if still fails: show toast, restore button
  │     → stop
  │
  ▼
Render interpretation sections below entry
  │
  ▼
Save interpretation to entry record
  │
  ▼
Button changes to "Regenerate" + show timestamp
  ("Interpreted just now")
```

---

## UI behaviour

**Button placement:** Below the journal entry text, alongside any existing action buttons (save, tag, etc.)

**Button states:**
```
idle         [Interpret]
loading      [Interpreting…]  + spinner
has result   [Regenerate]     + "Interpreted [time]"
```

**Interpretation display:**
- Appears below the entry as a collapsible card
- Expanded by default on first generation
- Collapsed on subsequent opens (show summary line: first sentence of main interpretation)
- Each section has its own labelled header
- Core themes displayed as a short list

**Regenerate:**
- Tapping Regenerate overwrites the previous interpretation
- No confirmation required — it's regenerative, not destructive

**Save as Insight (optional, v2):**
- A "Save as Insight" button on the interpretation card
- Saves the key takeaway to a separate Insights list
- Accessible from the main nav

---

## Edge cases

| Scenario | Behaviour |
|----------|-----------|
| Entry too short (< 20 chars) | Button disabled, inline hint shown |
| Entry is a list, not prose | Model still interprets — no special handling needed |
| Entry is in a different language | Model handles it — no language detection required |
| User edits entry after interpreting | Show stale indicator: "Entry changed since last interpretation" |
| No internet connection | Show toast: "No connection — interpretation needs internet" |
| Model returns fewer than 3 themes | Accept and render — do not retry |
| Model returns malformed JSON | Retry once, then show error |

---

## What changes

| File | Change |
|------|--------|
| `lib/types.ts` | Add `interpret` field to `Entry` type |
| `lib/ai/chains/` | New file: `interpret-chain.ts` |
| `lib/api.ts` | New function: `interpretEntry(entryText)` |
| `components/journal/EntryView` | Add Interpret button + result card |
| `components/journal/InterpretCard` | New component — renders 5 sections |
| `storage/entries` | Update save logic to persist `interpret` field |

---

## Constraints

- Do not show the raw prompt to the user
- Do not store the prompt — only the response
- Do not run interpretation automatically — always user-triggered
- Do not block saving the entry while interpretation is loading
- Interpretation is per-entry, not cross-entry — no pattern analysis across the journal yet
- Remove all debug logging before shipping

---

## Done when

- [ ] Interpret button appears on entry view
- [ ] Button is disabled for entries under 20 characters
- [ ] Tapping sends entry to Claude and shows loading state
- [ ] Interpretation renders in all five sections
- [ ] Result is saved with the entry and persists on reload
- [ ] Button shows "Regenerate" + timestamp after first interpretation
- [ ] Regenerate overwrites previous result
- [ ] Error states handled — API failure, parse failure, no connection
- [ ] Stale indicator shows when entry is edited after interpreting
- [ ] No debug logs in production build

---

## Claude Code session startup

```
Read .aipe/specs/features/interpret.md
then implement the Interpret feature in buffr.
Do not modify any files not listed in the
"What changes" section.
```
