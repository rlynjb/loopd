import type { Entry, TodoItem } from '../../types/entry';
import type { NotionPage } from '../../types/notion';
import type {
  TodoMeta, TodoType, ClassifierConfidence,
} from '../../types/todoMeta';
import { generateId } from '../../utils/id';

// ── Read helpers ──

function getPlainText(prop: unknown): string {
  const p = prop as {
    type?: string;
    title?: { plain_text: string }[];
    rich_text?: { plain_text: string }[];
  } | undefined;
  if (!p) return '';
  if (p.type === 'title' && p.title) return p.title.map(t => t.plain_text).join('');
  if (p.type === 'rich_text' && p.rich_text) return p.rich_text.map(t => t.plain_text).join('');
  return '';
}

function getDate(prop: unknown): string | null {
  const p = prop as { type?: string; date?: { start: string } | null } | undefined;
  if (!p || p.type !== 'date' || !p.date) return null;
  return p.date.start;
}

function getCheckbox(prop: unknown): boolean {
  const p = prop as { type?: string; checkbox?: boolean } | undefined;
  if (!p || p.type !== 'checkbox') return false;
  return p.checkbox ?? false;
}

function getSelect(prop: unknown): string | null {
  const p = prop as { type?: string; select?: { name: string } | null } | undefined;
  if (!p || p.type !== 'select' || !p.select) return null;
  return p.select.name ?? null;
}

function getTitlePropertyKey(props: Record<string, unknown>): string {
  for (const [key, val] of Object.entries(props)) {
    const p = val as { type?: string };
    if (p?.type === 'title') return key;
  }
  return 'Name';
}

// Property names — the user follows the Notion Guide to set these up. All
// case-sensitive. The optional ones (Type/Expanded/Model/Confidence/User
// Overridden) gate at sync time via detectMissingTodoProperties so users
// with older DB schemas keep working.
const PROP = {
  done: 'Done',
  loopdId: 'loopd ID',
  createdAt: 'Created At',
  entryDate: 'Entry Date',
  // Phase D additions (per spec §11.1 + plan §4)
  type: 'Type',
  expanded: 'Expanded',
  model: 'Model',
  confidence: 'Confidence',
  userOverridden: 'User Overridden',
} as const;

// ── Parsed shape of a Notion todo page ──

const VALID_TYPES = new Set<TodoType>([
  'todo', 'idea', 'bug', 'question', 'decision', 'knowledge', 'content',
]);
const VALID_CONFIDENCES = new Set<ClassifierConfidence>([
  'high', 'medium', 'low', 'heuristic',
]);

function parseTodoType(raw: string | null): TodoType | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return VALID_TYPES.has(lower as TodoType) ? (lower as TodoType) : null;
}

function parseConfidence(raw: string | null): ClassifierConfidence | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return VALID_CONFIDENCES.has(lower as ClassifierConfidence) ? (lower as ClassifierConfidence) : null;
}

export type ParsedNotionTodo = {
  notionPageId: string;
  loopdId: string;
  entryDate: string | null;
  todo: TodoItem;
  notionEditedAt: string;
  // Phase D — meta fields read from the new Notion properties when present.
  // Each is independently nullable so existing DBs without those properties
  // simply yield null and the sync code falls back to local-canonical values.
  meta: {
    type: TodoType | null;
    expandedMd: string | null;
    model: string | null;
    confidence: ClassifierConfidence | null;
    userOverridden: boolean | null;
  };
};

// ── Notion → loopd ──

