import type { ExpandableType } from '../../types/todoMeta';

// Per-type chain-of-thought reasoning preambles. The preamble is folded
// into the system prompt to push the model through a deliberate think-step
// before generating the structured output.
const PREAMBLES: Record<ExpandableType, string> = {
  idea: `Before structuring this idea, think about: Is this solving a real problem or just interesting? What's the simplest version of this? What existing patterns relate to it? What would make this a bad idea?`,
  knowledge: `Before crystallizing this knowledge, consider: What's the essential insight here, stripped of context? Where else could this apply beyond the current situation? What would someone need to know to use this effectively? What's the most minimal, reusable example?`,
  study: `Before sketching this study plan, think about: What's the core thing to learn here, narrowed down? Why is now the right time? What does the writer likely already know vs. need to pick up first? What's the smallest concrete first session that builds momentum without overwhelming?`,
  reflect: `Before opening this up for reflection, think about: What's actually worth sitting with here, separated from immediate reaction? What honest read can you offer without rushing to a conclusion? What questions would keep the writer thinking productively rather than spiralling? Stay grounded — never diagnose, never moralize.`,
};

// Output schema spec for each type. Goes verbatim into the system prompt so
// the model knows exactly what JSON shape to return.
const SCHEMAS: Record<ExpandableType, string> = {
  idea: `{
  "what":       "string — concise restatement of the idea",
  "why":        "string — the underlying motivation or problem it addresses",
  "conditions": "string — what would need to be true for this to work",
  "firstStep":  "string — the smallest concrete action to begin"
}`,
  knowledge: `{
  "concept":      "string — the insight, in one sentence",
  "whereUsed":    "string — domains or situations this applies to",
  "whyItMatters": "string — why this is worth remembering",
  "example":      "string — a minimal concrete example"
}`,
  study: `{
  "topic":         "string — the precise thing to learn, narrowed from the captured thought",
  "whyNow":        "string — why this is worth the writer's attention right now",
  "prerequisites": ["string — a concept or skill assumed before starting", "..."],
  "resources":     ["string — a concrete starting point: book, paper, docs page, course, repo", "..."],
  "firstSession":  "string — what to do in a focused 30–60 minute first sitting"
}`,
  reflect: `{
  "topic":         "string — what the writer is reflecting on, narrowed",
  "prompt":        "string — the central reflective question to sit with",
  "earlyInsight":  "string — an honest, hedged early read (use 'this may reflect…', 'a theme here is…' — never diagnose)",
  "openQuestions": ["string — a follow-up question worth holding open", "..."]
}`,
};

const TYPE_INTRO: Record<ExpandableType, string> = {
  idea: 'You expand exploratory ideas into a structured, actionable form.',
  knowledge: 'You crystallize observations into reusable knowledge.',
  study: 'You turn vague learning intentions into a tight, runnable study plan.',
  reflect: 'You hold space for honest reflection — calm, observant, never diagnostic.',
};

export function getSystemPrompt(type: ExpandableType): string {
  return [
    TYPE_INTRO[type],
    '',
    PREAMBLES[type],
    '',
    'Output ONLY a JSON object matching this schema — no preamble, no markdown fences:',
    '',
    SCHEMAS[type],
    '',
    'Keep each field tight: 1-3 sentences for string fields, 2-5 items for lists.',
  ].join('\n');
}

export type ExpansionContext = {
  entryDate: string;
  entryText: string;
  recentEntries: {
    date: string;
    text: string;
    aiSummary?: string;
  }[];
  siblingTodos: {
    text: string;
    type: string;
    done: boolean;
  }[];
};

// Builds the user message — the captured todo plus a compact context block.
// Each recent entry's text is capped at 1000 chars to keep tokens bounded
// (see plan gotcha §5.6 — heavy journaling days could blow up otherwise).
export function getUserMessage(todoText: string, ctx: ExpansionContext): string {
  const lines: string[] = [];
  lines.push(`Captured thought (${ctx.entryDate}):`);
  lines.push(`> ${todoText}`);
  lines.push('');
  if (ctx.entryText.trim()) {
    const trimmed = capText(ctx.entryText, 1000);
    lines.push(`Surrounding entry:`);
    lines.push(trimmed);
    lines.push('');
  }
  if (ctx.siblingTodos.length > 0) {
    lines.push(`Other todos in this entry:`);
    for (const s of ctx.siblingTodos) {
      lines.push(`- [${s.done ? 'x' : ' '}] (${s.type}) ${s.text}`);
    }
    lines.push('');
  }
  if (ctx.recentEntries.length > 0) {
    lines.push(`Recent entries (most recent first):`);
    for (const r of ctx.recentEntries) {
      lines.push(`--- ${r.date} ---`);
      if (r.aiSummary) lines.push(`Summary: ${r.aiSummary}`);
      lines.push(capText(r.text, 1000));
    }
  }
  return lines.join('\n');
}

function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '… (truncated)';
}
