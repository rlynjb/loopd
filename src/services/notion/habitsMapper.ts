import type { Habit, CadenceType, TimeOfDay } from '../../types/entry';
import type { NotionPage } from '../../types/notion';

// Optional Habits DB sync. Independent of the Entries-DB Habits multi-select
// options that govern identity — this DB carries the cadence metadata that
// Phase A added.
//
// Property names (case-sensitive). Existing-DB tolerance: any property the
// schema doesn't declare gets skipped on push and yields null on pull.

const PROP = {
  name: 'Name',
  loopdId: 'loopd ID',
  slug: 'Slug',
  cadenceType: 'Cadence Type',
  cadenceDays: 'Cadence Days',
  cadenceCount: 'Cadence Count',
  timeOfDay: 'Time of Day',
  icon: 'Icon',
  color: 'Color',
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

function getSelect(prop: unknown): string | null {
  const p = prop as { type?: string; select?: { name: string } | null } | undefined;
  if (!p || p.type !== 'select' || !p.select) return null;
  return p.select.name ?? null;
}

function getMultiSelect(prop: unknown): string[] {
  const p = prop as { type?: string; multi_select?: { name: string }[] } | undefined;
  if (!p || p.type !== 'multi_select' || !p.multi_select) return [];
  return p.multi_select.map(x => x.name);
}

function getNumber(prop: unknown): number | null {
  const p = prop as { type?: string; number?: number | null } | undefined;
  if (!p || p.type !== 'number') return null;
  return typeof p.number === 'number' ? p.number : null;
}

function getTitlePropertyKey(props: Record<string, unknown>): string {
  for (const [key, val] of Object.entries(props)) {
    const p = val as { type?: string };
    if (p?.type === 'title') return key;
  }
  return 'Name';
}

const VALID_CADENCE = new Set<CadenceType>([
  'daily', 'weekdays', 'weekly', 'specific_days', 'n_per_week',
]);

function parseCadence(raw: string | null): CadenceType | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/\s+/g, '_');
  return VALID_CADENCE.has(lower as CadenceType) ? (lower as CadenceType) : null;
}

const VALID_TIME_OF_DAY = new Set<TimeOfDay>([
  'morning', 'midday', 'evening', 'anytime',
]);

function parseTimeOfDay(raw: string | null): TimeOfDay | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return VALID_TIME_OF_DAY.has(lower as TimeOfDay) ? (lower as TimeOfDay) : null;
}

// Day name → 0..6 (Sun=0). Tolerates Mon/Mo/M etc.
function parseDayName(s: string): number | null {
  const lower = s.trim().toLowerCase().slice(0, 3);
  const map: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  };
  return lower in map ? map[lower] : null;
}

const DAY_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Notion → loopd ──

export type ParsedNotionHabit = {
  notionPageId: string;
  loopdId: string | null;       // null when the page wasn't created from loopd
  name: string;
  slug: string | null;
  cadenceType: CadenceType | null;
  cadenceDays: number[] | null;
  cadenceCount: number | null;
  timeOfDay: TimeOfDay | null;
  icon: string | null;
  color: string | null;
  notionEditedAt: string;
};

export function notionPageToHabit(page: NotionPage): ParsedNotionHabit {
  const props = page.properties;
  const titleKey = getTitlePropertyKey(props);
  const name = getPlainText(props[titleKey]) || '(untitled)';
  const loopdIdRaw = PROP.loopdId in props ? getPlainText(props[PROP.loopdId]) : '';
  const days = PROP.cadenceDays in props
    ? getMultiSelect(props[PROP.cadenceDays]).map(parseDayName).filter((n): n is number => n !== null)
    : null;
  return {
    notionPageId: page.id,
    loopdId: loopdIdRaw || null,
    name,
    slug: PROP.slug in props ? (getPlainText(props[PROP.slug]) || null) : null,
    cadenceType: PROP.cadenceType in props ? parseCadence(getSelect(props[PROP.cadenceType])) : null,
    cadenceDays: days && days.length > 0 ? days : null,
    cadenceCount: PROP.cadenceCount in props ? getNumber(props[PROP.cadenceCount]) : null,
    timeOfDay: PROP.timeOfDay in props ? parseTimeOfDay(getSelect(props[PROP.timeOfDay])) : null,
    icon: PROP.icon in props ? (getPlainText(props[PROP.icon]) || null) : null,
    color: PROP.color in props ? (getPlainText(props[PROP.color]) || null) : null,
    notionEditedAt: page.last_edited_time,
  };
}

// ── loopd → Notion ──

export function habitToNotionProperties(
  habit: Habit,
  titleColumnName: string,
  availableProperties?: Set<string>,
): Record<string, unknown> {
  const has = (name: string) => !availableProperties || availableProperties.has(name);
  const props: Record<string, unknown> = {
    [titleColumnName]: { title: [{ text: { content: habit.label || '(untitled)' } }] },
  };

  if (has(PROP.loopdId)) props[PROP.loopdId] = { rich_text: [{ text: { content: habit.id } }] };
  if (has(PROP.slug) && habit.slug) {
    props[PROP.slug] = { rich_text: [{ text: { content: habit.slug } }] };
  }

  if (has(PROP.cadenceType)) {
    const ct = habit.cadenceType ?? 'daily';
    props[PROP.cadenceType] = { select: { name: ct } };
  }

  if (has(PROP.cadenceDays)) {
    const days = habit.cadenceDays ?? [];
    props[PROP.cadenceDays] = {
      multi_select: days.map(d => ({ name: DAY_NAME[d] })),
    };
  }

  if (has(PROP.cadenceCount)) {
    props[PROP.cadenceCount] = { number: habit.cadenceCount ?? null };
  }

  if (has(PROP.timeOfDay)) {
    props[PROP.timeOfDay] = { select: { name: habit.timeOfDay ?? 'anytime' } };
  }

  if (has(PROP.icon) && habit.icon) {
    props[PROP.icon] = { rich_text: [{ text: { content: habit.icon } }] };
  }
  if (has(PROP.color) && habit.color) {
    props[PROP.color] = { rich_text: [{ text: { content: habit.color } }] };
  }

  return props;
}

export function detectMissingHabitProperties(
  schemaProps: Record<string, unknown>,
): Set<string> {
  const missing = new Set<string>();
  for (const name of [
    PROP.cadenceType, PROP.cadenceDays, PROP.cadenceCount, PROP.timeOfDay,
    PROP.slug, PROP.icon, PROP.color, PROP.loopdId,
  ]) {
    if (!(name in schemaProps)) missing.add(name);
  }
  return missing;
}

export { getTitlePropertyKey, PROP };