export function notionPageToTodo(page: NotionPage): ParsedNotionTodo {
  const props = page.properties;
  const loopdId = getPlainText(props[PROP.loopdId]) || generateId('todo');
  const text = getPlainText(props[getTitlePropertyKey(props)]) || '(untitled)';
  const done = getCheckbox(props[PROP.done]);
  const createdAt = getDate(props[PROP.createdAt]) ?? page.created_time;
  const entryDate = getDate(props[PROP.entryDate]);

  const completedAt = done ? page.last_edited_time : null;

  const todo: TodoItem = {
    id: loopdId,
    text,
    done,
    completedAt,
    createdAt,
    notionPageId: page.id,
  };

  // Meta fields are independently nullable — undefined property → null,
  // wrong-shape property → null, no logging needed at this layer.
  const meta: ParsedNotionTodo['meta'] = {
    type: PROP.type in props ? parseTodoType(getSelect(props[PROP.type])) : null,
    expandedMd: PROP.expanded in props ? (getPlainText(props[PROP.expanded]) || null) : null,
    model: PROP.model in props ? (getSelect(props[PROP.model]) || null) : null,
    confidence: PROP.confidence in props ? parseConfidence(getSelect(props[PROP.confidence])) : null,
    userOverridden: PROP.userOverridden in props ? getCheckbox(props[PROP.userOverridden]) : null,
  };

  return {
    notionPageId: page.id,
    loopdId,
    entryDate,
    todo,
    notionEditedAt: page.last_edited_time,
    meta,
  };
}

// ── loopd → Notion properties ──

// Builds the property payload for create/update. When `meta` is provided,
// includes the Phase-D fields. Caller can also pass `availableProperties`
// (a Set<string> of keys present on the user's DB) so we silently skip
// writes for properties the schema doesn't declare — sync stays
// backwards-compatible with users who haven't updated their Notion DB yet.
export function todoToNotionProperties(
  todo: TodoItem,
  entry: Entry,
  titleColumnName = 'Name',
  meta?: TodoMeta | null,
  availableProperties?: Set<string>,
): Record<string, unknown> {
  const has = (name: string) => !availableProperties || availableProperties.has(name);
  const props: Record<string, unknown> = {
    [titleColumnName]: { title: [{ text: { content: todo.text || '(untitled)' } }] },
  };

  if (has(PROP.done)) props[PROP.done] = { checkbox: !!todo.done };
  if (has(PROP.loopdId)) props[PROP.loopdId] = { rich_text: [{ text: { content: todo.id } }] };

  const created = todo.createdAt ?? entry.createdAt;
  if (created && has(PROP.createdAt)) props[PROP.createdAt] = { date: { start: created } };
  if (entry.date && has(PROP.entryDate)) props[PROP.entryDate] = { date: { start: entry.date } };

  if (meta) {
    if (has(PROP.type)) props[PROP.type] = { select: { name: meta.type } };
    if (has(PROP.expanded)) {
      // Notion rich_text is capped at 2000 chars per content block. Split
      // longer markdown across multiple blocks rather than truncating.
      const text = meta.expandedMd ?? '';
      const blocks: { text: { content: string } }[] = [];
      for (let i = 0; i < text.length; i += 1900) {
        blocks.push({ text: { content: text.slice(i, i + 1900) } });
      }
      props[PROP.expanded] = { rich_text: blocks };
    }
    if (has(PROP.model)) {
      props[PROP.model] = meta.model
        ? { select: { name: meta.model } }
        : { select: null };
    }
    if (has(PROP.confidence)) {
      props[PROP.confidence] = meta.classifierConfidence
        ? { select: { name: meta.classifierConfidence } }
        : { select: null };
    }
    if (has(PROP.userOverridden)) props[PROP.userOverridden] = { checkbox: !!meta.userOverriddenType };
  }

  return props;
}

// Detects which of the Phase-D properties are missing from the user's DB
// schema. Caller passes the schema's properties dictionary; result is a
// set of property names the sync should skip on push and ignore on pull.
// Empty set = all five Phase-D properties present.
export function detectMissingTodoProperties(
  schemaProps: Record<string, unknown>,
): Set<string> {
  const missing = new Set<string>();
  for (const name of [PROP.type, PROP.expanded, PROP.model, PROP.confidence, PROP.userOverridden]) {
    if (!(name in schemaProps)) missing.add(name);
  }
  return missing;
}

export { getTitlePropertyKey, PROP };
