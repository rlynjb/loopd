// Free, fast, deterministic. Returns 'todo' only when confident — anything
// ambiguous returns null and falls through to the LLM classifier in Phase B.
//
// Per spec §5.2 the heuristic intentionally over-fires on null. False
// negatives (an obvious todo getting LLM-classified anyway) cost one cheap
// model call. False positives (an idea mis-classified as todo) cost a
// manual user override. Spec accepts that tradeoff for accuracy.

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
const SPECULATIVE_STARTS = [
  /^maybe\b/i,
  /^what\s+if\b/i,
  /^it\s+would\s+be\s+(?:cool|nice|great)\b/i,
  /^noticed\b/i,
  /^realized\b/i,
  /^figured\s+out\b/i,
  /^turns\s+out\b/i,
  /^the\s+thing\s+is\b/i,
  /^idea[:\s]/i,
];

// Deadline patterns — when present, very likely a todo.
const DEADLINE_PATTERNS = [
  /\bby\s+(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|eod|eom|q[1-4])\b/i,
  /\bbefore\s+(?:today|tomorrow|tonight|eod|eom)\b/i,
  /\b(?:today|tomorrow|tonight|this\s+week|this\s+morning|this\s+afternoon|this\s+evening)\b/i,
  /\beod\b/i, /\beom\b/i, /\basap\b/i,
];

function firstWord(text: string): string {
  const match = text.trim().match(/^([\w'-]+)/);
  return match ? match[1].toLowerCase() : '';
}

// Returns 'todo' when we're confident, null otherwise. Never returns a
// non-todo type — assignment of {idea, bug, question, …} is the LLM's job.
export function heuristicClassify(rawText: string): 'todo' | null {
  const text = rawText.trim();
  if (!text) return null;

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
