import { queryDatabase, createPage, updatePage, archivePage } from './api';
import { getNotionToken, getEntriesDbId, getDailyLogDbId, getLastSyncTimestamp, setLastSyncTimestamp } from './config';
import { notionPageToEntry, entryToNotionProperties, entriesToDailyLogProperties, parseDailyLogHabits } from './mapper';
import {
  getUnsyncedEntries, upsertEntryFromNotion, setEntryNotionPageId,
  getEntryById, getEntryByNotionPageId, getEntriesByDate, getHabits,
  getSyncDeletions, clearSyncDeletions, getAllEntries,
  insertEntry,
} from '../database';
import { generateId } from '../../utils/id';
import { getTodayString } from '../../utils/time';
import type { Entry } from '../../types/entry';
import type { SyncResult } from '../../types/notion';

export async function syncAll(): Promise<SyncResult> {
  const token = await getNotionToken();
  const entriesDbId = await getEntriesDbId();
  if (!token || !entriesDbId) throw new Error('Notion not configured');

  const result: SyncResult = { pulled: 0, pushed: 0, errors: [] };
  const lastSync = await getLastSyncTimestamp();

  try {
    // 1. Pull entries from Notion
    const pullResult = await pullEntries(token, entriesDbId, lastSync);
    result.pulled += pullResult;

    // 2. Push local entries to Notion
    const pushResult = await pushEntries(token, entriesDbId, lastSync);
    result.pushed += pushResult;

    // 3. Process deletions
    await processDeletions(token);

    // 4. Aggregate daily log (if configured)
    const dailyLogDbId = await getDailyLogDbId();
    if (dailyLogDbId) {
      await syncDailyLog(token, dailyLogDbId);
    }

    // 5. Update last sync timestamp
    await setLastSyncTimestamp(new Date().toISOString());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(msg);
    console.error('[loopd sync] Error:', msg);
  }

  console.log('[loopd sync] Result:', result);
  return result;
}

async function pullEntries(token: string, dbId: string, _lastSync: string | null): Promise<number> {
  // Always do a full pull — dataset is small and ensures we catch all changes
  // including column renames, edits, and new entries
  const pages = await queryDatabase(token, dbId);
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
        // Conflict resolution: last-edit-wins
        const notionTime = new Date(page.last_edited_time).getTime();
        const localTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
        if (notionTime > localTime) {
          // Update using the existing local ID to avoid duplicates
          await upsertEntryFromNotion({ ...entry, id: existing.id });
          count++;
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

  return count;
}

async function pushEntries(token: string, dbId: string, lastSync: string | null): Promise<number> {
  const unsyncedEntries = await getUnsyncedEntries(lastSync);
  let count = 0;

  for (const entry of unsyncedEntries) {
    try {
      const properties = entryToNotionProperties(entry);

      if (entry.notionPageId) {
        // Update existing Notion page
        await updatePage(token, entry.notionPageId, properties);
      } else {
        // Create new Notion page
        const page = await createPage(token, dbId, properties);
        await setEntryNotionPageId(entry.id, page.id);
      }
      count++;
    } catch (err) {
      console.warn('[loopd sync] Push error for entry', entry.id, err);
    }
  }

  return count;
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
      const props = entriesToDailyLogProperties(date, allEntries, habitLabels);
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

  // Pull habit checkbox changes from Daily Log back to entries
  for (const page of existingPages) {
    if (page.archived) continue;
    const dateKey = getPropertyText(page, 'loopd Date') || getPropertyDate(page, 'Date');
    if (!dateKey) continue;

    try {
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

// ── Helpers ──

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
