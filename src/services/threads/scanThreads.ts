import {
  getThreads, getThreadBySlug,
  getMentionsByEntry, getMentionsByTodo,
  insertMention, updateMentionSourceLine, updateMentionTagText, deleteMention,
} from '../database';
import { createThread } from './crud';
import { generateId } from '../../utils/id';
import type { TodoItem } from '../../types/entry';
import type { ThreadMention } from '../../types/thread';

// Tag pattern — must start with a letter, alphanumerics + hyphens after.
// We strip code spans / fenced blocks before matching so backticked tokens
// like `git #branch` don't register.
const TAG_RE = /(^|[^\w-])#([a-zA-Z][a-zA-Z0-9-]*)/g;

export type ParsedTag = {
  slug: string;        // lowercased, ready for thread.slug match
  tagText: string;     // literal as typed (case preserved): "Buffr"
  lineIndex: number;
};

// Strip fenced code blocks (```...```) and inline code spans (`...`) by
// replacing them with spaces of equal length. Preserves byte offsets so
// downstream line-index math stays correct.
function maskCode(text: string): string {
  let out = text;
  // Fenced first (multi-line). Replace contents with spaces so newlines
  // remain to keep line indices stable.
  out = out.replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' '));
  // Inline `...`. Same idea — preserve length but blank out characters.
  out = out.replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));
  return out;
}

// Extract tag mentions from arbitrary text. De-duped per-line per-slug
// (multiple #buffr on the same line collapse to one mention).
export function parseTags(text: string): ParsedTag[] {
  if (!text) return [];
  const masked = maskCode(text);
  const lines = masked.split('\n');
  const seenPerLine = new Set<string>();
  const out: ParsedTag[] = [];
  for (let i = 0; i < lines.length; i++) {
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(lines[i])) !== null) {
      const tagText = m[2];
      const slug = tagText.toLowerCase();
      const key = `${i}::${slug}`;
      if (seenPerLine.has(key)) continue;
      seenPerLine.add(key);
      out.push({ slug, tagText, lineIndex: i });
    }
  }
  return out;
}

// Resolve parsed tags to thread IDs. Unknown slugs are AUTO-CREATED as new
// threads on save (deviates from spec § 3.1 by user direction — favors
// convenience over typo-safety). Display name = first-occurrence tagText
// (case preserved); slug = lowercased. The autocomplete's "+ create" chip
// still works for inline creation in the editor; this scanner path is the
// fallback for prose typed without using the autocomplete (e.g. on the
// /todos page, or fast typing past the popover).
export async function resolveTagsToThreadIds(
  tags: ParsedTag[],
): Promise<Array<ParsedTag & { threadId: string }>> {
  if (tags.length === 0) return [];
  const allThreads = await getThreads(true); // include archived — we still record mentions
  const slugToId = new Map<string, string>();
  for (const t of allThreads) slugToId.set(t.slug.toLowerCase(), t.id);

  // Auto-create any slugs that don't already exist locally.
  const unknownSlugs = new Set<string>();
  for (const t of tags) {
    if (!slugToId.has(t.slug)) unknownSlugs.add(t.slug);
  }
  for (const slug of unknownSlugs) {
    // Use the first-occurrence tagText as display name (preserves case).
    const firstOccurrence = tags.find(t => t.slug === slug);
    const name = firstOccurrence?.tagText || slug;
    try {
      const result = await createThread({ name, slug });
      if (result.ok) {
        slugToId.set(slug, result.thread.id);
      } else if (result.error === 'slug-taken') {
        // Race against a concurrent scan or user create — re-fetch the row.
        const existing = await getThreadBySlug(slug);
        if (existing) slugToId.set(slug, existing.id);
      }
    } catch (err) {
      console.warn('[threads] auto-create failed for slug', slug, err);
    }
  }

  return tags
    .map(t => {
      const id = slugToId.get(t.slug);
      return id ? { ...t, threadId: id } : null;
    })
    .filter((x): x is ParsedTag & { threadId: string } => x !== null);
}

