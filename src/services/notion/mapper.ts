import type { Entry, ClipRef, TodoItem } from '../../types/entry';
import type { NotionPage, NotionProperty } from '../../types/notion';
import { generateId } from '../../utils/id';

// ── Helpers ──
// Use `any` casts for Notion's dynamic property structure

function getPlainText(prop: unknown): string {
  const p = prop as { type?: string; title?: { plain_text: string }[]; rich_text?: { plain_text: string }[] } | undefined;
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

function getSelect(prop: unknown): string | null {
  const p = prop as { type?: string; select?: { name: string } | null } | undefined;
  if (!p || p.type !== 'select' || !p.select) return null;
  return p.select.name;
}

function getMultiSelect(prop: unknown): string[] {
  const p = prop as { type?: string; multi_select?: { name: string }[] } | undefined;
  if (!p || p.type !== 'multi_select' || !p.multi_select) return [];
  return p.multi_select.map(s => s.name);
}

function getCheckbox(prop: unknown): boolean {
  const p = prop as { type?: string; checkbox?: boolean } | undefined;
  if (!p || p.type !== 'checkbox') return false;
  return p.checkbox ?? false;
}

function getNumber(prop: unknown): number | null {
  const p = prop as { type?: string; number?: number | null } | undefined;
  if (!p || p.type !== 'number') return null;
  return p.number ?? null;
}

// ── Find the title property (Notion's title column can be named anything) ──

function getTitleProperty(props: Record<string, unknown>): string {
  for (const [, val] of Object.entries(props)) {
    const p = val as { type?: string; title?: { plain_text: string }[] };
    if (p?.type === 'title' && p.title) {
      return p.title.map(t => t.plain_text).join('');
    }
  }
  return '';
}

function getTitlePropertyKey(props: Record<string, unknown>): string {
  for (const [key, val] of Object.entries(props)) {
    const p = val as { type?: string };
    if (p?.type === 'title') return key;
  }
  return 'Name';
}

// ── Entry: Notion → loopd ──

export function notionPageToEntry(page: NotionPage): Entry {
  const props = page.properties;
  const loopdId = getPlainText(props['loopd ID']) || generateId('notion');

  // Read date from the editable "Date" property (preferred), fall back to "Created At", then page created_time
  const dateProp = getDate(props['Date']);
  const createdAtProp = getDate(props['Created At']);
  const rawDate = dateProp ?? createdAtProp ?? page.created_time;

  let date: string;
  if (rawDate && rawDate.length === 10) {
    // Date-only format "2026-03-27" — use as-is
    date = rawDate;
  } else {
    // Full timestamp — convert to local date
    const d = new Date(rawDate);
    date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const createdAt = createdAtProp ?? page.created_time;
  const text = getPlainText(props['Text']) || getPlainText(props['Note']) || null;
  const habits = getMultiSelect(props['Habits']).map(h => h.toLowerCase().replace(/\s+/g, '-'));

  // Parse clips JSON from rich_text
  let clips: ClipRef[] = [];
  const clipsRaw = getPlainText(props['Clips']);
  if (clipsRaw) {
    try { clips = JSON.parse(clipsRaw); } catch { /* ignore */ }
  }

  // Parse todos JSON from rich_text
  let todos: TodoItem[] = [];
  const todosRaw = getPlainText(props['Todos']);
  if (todosRaw) {
    try { todos = JSON.parse(todosRaw); } catch { /* ignore */ }
  }

  return {
    id: loopdId,
    date,
    text,
    habits,
    todos,
    clipUri: clips[0]?.uri ?? null,
    clipDurationMs: clips[0]?.durationMs ?? null,
    clips,
    createdAt,
    notionPageId: page.id,
    updatedAt: page.last_edited_time,
  };
}

// ── Entry: loopd → Notion properties ──

export function entryToNotionProperties(
  entry: Entry,
  titleColumnName = 'Name',
  dayTitle?: string,
  _isNew = false,
  habitIdToLabel?: Map<string, string>,
): Record<string, unknown> {
  const clipsJson = entry.clips.length > 0
    ? JSON.stringify(entry.clips.map(c => ({ uri: c.uri.split('/').pop(), durationMs: c.durationMs })))
    : '';

  const todosJson = (entry.todos?.length ?? 0) > 0
    ? JSON.stringify(entry.todos)
    : '';

  // Convert habit IDs to display labels for Notion multi-select
  const habitNames = entry.habits.map(id => habitIdToLabel?.get(id) ?? id);

  const props: Record<string, unknown> = {
    'Text': { rich_text: [{ text: { content: entry.text ?? '' } }] },
    'Habits': { multi_select: habitNames.map(h => ({ name: h })) },
    'Clips': { rich_text: [{ text: { content: clipsJson } }] },
    'Todos': { rich_text: [{ text: { content: todosJson } }] },
    'loopd ID': { rich_text: [{ text: { content: entry.id } }] },
  };

  // Always push Date (editable property) so it stays correct in Notion
  props['Date'] = { date: { start: entry.date } };

  // Set the Name for clean Notion display
  const preview = entry.text?.slice(0, 50) ?? '';
  const label = dayTitle
    ? dayTitle
    : preview
      ? `${preview}${preview.length >= 50 ? '...' : ''}`
      : entry.date;
  props[titleColumnName] = { title: [{ text: { content: label } }] };

  return props;
}

// ── Detect title column name from a Notion page ──

export { getTitlePropertyKey };

// ── Daily Log: aggregate entries into daily row properties ──

export function entriesToDailyLogProperties(
  date: string,
  entries: Entry[],
  habitLabels: string[],
  titleColumnName = 'Name',
  dayTitle?: string,
): Record<string, unknown> {
  const dayEntries = entries.filter(e => e.date === date);
  const clipCount = dayEntries.reduce((sum, e) => sum + e.clips.length, 0);
  const journalTexts = dayEntries.map(e => e.text).filter(Boolean);
  const habitsChecked = [...new Set(dayEntries.flatMap(e => e.habits))];

  const summary = [
    clipCount > 0 ? `${clipCount} clip${clipCount > 1 ? 's' : ''}` : '',
    journalTexts.length > 0 ? `${journalTexts.length} journal${journalTexts.length > 1 ? 's' : ''}` : '',
    habitsChecked.length > 0 ? `${habitsChecked.length} habit${habitsChecked.length > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(', ');

  const props: Record<string, unknown> = {
    [titleColumnName]: { title: [{ text: { content: dayTitle || date } }] },
    'Date': { date: { start: date } },
    'Note': { rich_text: [{ text: { content: summary + (journalTexts.length > 0 ? '\n\n' + journalTexts.join('\n\n') : '') } }] },
    'Clips': { number: clipCount },
    'loopd Date': { rich_text: [{ text: { content: date } }] },
  };

  // Set habit checkbox columns
  for (const label of habitLabels) {
    props[label] = { checkbox: habitsChecked.includes(label) };
  }

  return props;
}

// ── Daily Log: parse habit checkboxes from Notion row ──

export function parseDailyLogHabits(page: NotionPage, habitLabels: string[]): string[] {
  const checked: string[] = [];
  for (const label of habitLabels) {
    if (getCheckbox(page.properties[label])) {
      checked.push(label);
    }
  }
  return checked;
}
