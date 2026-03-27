import { queryDatabase, createPage, updatePage, archivePage, getDatabase as getNotionDatabase } from './api';
import { getNotionToken, getEntriesDbId, getDailyLogDbId, getLastSyncTimestamp, setLastSyncTimestamp } from './config';
import { notionPageToEntry, entryToNotionProperties, entriesToDailyLogProperties, parseDailyLogHabits, getTitlePropertyKey } from './mapper';
import {
  getUnsyncedEntries, upsertEntryFromNotion, setEntryNotionPageId,
  getEntryById, getEntryByNotionPageId, getEntriesByDate, getHabits,
  getSyncDeletions, clearSyncDeletions, getAllEntries,
  insertEntry, insertHabit, deleteHabit, getDayTitle, getDayTitleWithTimestamp, setDayTitle, setDayTitleFromSync,
} from '../database';
import { generateId } from '../../utils/id';
import { getTodayString } from '../../utils/time';
import { reimportMissingClips } from '../clipMatcher';
import type { Entry } from '../../types/entry';
import type { SyncResult } from '../../types/notion';

export async function syncAll(): Promise<SyncResult> {
  const token = await getNotionToken();
  const entriesDbId = await getEntriesDbId();
  if (!token || !entriesDbId) throw new Error('Notion not configured');

  const result: SyncResult = { pulled: 0, pushed: 0, errors: [], debug: [] };
  const lastSync = await getLastSyncTimestamp();

  try {
    // 1. Sync habit list from Notion's Habits multi-select options
    await syncHabitsFromNotionSchema(token, entriesDbId);

    // 2. Pull entries from Notion
    const pullResult = await pullEntries(token, entriesDbId, lastSync, result.debug);
    result.pulled += pullResult;

    // 2b. Auto-reimport missing video clips from camera roll
    try {
      const allEntries = await getAllEntries();
      const videoEntries = allEntries.filter(e => e.type === 'video');
      const reimported = await reimportMissingClips(videoEntries);
      if (reimported > 0) {
        console.log(`[loopd sync] Auto-reimported ${reimported} clip(s) from camera roll`);
      }
    } catch (err) {
      console.warn('[loopd sync] Clip reimport error:', err);
    }

    // 3. Push local entries to Notion + clean up names
    const pushResult = await pushEntries(token, entriesDbId, lastSync);
    result.pushed += pushResult.count;
    result.errors.push(...pushResult.errors);

    // 4. Clean up Notion entry names (append type to all entries)
    await cleanUpNotionNames(token, entriesDbId);

    // 5. Process deletions (skip on fresh install — no previous sync)
    if (lastSync) {
      await processDeletions(token);
    } else {
      // Clear any stale deletion records from a previous install
      await clearSyncDeletions();
    }

    // 6. Aggregate daily log (if configured)
    const dailyLogDbId = await getDailyLogDbId();
    if (dailyLogDbId) {
      await syncDailyLog(token, dailyLogDbId);
    }

    // 7. Update last sync timestamp
    await setLastSyncTimestamp(new Date().toISOString());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(msg);
    console.error('[loopd sync] Error:', msg);
  }

  console.log('[loopd sync] Result:', result);
  return result;
}

