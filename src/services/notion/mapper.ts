import type { Entry, ClipRef } from '../../types/entry';
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

// ── Entry: Notion → loopd ──

export function notionPageToEntry(page: NotionPage): Entry {
  const props = page.properties;
  const loopdId = getPlainText(props['loopd ID']) || generateId('notion');
  const date = getDate(props['Date']) ?? new Date(page.created_time).toISOString().slice(0, 10);
  const type = (getSelect(props['Type']) ?? 'journal') as Entry['type'];
  const text = getPlainText(props['Text']) || getPlainText(props['Title'] ?? props['Name']) || null;
  const habits = getMultiSelect(props['Habits']);
  const createdAt = getDate(props['Created At']) ?? page.created_time;

  // Parse clips JSON from rich_text
  let clips: ClipRef[] = [];
  const clipsRaw = getPlainText(props['Clips']);
  if (clipsRaw) {
    try { clips = JSON.parse(clipsRaw); } catch { /* ignore */ }
  }

  return {
    id: loopdId,
    date,
    type: ['video', 'journal', 'habit'].includes(type) ? type : 'journal',
    text,
    mood: null,
    category: null,
    habits,
    clipUri: clips[0]?.uri ?? null,
    clipDurationMs: clips[0]?.durationMs ?? null,
    clips,
    createdAt,
    notionPageId: page.id,
    updatedAt: page.last_edited_time,
  };
}

// ── Entry: loopd → Notion properties ──

export function entryToNotionProperties(entry: Entry, isNew = false): Record<string, unknown> {
  const clipsJson = entry.clips.length > 0
    ? JSON.stringify(entry.clips.map(c => ({ uri: c.uri.split('/').pop(), durationMs: c.durationMs })))
    : '';

  const props: Record<string, unknown> = {
    'Date': { date: { start: entry.date } },
    'Type': { select: { name: entry.type } },
    'Text': { rich_text: [{ text: { content: entry.text ?? '' } }] },
    'Habits': { multi_select: entry.habits.map(h => ({ name: h })) },
    'Clips': { rich_text: [{ text: { content: clipsJson } }] },
    'loopd ID': { rich_text: [{ text: { content: entry.id } }] },
    'Created At': { date: { start: entry.createdAt } },
  };

  // Only set the title on new pages — don't overwrite existing titles
  if (isNew) {
    const label = entry.type === 'video'
      ? `Clip — ${entry.date}`
      : entry.type === 'habit'
        ? `Habits — ${entry.date}`
        : entry.text?.slice(0, 60) ?? `Journal — ${entry.date}`;
    // Try both common title column names
    props['Name'] = { title: [{ text: { content: label } }] };
  }

  return props;
}

// ── Daily Log: aggregate entries into daily row properties ──

export function entriesToDailyLogProperties(
  date: string,
  entries: Entry[],
  habitLabels: string[],
): Record<string, unknown> {
  const dayEntries = entries.filter(e => e.date === date);
  const clipCount = dayEntries.filter(e => e.type === 'video').reduce((sum, e) => sum + Math.max(e.clips.length, 1), 0);
  const journalTexts = dayEntries.filter(e => e.type === 'journal').map(e => e.text).filter(Boolean);
  const habitsChecked = [...new Set(dayEntries.filter(e => e.type === 'habit').flatMap(e => e.habits))];

  const summary = [
    clipCount > 0 ? `${clipCount} clip${clipCount > 1 ? 's' : ''}` : '',
    journalTexts.length > 0 ? `${journalTexts.length} journal${journalTexts.length > 1 ? 's' : ''}` : '',
    habitsChecked.length > 0 ? `${habitsChecked.length} habit${habitsChecked.length > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(', ');

  const props: Record<string, unknown> = {
    'Name': { title: [{ text: { content: date } }] },
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
