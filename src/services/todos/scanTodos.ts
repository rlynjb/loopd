import type { TodoItem } from '../../types/entry';
import { generateId } from '../../utils/id';

// Matches a line that starts with a markdown-style checkbox:
//   "[]", "[ ]", "[x]", "[X]"
// Optional leading "-" bullet and any leading whitespace are allowed.
// Capture 1 = inside-the-brackets char (' ', 'x', 'X', or empty for "[]").
// Capture 2 = line content after the checkbox.
const CHECKBOX_RE = /^\s*(?:-\s+)?\[(\s|x|X|)\]\s*(.*)$/;

type ScannedMatch = {
  lineIndex: number;
  content: string;
  isDone: boolean;
};

function collectMatches(text: string): ScannedMatch[] {
  const lines = text.split('\n');
  const matches: ScannedMatch[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const m = CHECKBOX_RE.exec(lines[i]);
    if (!m) continue;
    const inside = m[1] ?? '';
    const content = (m[2] ?? '').trim();
    if (!content) continue;
    const key = content.toLowerCase();
    // De-dupe identical text within a single entry — two "[] call mom" lines
    // collapse to one todo. Acceptable v1 limitation.
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ lineIndex: i, content, isDone: inside.toLowerCase() === 'x' });
  }
  return matches;
}

// Scans an entry's text for checkbox drops ([], [ ], [x]) and produces a
// merged todos array for persistence.
//
// Matching uses a two-pass strategy so todos survive text edits:
//
//   Pass 1 — exact text match (case-insensitive, trimmed). Catches lines
//   whose content didn't change; handles reorderings cleanly.
//
//   Pass 2 — line-index fallback. For any line still unmatched, reuse an
//   existing todo whose `sourceLine` points at that same index. This is the
//   "I just edited the words of an existing [] line" case: same position,
//   different text → same todo, id/createdAt/done preserved.
//
// Anything left over on the line side becomes a fresh todo. Anything left
// over on the todo side is carried over (retained but with sourceLine
// cleared, since it no longer matches any line in the text).
export function scanTodosFromText(
  text: string | null | undefined,
  existing: TodoItem[],
): TodoItem[] {
  if (!text) return existing;

  const matches = collectMatches(text);
  const claimed = new Map<number, TodoItem>();
  const usedIds = new Set<string>();

  // Pass 1: exact text match
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i].content.toLowerCase();
    const prior = existing.find(
      t => !usedIds.has(t.id) && t.text.trim().toLowerCase() === key,
    );
    if (prior) {
      claimed.set(i, prior);
      usedIds.add(prior.id);
    }
  }

  // Pass 2: line-index fallback for matches the text pass didn't resolve.
  for (let i = 0; i < matches.length; i++) {
    if (claimed.has(i)) continue;
    const lineIndex = matches[i].lineIndex;
    const prior = existing.find(
      t => !usedIds.has(t.id)
        && typeof t.sourceLine === 'number'
        && t.sourceLine === lineIndex,
    );
    if (prior) {
      claimed.set(i, prior);
      usedIds.add(prior.id);
    }
  }

  const out: TodoItem[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const prior = claimed.get(i);
    const now = new Date().toISOString();
    if (prior) {
      const doneChanged = prior.done !== match.isDone;
      out.push({
        ...prior,
        text: match.content,
        done: match.isDone,
        completedAt: doneChanged
          ? (match.isDone ? now : null)
          : prior.completedAt,
        sourceLine: match.lineIndex,
      });
    } else {
      out.push({
        id: generateId('todo'),
        text: match.content,
        done: match.isDone,
        completedAt: match.isDone ? now : null,
        createdAt: now,
        sourceLine: match.lineIndex,
      });
    }
  }

  // Carryover: existing todos that matched nothing stay, but without a
  // sourceLine since they no longer correspond to any "[]" line in prose.
  const carryover = existing
    .filter(t => !usedIds.has(t.id))
    .map(t => ({ ...t, sourceLine: undefined }));

  return [...carryover, ...out];
}

// Round-trips a dashboard-level edit back into the source prose. When the user
// toggles a todo's done state on the dashboard, the matching "[]" line in the
// entry's text should update to "[x]" (or vice versa) so visiting the journal
// shows the current state. Same for text edits.
//
// Target-line resolution: sourceLine first (fast, precise), then a fallback
// text-match scan (handles pre-migration carryovers that didn't have a source
// line assigned yet). Returns the original text unchanged if no line matches.
//
// Preserves leading whitespace and the optional "- " bullet; bracket shape is
// standardized to "[x]" for done and "[]" for not-done (empty brackets, per
// user preference — "[] NOT [X]").
export function rewriteTodoLine(
  text: string | null,
  todo: { text: string; sourceLine?: number },
  updates: { done?: boolean; text?: string },
): string | null {
  if (!text) return text;
  if (updates.done === undefined && updates.text === undefined) return text;

  const lines = text.split('\n');
  let idx = -1;

  if (typeof todo.sourceLine === 'number'
      && lines[todo.sourceLine]
      && CHECKBOX_RE.test(lines[todo.sourceLine])) {
    idx = todo.sourceLine;
  }

  if (idx < 0) {
    const targetText = todo.text.trim().toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const m = CHECKBOX_RE.exec(lines[i]);
      if (!m) continue;
      if ((m[2] ?? '').trim().toLowerCase() !== targetText) continue;
      idx = i;
      break;
    }
  }

  if (idx < 0) return text;

  const m = CHECKBOX_RE.exec(lines[idx]);
  if (!m) return text;

  const prefixMatch = lines[idx].match(/^\s*(?:-\s+)?/);
  const prefix = prefixMatch ? prefixMatch[0] : '';

  const nextDone = updates.done !== undefined ? updates.done : (m[1] ?? '').toLowerCase() === 'x';
  const nextContent = updates.text !== undefined ? updates.text.trim() : (m[2] ?? '').trim();
  const bracket = nextDone ? '[x]' : '[]';

  lines[idx] = `${prefix}${bracket} ${nextContent}`;
  return lines.join('\n');
}