async function pullEntries(token: string, dbId: string, _lastSync: string | null, debug: string[] = []): Promise<number> {
  // Pull entries from last 7 days using Created At
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let pages;
  try {
    pages = await queryDatabase(token, dbId, {
      or: [
        { property: 'Created At', date: { on_or_after: sevenDaysAgo } },
        { property: 'Created At', date: { is_empty: true } },
      ],
    });
  } catch {
    try {
      pages = await queryDatabase(token, dbId, {
        property: 'Created At',
        date: { on_or_after: sevenDaysAgo },
      });
    } catch {
      console.log('[loopd sync] Date filters failed, pulling all entries');
      pages = await queryDatabase(token, dbId);
    }
  }
  debug.push(`Fetched ${pages.length} pages from Notion`);
  let count = 0;

  // Track which notion page IDs we've seen (for detecting Notion-side deletions)
  const seenNotionIds = new Set<string>();

  for (const page of pages) {
    if (page.archived) continue;
    seenNotionIds.add(page.id);

    try {
      const entry = notionPageToEntry(page);

      // Check if we already have this entry locally (by loopd ID or notion page ID)
      let existing = await getEntryById(entry.id);
      if (!existing) {
        existing = await getEntryByNotionPageId(page.id);
      }

      if (existing) {
        // Always fix the date from Created At
        if (existing.date !== entry.date) {
          await upsertEntryFromNotion({ ...entry, id: existing.id });
          count++;
        } else {
          // Conflict resolution: last-edit-wins
          const notionTime = new Date(page.last_edited_time).getTime();
          const localTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
          if (notionTime > localTime) {
            await upsertEntryFromNotion({ ...entry, id: existing.id });
            count++;
          }
        }
      } else {
        // New entry from Notion
        await upsertEntryFromNotion(entry);
        count++;
      }

      // If the Notion page didn't have a loopd ID, write it back
      const loopdIdOnPage = getPropertyText(page, 'loopd ID');
      if (!loopdIdOnPage) {
        await updatePage(token, page.id, {
          'loopd ID': { rich_text: [{ text: { content: entry.id } }] },
        });
      }
    } catch (err) {
      console.warn('[loopd sync] Pull error for page', page.id, err);
    }
  }

  // Pull day titles from Notion entry names
  // Format: "My Title [Journal]" → extract "My Title"
  const titlesByDate = new Map<string, { title: string; editTime: number }>();
  for (const page of pages) {
    if (page.archived) continue;
    const entry = notionPageToEntry(page);
    const pageName = getTitleFromPage(page);
    if (!pageName || !entry.date) continue;

    // Strip [Type] tag
    let dayTitle = pageName;
    const tagMatch = dayTitle.match(/\s*\[(Journal|Clip|Habits)\]\s*$/);
    if (tagMatch) {
      dayTitle = dayTitle.slice(0, -tagMatch[0].length).trim();
    }

    // Skip if it's just a date string or empty
    if (!dayTitle || dayTitle.match(/^\d{4}-\d{2}-\d{2}/)) continue;

    const editTime = new Date(page.last_edited_time).getTime();

    // Keep the most recently edited title per date
    const existing = titlesByDate.get(entry.date);
    if (!existing || editTime > existing.editTime) {
      titlesByDate.set(entry.date, { title: dayTitle, editTime });
    }
  }

  // Save pulled titles — last edit wins
  for (const [date, { title: notionTitle, editTime: notionEditTime }] of titlesByDate) {
    const local = await getDayTitleWithTimestamp(date);
    if (local.title === notionTitle) continue;

    const localEditTime = local.updatedAt ? new Date(local.updatedAt).getTime() : 0;

    const notionDate = new Date(notionEditTime).toISOString().slice(11, 19);
    const localDate = localEditTime ? new Date(localEditTime).toISOString().slice(11, 19) : 'none';
    debug.push(`Title ${date}: notion="${notionTitle}" (${notionDate}) vs local="${local.title}" (${localDate})`);

    // Use Notion title if: Notion is newer, titles differ and within 2min tolerance, or local is empty
    const diff = Math.abs(notionEditTime - localEditTime);
    const notionWins = notionEditTime > localEditTime || diff < 120000 || !local.title;

    if (notionWins) {
      await setDayTitleFromSync(date, notionTitle, new Date(notionEditTime).toISOString());
      debug.push(`→ Used Notion title (diff: ${Math.round(diff / 1000)}s)`);
    } else {
      debug.push(`→ Kept local title`);
    }
  }

  return count;
}

async function pushEntries(token: string, dbId: string, lastSync: string | null): Promise<{ count: number; errors: string[] }> {
  const unsyncedEntries = await getUnsyncedEntries(lastSync);
  let count = 0;
  const errors: string[] = [];

  // Detect the title column name from the database schema
  let titleColumn = 'Name';
  try {
    const dbSchema = await getNotionDatabase(token, dbId) as { properties: Record<string, unknown> };
    titleColumn = getTitlePropertyKey(dbSchema.properties);
  } catch { /* fallback to 'Name' */ }

  // Cache day titles and build habit ID→label map
  const dayTitleCache = new Map<string, string>();
  const habits = await getHabits();
  const habitIdToLabel = new Map(habits.map(h => [h.id, h.label]));

  for (const entry of unsyncedEntries) {
    try {
      if (!dayTitleCache.has(entry.date)) {
        dayTitleCache.set(entry.date, await getDayTitle(entry.date));
      }
      const dayTitle = dayTitleCache.get(entry.date) || undefined;
      const isNew = !entry.notionPageId;
      const properties = entryToNotionProperties(entry, titleColumn, dayTitle, isNew, habitIdToLabel);

      if (entry.notionPageId) {
        console.log('[loopd sync] Updating entry:', entry.id, entry.type);
        await updatePage(token, entry.notionPageId, properties);
      } else {
        console.log('[loopd sync] Creating entry:', entry.id, entry.type, 'habits:', entry.habits);
        const page = await createPage(token, dbId, properties);
        await setEntryNotionPageId(entry.id, page.id);
      }
      count++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[loopd sync] Push FAILED for entry', entry.id, entry.type, 'notionPageId:', entry.notionPageId, 'error:', msg);
      errors.push(`Push ${entry.type}: ${msg.slice(0, 100)}`);
    }
  }

  return { count, errors };
}

