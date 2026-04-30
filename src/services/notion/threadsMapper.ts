import type { Thread } from '../../types/thread';
import type { NotionPage } from '../../types/notion';
import type { TimeOfDay } from '../../types/entry';

// Threads DB sync. Bidirectional for everything except `slug` — slug edits
// in Notion are rejected on pull (per spec § 9.2 + plan decision #3) because
// changing the slug invalidates existing #tag mention reconciliation.

const PROP = {
  name: 'Name',
  loopdId: 'loopd ID',
  slug: 'Slug',
  icon: 'Icon',
  color: 'Color',
  targetCadenceDays: 'Target Cadence (days)',
  archived: 'Archived',
  pinned: 'Pinned',
  timeOfDay: 'Time of Day',
} as const;

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

function getCheckbox(prop: unknown): boolean {
  const p = prop as { type?: string; checkbox?: boolean } | undefined;
  if (!p || p.type !== 'checkbox') return false;
  return p.checkbox ?? false;
}

function getNumber(prop: unknown): number | null {
  const p = prop as { type?: string; number?: number | null } | undefined;
  if (!p || p.type !== 'number') return null;
  return typeof p.number === 'number' ? p.number : null;
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

const VALID_TIME_OF_DAY = new Set<TimeOfDay>(['morning', 'midday', 'evening', 'anytime']);

function parseTimeOfDay(raw: string | null): TimeOfDay | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return VALID_TIME_OF_DAY.has(lower as TimeOfDay) ? (lower as TimeOfDay) : null;
}

// ── Notion → loopd ──

export type ParsedNotionThread = {
  notionPageId: string;
  loopdId: string | null;
  name: string;
  slug: string | null;
  icon: string | null;
  color: string | null;
  targetCadenceDays: number | null;
  archived: boolean | null;
  pinned: boolean | null;
  timeOfDay: TimeOfDay | null;
  notionEditedAt: string;
};

export function notionPageToThread(page: NotionPage): ParsedNotionThread {
  const props = page.properties;
  const titleKey = getTitlePropertyKey(props);
  const name = getPlainText(props[titleKey]) || '(untitled)';
  const loopdIdRaw = PROP.loopdId in props ? getPlainText(props[PROP.loopdId]) : '';
  return {
    notionPageId: page.id,
    loopdId: loopdIdRaw || null,
    name,
    slug: PROP.slug in props ? (getPlainText(props[PROP.slug]) || null) : null,
    icon: PROP.icon in props ? (getPlainText(props[PROP.icon]) || null) : null,
    color: PROP.color in props ? (getPlainText(props[PROP.color]) || null) : null,
    targetCadenceDays: PROP.targetCadenceDays in props ? getNumber(props[PROP.targetCadenceDays]) : null,
    archived: PROP.archived in props ? getCheckbox(props[PROP.archived]) : null,
    pinned: PROP.pinned in props ? getCheckbox(props[PROP.pinned]) : null,
    timeOfDay: PROP.timeOfDay in props ? parseTimeOfDay(getSelect(props[PROP.timeOfDay])) : null,
    notionEditedAt: page.last_edited_time,
  };
}

// ── loopd → Notion ──

export function threadToNotionProperties(
  thread: Thread,
  titleColumnName: string,
  availableProperties?: Set<string>,
): Record<string, unknown> {
  const has = (name: string) => !availableProperties || availableProperties.has(name);
  const props: Record<string, unknown> = {
    [titleColumnName]: { title: [{ text: { content: thread.name || '(untitled)' } }] },
  };
  if (has(PROP.loopdId)) {
    props[PROP.loopdId] = { rich_text: [{ text: { content: thread.id } }] };
  }
  if (has(PROP.slug)) {
    props[PROP.slug] = { rich_text: [{ text: { content: thread.slug } }] };
  }
  if (has(PROP.icon)) {
    props[PROP.icon] = thread.icon
      ? { rich_text: [{ text: { content: thread.icon } }] }
      : { rich_text: [] };
  }
  if (has(PROP.color)) {
    props[PROP.color] = thread.color
      ? { rich_text: [{ text: { content: thread.color } }] }
      : { rich_text: [] };
  }
  if (has(PROP.targetCadenceDays)) {
    props[PROP.targetCadenceDays] = { number: thread.targetCadenceDays ?? null };
  }
  if (has(PROP.archived)) {
    props[PROP.archived] = { checkbox: !!thread.archived };
  }
  if (has(PROP.pinned)) {
    props[PROP.pinned] = { checkbox: !!thread.pinned };
  }
  if (has(PROP.timeOfDay)) {
    props[PROP.timeOfDay] = { select: { name: thread.timeOfDay ?? 'anytime' } };
  }
  return props;
}

export function detectMissingThreadProperties(
  schemaProps: Record<string, unknown>,
): Set<string> {
  const missing = new Set<string>();
  for (const name of [
    PROP.loopdId, PROP.slug, PROP.icon, PROP.color,
    PROP.targetCadenceDays, PROP.archived, PROP.pinned, PROP.timeOfDay,
  ]) {
    if (!(name in schemaProps)) missing.add(name);
  }
  return missing;
}

export { getTitlePropertyKey, PROP };
