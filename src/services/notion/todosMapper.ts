import type { Entry, TodoItem } from '../../types/entry';
import type { NotionPage } from '../../types/notion';
import { generateId } from '../../utils/id';

// ── Read helpers (mirrors mapper.ts but scoped to what we need for todos) ──

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

function getTitlePropertyKey(props: Record<string, unknown>): string {
  for (const [key, val] of Object.entries(props)) {
    const p = val as { type?: string };
    if (p?.type === 'title') return key;
  }
  return 'Name';
}

// ── Parsed shape of a Notion todo page ──

export type ParsedNotionTodo = {
  notionPageId: string;
  loopdId: string;           // TodoItem.id
  entryDate: string | null;  // YYYY-MM-DD — used to locate / create a bucket entry locally
  todo: TodoItem;
  notionEditedAt: string;    // page.last_edited_time
};

// ── Notion → loopd ──

export function notionPageToTodo(page: NotionPage): ParsedNotionTodo {
  const props = page.properties;
  const loopdId = getPlainText(props['loopd ID']) || generateId('todo');
  const text = getPlainText(props[getTitlePropertyKey(props)]) || '(untitled)';
  const done = getCheckbox(props['Done']);
  const createdAt = getDate(props['Created At']) ?? page.created_time;
  const entryDate = getDate(props['Entry Date']);

  // Notion has no "completed_at" property in our minimal schema — derive it
  // from the checkbox + page's last_edited_time so we surface completion time
  // locally without an extra property.
  const completedAt = done ? page.last_edited_time : null;

  const todo: TodoItem = {
    id: loopdId,
    text,
    done,
    completedAt,
    createdAt,
    notionPageId: page.id,
  };

  return {
    notionPageId: page.id,
    loopdId,
    entryDate,
    todo,
    notionEditedAt: page.last_edited_time,
  };
}

// ── loopd → Notion properties ──

export function todoToNotionProperties(
  todo: TodoItem,
  entry: Entry,
  titleColumnName = 'Name',
): Record<string, unknown> {
  const props: Record<string, unknown> = {
    [titleColumnName]: { title: [{ text: { content: todo.text || '(untitled)' } }] },
    'Done': { checkbox: !!todo.done },
    'loopd ID': { rich_text: [{ text: { content: todo.id } }] },
  };

  const created = todo.createdAt ?? entry.createdAt;
  if (created) {
    props['Created At'] = { date: { start: created } };
  }
  if (entry.date) {
    props['Entry Date'] = { date: { start: entry.date } };
  }

  return props;
}

export { getTitlePropertyKey };