async function cleanUpNotionNames(token: string, dbId: string): Promise<void> {
  try {
    // Get title column name
    let titleColumn = 'Name';
    try {
      const dbSchema = await getNotionDatabase(token, dbId) as { properties: Record<string, unknown> };
      titleColumn = getTitlePropertyKey(dbSchema.properties);
    } catch { /* fallback */ }

    const pages = await queryDatabase(token, dbId);
    const habits = await getHabits();
    const habitIdToLabel = new Map(habits.map(h => [h.id, h.label]));

    for (const page of pages) {
      if (page.archived) continue;
      const currentName = getTitleFromPage(page);
      const entry = notionPageToEntry(page);

      // Check if the name already has the [Type] format
      const typeLabel = entry.type === 'video' ? 'Clip' : entry.type === 'habit' ? 'Habits' : 'Journal';
      if (currentName.includes(`[${typeLabel}]`)) continue;

      // Strip old " — Type" format if present
      let baseName = currentName;
      const oldSuffixes = [' — Journal', ' — Clip', ' — Habits', ' — video', ' — journal', ' — habit'];
      for (const suffix of oldSuffixes) {
        if (baseName.endsWith(suffix)) {
          baseName = baseName.slice(0, -suffix.length);
          break;
        }
      }

      // Build the clean name
      let cleanName: string;
      if (baseName && baseName !== entry.date && !baseName.match(/^\d{4}-\d{2}-\d{2}/)) {
        cleanName = `${baseName.slice(0, 50)}${baseName.length > 50 ? '...' : ''} [${typeLabel}]`;
      } else {
        const preview = entry.text?.slice(0, 50) ?? '';
        cleanName = preview
          ? `${preview}${preview.length >= 50 ? '...' : ''} [${typeLabel}]`
          : `${entry.date} [${typeLabel}]`;
      }

      if (cleanName !== currentName) {
        await updatePage(token, page.id, {
          [titleColumn]: { title: [{ text: { content: cleanName } }] },
        });
        console.log('[loopd sync] Cleaned name:', currentName, '→', cleanName);
      }
    }
  } catch (err) {
    console.warn('[loopd sync] Name cleanup error:', err);
  }
}

async function processDeletions(token: string): Promise<void> {
  const deletions = await getSyncDeletions();
  for (const del of deletions) {
    try {
      await archivePage(token, del.notionPageId);
    } catch (err) {
      console.warn('[loopd sync] Delete error for', del.notionPageId, err);
    }
  }
  if (deletions.length > 0) {
    await clearSyncDeletions();
  }
}

