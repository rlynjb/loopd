import type { ExpandableType } from '../../types/todoMeta';

// Per-type chain-of-thought reasoning preambles. Lifted from the spec §7.3
// (in turn ported from buffr § 5). The preamble is folded into the system
// prompt to push the model through a deliberate think-step before
// generating the structured output.
const PREAMBLES: Record<ExpandableType, string> = {
  idea: `Before structuring this idea, think about: Is this solving a real problem or just interesting? What's the simplest version of this? What existing patterns relate to it? What would make this a bad idea?`,
  bug: `Before writing the report, reason through: What component or layer is this likely in, given the stack? What recent changes from the day's entries could have caused this? Are any sibling todos related? What would you check first if debugging this?`,
  question: `Before answering, consider: Does the user's recent context constrain the answer? Is there a common misconception here? What assumptions am I making? What would change the answer?`,
  decision: `Before recording this decision, think about: What were the alternatives? Why were they rejected? What's the strongest argument against this decision? Under what circumstances would this become the wrong choice?`,
  knowledge: `Before crystallizing this knowledge, consider: What's the essential insight here, stripped of context? Where else could this apply beyond the current situation? What would someone need to know to use this effectively? What's the most minimal, reusable example?`,
  content: `Before shaping this for an audience, think about: Who would care about this and why? What's the one thing they should take away? What makes this more interesting than a generic take? What format would reach them best?`,
  study: `Before sketching this study plan, think about: What's the core thing to learn here, narrowed down? Why is now the right time? What does the writer likely already know vs. need to pick up first? What's the smallest concrete first session that builds momentum without overwhelming?`,
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
  bug: `{
  "observed":       "string — what is happening",
  "expected":       "string — what should happen instead",
  "suspectedCause": "string — best guess at root cause given context",
  "reproSteps":     ["string — one step", "string — next step", "..."]
}`,
  question: `{
  "answer":     "string — direct answer to the question",
  "confidence": "high | medium | low",
  "followUps":  ["string — a related question worth asking next", "..."],
  "toVerify":   "string — what evidence would confirm or refute the answer"
}`,
  decision: `{
  "decision":    "string — the choice being committed to",
  "reason":      "string — why this is the right call",
  "tradeoff":    "string — what we're giving up by choosing this",
  "revisitWhen": "string — circumstances that should reopen this decision"
}`,
  knowledge: `{
  "concept":      "string — the insight, in one sentence",
  "whereUsed":    "string — domains or situations this applies to",
  "whyItMatters": "string — why this is worth remembering",
  "example":      "string — a minimal concrete example"
}`,
  content: `{
  "hook":         "string — the opening line or angle that grabs attention",
  "keyPoints":    ["string — a key beat", "..."],
  "format":       "post | video | thread | tutorial | vlog",
  "draftOutline": "string — sketched outline of the content piece"
}`,
  study: `{
  "topic":         "string — the precise thing to learn, narrowed from the captured thought",
  "whyNow":        "string — why this is worth the writer's attention right now",
  "prerequisites": ["string — a concept or skill assumed before starting", "..."],
  "resources":     ["string — a concrete starting point: book, paper, docs page, course, repo", "..."],
  "firstSession":  "string — what to do in a focused 30–60 minute first sitting"
}`,
};

const TYPE_INTRO: Record<ExpandableType, string> = {
  idea: 'You expand exploratory ideas into a structured, actionable form.',
  bug: 'You write tight bug reports from a developer\'s rough capture.',
  question: 'You answer questions thoughtfully, naming uncertainty where it exists.',
  decision: 'You record decisions with their reasoning and revisit conditions.',
  knowledge: 'You crystallize observations into reusable knowledge.',
  content: 'You shape rough ideas into publishable content drafts.',
  study: 'You turn vague learning intentions into a tight, runnable study plan.',
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
