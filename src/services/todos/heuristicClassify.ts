import type { TodoType } from '../../types/todoMeta';

// Free, fast, deterministic. Returns the user's intended type only when
// confident — anything ambiguous returns null and falls through to the LLM
// classifier.
//
// Conservative widening (Phase C of the Gemma plan): the heuristic now
// returns the four non-todo types (idea / knowledge / study / reflect) when
// the user self-labels with an unambiguous marker:
//   "idea:" / "TIL" / "study:" / "reflect:" / "reflect on"
// Every other ambiguous shape stays null and the LLM decides.
//
// Per spec §5.2 the heuristic intentionally over-fires on null. False
// negatives (a confident type getting LLM-classified anyway) cost one cheap
// model call. False positives (e.g. "Idea Park is fun" reading as 'idea')
// cost a manual user override. Spec accepts that tradeoff for accuracy —
// and the explicit-marker shapes used here are deliberate enough that the
// false-positive rate should be near zero on real journal input.

// Common imperative verbs — line that starts with one of these is almost
// always a todo. Built from the illustrative list in spec §5.2; can be
// expanded after dumping a real export of the user's todos.
const IMPERATIVE_VERBS = new Set([
  'do', 'fix', 'send', 'review', 'reply', 'call', 'email', 'submit',
  'merge', 'deploy', 'update', 'delete', 'add', 'remove', 'rename',
  'move', 'book', 'order', 'pay', 'renew', 'cancel', 'schedule',
  'confirm', 'check', 'test', 'write', 'read', 'finish', 'start',
  'clean', 'prep', 'buy', 'sell', 'text', 'dm', 'ping', 'push', 'pull',
  'commit', 'pick', 'pickup', 'install', 'upgrade', 'restart', 'reboot',
  'sync', 'export', 'import', 'rebuild', 'build', 'run', 'launch',
  'publish', 'post', 'share', 'archive', 'sort', 'tag', 'fold', 'wash',
  'cook', 'meal', 'eat', 'drink', 'walk', 'run', 'stretch', 'sleep',
  'message', 'msg', 'tell', 'ask', 'remind',
]);

// "modal verb + verb" starts: "gotta call", "need to fix", "should email"
const MODAL_STARTS = [
  /^gotta\s+/i,
  /^need\s+to\s+/i,
  /^should\s+/i,
  /^have\s+to\s+/i,
  /^must\s+/i,
  /^let'?s\s+/i,
  /^ttd?:?\s+/i,           // "todo: " / "tdd: " conventions
];

// Question-shape lines — return null fast; classifier will likely tag question.
const QUESTION_STARTS = [
  /^why\b/i, /^how\b/i, /^what\b/i, /^when\b/i, /^where\b/i, /^who\b/i,
  /^is\b/i, /^are\b/i, /^does\b/i, /^do\b\s+(?:we|i|you|they)\b/i,
  /^can\b/i, /^could\b/i, /^would\b/i, /^should\s+(?:we|i)\b/i,
];

// Conditional / observational starts — almost never plain todos.
// "idea[:\s]" used to live here as a null-return. It's been promoted to
// IDEA_STARTS below since the colon form is an explicit self-label.
const SPECULATIVE_STARTS = [
  /^maybe\b/i,
  /^what\s+if\b/i,
  /^it\s+would\s+be\s+(?:cool|nice|great)\b/i,
  /^noticed\b/i,
  /^realized\b/i,
  /^figured\s+out\b/i,
  /^turns\s+out\b/i,
  /^the\s+thing\s+is\b/i,
];

// Deadline patterns — when present, very likely a todo.
const DEADLINE_PATTERNS = [
  /\bby\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|eod|eom|q[1-4])\b/i,
  /\bbefore\s+(?:today|tomorrow|tonight|eod|eom)\b/i,
  /\b(?:today|tomorrow|tonight|this\s+week|this\s+morning|this\s+afternoon|this\s+evening)\b/i,
  /\beod\b/i, /\beom\b/i, /\basap\b/i,
];

// Explicit self-label markers. Each one fires its declared type before any
// of the null-return checks or todo checks run. Intentionally narrow — only
// the colon form (or, for "reflect", "reflect on …") so generic uses of the
// word as a noun don't misfire ("Idea Park is fun" stays null).
const IDEA_STARTS = [
  /^idea\s*:/i,
];

const KNOWLEDGE_STARTS = [
  // "TIL" is the internet "today I learned" convention. Rare as a noun;
  // confidently knowledge in journal context. Covers "TIL: X" and "TIL X".
  /^til\b/i,
];

const STUDY_STARTS = [
  /^study\s*:/i,
];

const REFLECT_STARTS = [
  /^reflect\s*:/i,
  /^reflect\s+on\b/i,
];

function firstWord(text: string): string {
  const match = text.trim().match(/^([\w'-]+)/);
  return match ? match[1].toLowerCase() : '';
}

// Returns the user-self-labeled type when confident, null otherwise.
// Non-todo returns are only fired by the explicit self-label markers above.
export function heuristicClassify(rawText: string): TodoType | null {
  const text = rawText.trim();
  if (!text) return null;

  // Explicit self-labels win first — intentional markers trump punctuation
  // ambiguity. "Idea: should we X?" reads as 'idea' despite the trailing ?.
  for (const re of IDEA_STARTS) {
    if (re.test(text)) return 'idea';
  }
  for (const re of KNOWLEDGE_STARTS) {
    if (re.test(text)) return 'knowledge';
  }
  for (const re of STUDY_STARTS) {
    if (re.test(text)) return 'study';
  }
  for (const re of REFLECT_STARTS) {
    if (re.test(text)) return 'reflect';
  }

  // Trailing question mark → question or speculation, never plain todo.
  if (text.endsWith('?')) return null;

  // Speculative or observational lead — return null.
  for (const re of SPECULATIVE_STARTS) {
    if (re.test(text)) return null;
  }

  // Question-shape lead — return null.
  for (const re of QUESTION_STARTS) {
    if (re.test(text)) return null;
  }

  // Modal-verb start ("gotta X", "need to X") → todo.
  for (const re of MODAL_STARTS) {
    if (re.test(text)) return 'todo';
  }

  // Deadline keyword anywhere → todo.
  for (const re of DEADLINE_PATTERNS) {
    if (re.test(text)) return 'todo';
  }

  // First word is a common imperative verb → todo.
  if (IMPERATIVE_VERBS.has(firstWord(text))) return 'todo';

  return null;
}