async function syncDailyLog(token: string, dailyLogDbId: string): Promise<void> {
  const allEntries = await getAllEntries();
  const habits = await getHabits();
  const habitLabels = habits.map(h => h.label);

  // Detect the title column name
  let titleColumn = 'Name';
  try {
    const dbSchema = await getNotionDatabase(token, dailyLogDbId) as { properties: Record<string, unknown> };
    titleColumn = getTitlePropertyKey(dbSchema.properties);
  } catch { /* fallback */ }

  // Get unique dates that have entries
  const dates = [...new Set(allEntries.map(e => e.date))];

  // Get existing daily log pages
  const existingPages = await queryDatabase(token, dailyLogDbId);
  const pagesByDate = new Map<string, string>();
  for (const page of existingPages) {
    const dateKey = getPropertyText(page, 'loopd Date') || getPropertyDate(page, 'Date');
    if (dateKey) pagesByDate.set(dateKey, page.id);
  }

  for (const date of dates) {
    try {
      const dayTitle = await getDayTitle(date);
      const props = entriesToDailyLogProperties(date, allEntries, habitLabels, titleColumn, dayTitle);
      const existingPageId = pagesByDate.get(date);

      if (existingPageId) {
        await updatePage(token, existingPageId, props);
      } else {
        await createPage(token, dailyLogDbId, props);
      }
    } catch (err) {
      console.warn('[loopd sync] Daily log error for', date, err);
    }
  }

  // Pull day titles and habit checkbox changes from Daily Log
  for (const page of existingPages) {
    if (page.archived) continue;
    const dateKey = getPropertyText(page, 'loopd Date') || getPropertyDate(page, 'Date');
    if (!dateKey) continue;

    try {
      // Pull day title from Notion's title column — last-edit-wins
      const notionTitle = getTitleFromPage(page);
      if (notionTitle && notionTitle !== dateKey) {
        const local = await getDayTitleWithTimestamp(dateKey);
        if (local.title !== notionTitle) {
          const notionEditTime = new Date(page.last_edited_time).getTime();
          const localEditTime = local.updatedAt ? new Date(local.updatedAt).getTime() : 0;
          if (notionEditTime > localEditTime) {
            await setDayTitleFromSync(dateKey, notionTitle);
            console.log('[loopd sync] Pulled day title from daily log:', dateKey, notionTitle);
          }
        }
      }

      const notionHabits = parseDailyLogHabits(page, habitLabels);
      const dayEntries = await getEntriesByDate(dateKey);
      const existingHabitEntry = dayEntries.find(e => e.type === 'habit');
      const existingChecked = existingHabitEntry?.habits ?? [];

      // If Notion has different habits checked, update or create habit entry
      const notionSet = new Set(notionHabits);
      const localSet = new Set(existingChecked);
      const hasChanged = notionHabits.length !== existingChecked.length ||
        notionHabits.some(h => !localSet.has(h)) ||
        existingChecked.some(h => !notionSet.has(h));

      if (hasChanged && notionHabits.length > 0) {
        if (existingHabitEntry) {
          await upsertEntryFromNotion({
            ...existingHabitEntry,
            habits: notionHabits,
          });
        } else {
          await insertEntry({
            id: generateId('notion-habit'),
            date: dateKey,
            type: 'habit',
            text: null,
            mood: null,
            category: null,
            habits: notionHabits,
            clipUri: null,
            clipDurationMs: null,
            clips: [],
            createdAt: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      console.warn('[loopd sync] Habit checkbox pull error for', dateKey, err);
    }
  }
}

// ── Sync habits from Notion schema ──

async function syncHabitsFromNotionSchema(token: string, entriesDbId: string): Promise<void> {
  try {
    const dbSchema = await getNotionDatabase(token, entriesDbId) as {
      properties: Record<string, { type: string; multi_select?: { options: { name: string; color: string }[] } }>;
    };

    // Find the Habits multi-select property
    const habitsProperty = dbSchema.properties['Habits'];
    if (!habitsProperty || habitsProperty.type !== 'multi_select' || !habitsProperty.multi_select) return;

    const notionOptions = habitsProperty.multi_select.options;
    if (notionOptions.length === 0) return;

    const localHabits = await getHabits();
    const localIds = new Set(localHabits.map(h => h.id));
    const notionIds = new Set(notionOptions.map(o => o.name.toLowerCase().replace(/\s+/g, '-')));

    // Add habits that exist in Notion but not locally
    for (let i = 0; i < notionOptions.length; i++) {
      const opt = notionOptions[i];
      const id = opt.name.toLowerCase().replace(/\s+/g, '-');
      if (!localIds.has(id)) {
        await insertHabit({
          id,
          label: opt.name,
          emoji: '',
          sortOrder: i,
        });
        console.log('[loopd sync] Added habit from Notion:', opt.name);
      }
    }

    // Remove local habits that no longer exist in Notion options
    for (const local of localHabits) {
      if (!notionIds.has(local.id)) {
        await deleteHabit(local.id);
        console.log('[loopd sync] Removed habit not in Notion:', local.label);
      }
    }
  } catch (err) {
    console.warn('[loopd sync] Habit schema sync error:', err);
  }
}

// ── Helpers ──

function getTitleFromPage(page: { properties: Record<string, unknown> }): string {
  for (const [, val] of Object.entries(page.properties)) {
    const p = val as { type?: string; title?: { plain_text: string }[] };
    if (p?.type === 'title' && p.title) {
      return p.title.map(t => t.plain_text).join('');
    }
  }
  return '';
}

function getPropertyText(page: { properties: Record<string, unknown> }, key: string): string {
  const prop = page.properties[key] as { type: string; rich_text?: { plain_text: string }[]; title?: { plain_text: string }[] } | undefined;
  if (!prop) return '';
  if (prop.type === 'rich_text') return prop.rich_text?.map(t => t.plain_text).join('') ?? '';
  if (prop.type === 'title') return prop.title?.map(t => t.plain_text).join('') ?? '';
  return '';
}

function getPropertyDate(page: { properties: Record<string, unknown> }, key: string): string | null {
  const prop = page.properties[key] as { type: string; date?: { start: string } | null } | undefined;
  if (!prop || prop.type !== 'date' || !prop.date) return null;
  return prop.date.start;
}