// ── Reconcile against existing entry mentions ──
//
// Pass 1: exact (threadId, sourceLine) match — keep, update tag_text if changed.
// Pass 2: fallback (threadId, tagText) within ±3 lines — line-shift tolerant.
// Unmatched parsed → insert. Unmatched existing → delete.
export async function scanThreadMentionsForEntry(
  entryId: string,
  entryDate: string,
  text: string | null | undefined,
): Promise<void> {
  if (!entryId) return;
  const tags = text ? parseTags(text) : [];
  const resolved = await resolveTagsToThreadIds(tags);

  const existing = await getMentionsByEntry(entryId);
  // Exclude todo-attributed mentions from this reconcile pass — those are
  // handled by scanThreadMentionsForTodo. (A mention can't be on both the
  // entry and a todo line, but defensive filter is cheap.)
  const entryOnly = existing.filter(m => m.todoId == null);

  await reconcileMentions({
    parsed: resolved,
    existing: entryOnly,
    makeNew: (p) => ({
      id: generateId('mention'),
      threadId: p.threadId,
      entryId,
      entryDate,
      todoId: null,
      sourceLine: p.lineIndex,
      tagText: p.tagText,
      createdAt: new Date().toISOString(),
    }),
  });
}

// Per-todo reconcile. Called once per todo whose text was scanned. The
// `entryId`/`entryDate` are passed so newly-inserted mentions carry the
// entry context (for join queries that don't traverse todo_meta).
export async function scanThreadMentionsForTodo(
  todo: TodoItem,
  entryId: string,
  entryDate: string,
): Promise<void> {
  const tags = parseTags(todo.text);
  const resolved = await resolveTagsToThreadIds(tags);
  const existing = await getMentionsByTodo(todo.id);

  await reconcileMentions({
    parsed: resolved,
    existing,
    makeNew: (p) => ({
      id: generateId('mention'),
      threadId: p.threadId,
      entryId,
      entryDate,
      todoId: todo.id,
      sourceLine: p.lineIndex,
      tagText: p.tagText,
      createdAt: new Date().toISOString(),
    }),
  });
}

// Shared reconcile: two-pass match parsed vs existing, then apply diffs.
async function reconcileMentions(args: {
  parsed: Array<ParsedTag & { threadId: string }>;
  existing: ThreadMention[];
  makeNew: (p: ParsedTag & { threadId: string }) => ThreadMention;
}): Promise<void> {
  const { parsed, existing, makeNew } = args;
  const claimed = new Map<number, ThreadMention>();
  const usedIds = new Set<string>();

  // Pass 1: exact (threadId, sourceLine).
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const prior = existing.find(
      e => !usedIds.has(e.id)
        && e.threadId === p.threadId
        && e.sourceLine === p.lineIndex,
    );
    if (prior) {
      claimed.set(i, prior);
      usedIds.add(prior.id);
    }
  }

  // Pass 2: (threadId, tagText) within ±3 lines.
  for (let i = 0; i < parsed.length; i++) {
    if (claimed.has(i)) continue;
    const p = parsed[i];
    const prior = existing.find(
      e => !usedIds.has(e.id)
        && e.threadId === p.threadId
        && e.tagText.toLowerCase() === p.tagText.toLowerCase()
        && Math.abs(e.sourceLine - p.lineIndex) <= 3,
    );
    if (prior) {
      claimed.set(i, prior);
      usedIds.add(prior.id);
    }
  }

  // Apply: update / insert / delete.
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const prior = claimed.get(i);
    if (prior) {
      if (prior.sourceLine !== p.lineIndex) {
        await updateMentionSourceLine(prior.id, p.lineIndex);
      }
      if (prior.tagText !== p.tagText) {
        await updateMentionTagText(prior.id, p.tagText);
      }
    } else {
      await insertMention(makeNew(p));
    }
  }
  for (const row of existing) {
    if (usedIds.has(row.id)) continue;
    await deleteMention(row.id);
  }
}

// Public entry point: run both entry-level and per-todo reconciles for a
// fully-scanned entry. Call after scanTodos has produced final todo IDs.
export async function scanThreadsForEntry(
  entryId: string,
  entryDate: string,
  text: string | null | undefined,
  todos: TodoItem[],
): Promise<void> {
  await scanThreadMentionsForEntry(entryId, entryDate, text);
  for (const todo of todos ?? []) {
    try {
      await scanThreadMentionsForTodo(todo, entryId, entryDate);
    } catch (err) {
      console.warn('[threads] todo mention scan failed:', todo.id, err);
    }
  }
}
