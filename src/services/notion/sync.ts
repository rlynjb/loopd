import { queryDatabase, createPage, updatePage, archivePage, getDatabase as getNotionDatabase } from './api';
import {
  getNotionToken, getEntriesDbId, getTodosDbId,
  getLastSyncTimestamp, setLastSyncTimestamp,
  getTodosLastSyncTimestamp, setTodosLastSyncTimestamp,
} from './config';
import { notionPageToEntry, entryToNotionProperties, getTitlePropertyKey } from './mapper';
import {
  notionPageToTodo, todoToNotionProperties, detectMissingTodoProperties,
} from './todosMapper';
import {
  getUnsyncedEntries, upsertEntryFromNotion, setEntryNotionPageId,
  getEntryById, getEntryByNotionPageId, getEntriesByDate, getHabits,
  getSyncDeletions, clearSyncDeletions, getAllEntries, updateEntry,
  insertEntry, insertHabit, deleteHabit, getDayTitle, getDayTitleWithTimestamp, setDayTitle, setDayTitleFromSync,
  rebuildVlogs,
  getAllTodoMetas, getTodoMeta, insertTodoMeta, updateTodoMeta,
} from '../database';
import type { TodoMeta } from '../../types/todoMeta';
import { generateId } from '../../utils/id';
import { addDays, getTodayString, toLocalDateString } from '../../utils/time';
import { reimportMissingClips } from '../clipMatcher';
import type { Entry, TodoItem } from '../../types/entry';
import type { SyncResult } from '../../types/notion';

export async function syncAll(): Promise<SyncResult> {
  const token = await getNotionToken();
  const entriesDbId = await getEntriesDbId();
  if (!token || !entriesDbId) throw new Error('Notion not configured');

  const result: SyncResult = { pulled: 0, pushed: 0, errors: [], debug: [] };
  const lastSync = await getLastSyncTimestamp();

  try {
    // 0. Clean up ghost entries (notion-prefixed IDs with no content)
    try {
      const allLocal = await getAllEntries();
      for (const e of allLocal) {
        if (e.id.startsWith('notion-') && !e.text && e.habits.length === 0 && e.clips.length === 0) {
          console.log(`[loopd sync] Removing ghost entry: ${e.id}`);
          const { deleteEntry } = await import('../database');
          await deleteEntry(e.id);
        }
      }
    } catch (err) {
      console.warn('[loopd sync] Ghost cleanup error:', err);
    }

    // 1. Sync habit list from Notion's Habits multi-select options
    await syncHabitsFromNotionSchema(token, entriesDbId);

    // 2. Pull entries from Notion
    const pullResult = await pullEntries(token, entriesDbId, lastSync, result.debug);
    result.pulled += pullResult;

    // 2b. Auto-reimport missing video clips from camera roll
    try {
      const allEntries = await getAllEntries();
      const videoEntries = allEntries.filter(e => e.clips.length > 0);
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

    // 3b. Backfill empty Date columns in Notion from local data
    await backfillNotionDates(token, entriesDbId);

    // 4. Clean up Notion entry names (append type to all entries)
    await cleanUpNotionNames(token, entriesDbId);

    // 5. Process deletions (skip on fresh install — no previous sync)
    if (lastSync) {
      await processDeletions(token, 'entry');
    } else {
      // Clear any stale entry deletion records from a previous install —
      // leave 'todo' rows for the todos sync to handle.
      await clearSyncDeletions('entry');
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
  // Pull entries from last 7 days using Date property
  const sevenDaysAgo = toLocalDateString(addDays(new Date(), -7));
  let pages;
  try {
    pages = await queryDatabase(token, dbId, {
      or: [
        { property: 'Date', date: { on_or_after: sevenDaysAgo } },
        { property: 'Date', date: { is_empty: true } },
      ],
    });
  } catch {
    try {
      pages = await queryDatabase(token, dbId, {
        property: 'Date',
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

      // Skip empty entries — pages created in Notion with no content
      const hasContent = entry.text || entry.habits.length > 0 || entry.clips.length > 0;
      const hasLoopdId = getPropertyText(page, 'loopd ID');
      if (!hasContent && !hasLoopdId) {
        debug.push(`Skipped empty page ${page.id}`);
        continue;
      }

      // Check if we already have this entry locally (by loopd ID or notion page ID)
      let existing = await getEntryById(entry.id);
      if (!existing) {
        existing = await getEntryByNotionPageId(page.id);
      }

      if (existing) {
        // Preserve local clip URIs — Notion only stores filenames, not full paths
        const mergedEntry = { ...entry };
        if (existing.clips.length > 0 && mergedEntry.clips.length > 0) {
          const localByName = new Map(
            existing.clips.map(c => [c.uri.split('/').pop(), c.uri])
          );
          mergedEntry.clips = mergedEntry.clips.map(c => {
            const fullPath = localByName.get(c.uri) ?? localByName.get(c.uri.split('/').pop());
            return fullPath ? { ...c, uri: fullPath } : c;
          });
          mergedEntry.clipUri = mergedEntry.clips[0]?.uri ?? existing.clipUri;
          mergedEntry.clipDurationMs = mergedEntry.clips[0]?.durationMs ?? existing.clipDurationMs;
        } else if (existing.clips.length > 0 && mergedEntry.clips.length === 0) {
          // Notion has no clips data — keep local clips
          mergedEntry.clips = existing.clips;
          mergedEntry.clipUri = existing.clipUri;
          mergedEntry.clipDurationMs = existing.clipDurationMs;
        }

        if (existing.date !== entry.date) {
          const hasNotionDateProp = !!getPropertyDate(page, 'Date');
          const notionTime = new Date(page.last_edited_time).getTime();
          const localTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
          if (notionTime > localTime) {
            const useDate = hasNotionDateProp ? entry.date : existing.date;
            await upsertEntryFromNotion({ ...mergedEntry, id: existing.id, date: useDate });
            count++;
          }
        } else {
          // Conflict resolution: last-edit-wins
          const notionTime = new Date(page.last_edited_time).getTime();
          const localTime = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
          if (notionTime > localTime) {
            await upsertEntryFromNotion({ ...mergedEntry, id: existing.id });
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
        console.log('[loopd sync] Updating entry:', entry.id);
        await updatePage(token, entry.notionPageId, properties);
      } else {
        console.log('[loopd sync] Creating entry:', entry.id, 'habits:', entry.habits);
        const page = await createPage(token, dbId, properties);
        await setEntryNotionPageId(entry.id, page.id);
      }
      count++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[loopd sync] Push FAILED for entry', entry.id, 'notionPageId:', entry.notionPageId, 'error:', msg);
      errors.push(`Push: ${msg.slice(0, 100)}`);
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

      // Strip old [Type] and " — Type" suffixes
      let baseName = currentName;
      const oldTags = [/\s*\[(Journal|Clip|Habits)\]\s*$/, /\s*—\s*(Journal|Clip|Habits|video|journal|habit)\s*$/];
      for (const re of oldTags) {
        baseName = baseName.replace(re, '');
      }

      // Build clean name — just content preview, no type tag
      let cleanName: string;
      if (baseName && baseName !== entry.date && !baseName.match(/^\d{4}-\d{2}-\d{2}/)) {
        cleanName = baseName.slice(0, 50) + (baseName.length > 50 ? '...' : '');
      } else {
        const preview = entry.text?.slice(0, 50) ?? '';
        cleanName = preview
          ? `${preview}${preview.length >= 50 ? '...' : ''}`
          : entry.date;
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

async function processDeletions(token: string, entityType: string): Promise<void> {
  const deletions = await getSyncDeletions(entityType);
  for (const del of deletions) {
    try {
      await archivePage(token, del.notionPageId);
    } catch (err) {
      console.warn(`[loopd sync] Delete error (${entityType}) for`, del.notionPageId, err);
    }
  }
  if (deletions.length > 0) {
    await clearSyncDeletions(entityType);
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

// ── Backfill empty Date columns in Notion from local entries ──

async function backfillNotionDates(token: string, dbId: string): Promise<void> {
  try {
    const pages = await queryDatabase(token, dbId);
    for (const page of pages) {
      if (page.archived) continue;

      // Check if Date property is already set
      const existingDate = getPropertyDate(page, 'Date');
      if (existingDate) continue;

      // Find the local entry to get the correct date
      const loopdId = getPropertyText(page, 'loopd ID');
      let entry: Entry | null = null;
      if (loopdId) {
        entry = await getEntryById(loopdId);
      }
      if (!entry) {
        entry = await getEntryByNotionPageId(page.id);
      }

      if (entry) {
        // Use the local date (authoritative)
        await updatePage(token, page.id, {
          'Date': { date: { start: entry.date } },
        });
        console.log(`[loopd sync] Backfilled Date for ${entry.id}: ${entry.date}`);
      }
    }
  } catch (err) {
    console.warn('[loopd sync] Date backfill error:', err);
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

// ═════════════════════════════════════════════════════════════════════════
// Todos sync — one Notion page per individual TodoItem
// ═════════════════════════════════════════════════════════════════════════

export async function syncAllTodos(): Promise<SyncResult> {
  const token = await getNotionToken();
  const todosDbId = await getTodosDbId();
  const result: SyncResult = { pulled: 0, pushed: 0, errors: [], debug: [] };
  if (!token || !todosDbId) return result; // silent no-op when not configured

  const lastSync = await getTodosLastSyncTimestamp();

  // One schema fetch per sync — title column + Phase-D property gap detection.
  // Missing properties are collected so push can skip them and pull can ignore
  // them; the toast surfaces the upgrade prompt to the user.
  let titleColumn = 'Name';
  let missingProperties = new Set<string>();
  try {
    const dbSchema = await getNotionDatabase(token, todosDbId) as { properties: Record<string, unknown> };
    titleColumn = getTitlePropertyKey(dbSchema.properties);
    missingProperties = detectMissingTodoProperties(dbSchema.properties);
    if (missingProperties.size > 0) {
      result.debug.push(`Todos DB missing properties: ${[...missingProperties].join(', ')}`);
    }
  } catch (err) {
    result.debug.push(`Todos DB schema fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const pulled = await pullTodos(token, todosDbId, lastSync, result.debug, missingProperties);
    result.pulled += pulled;

    const pushRes = await pushTodos(token, todosDbId, lastSync, titleColumn, missingProperties);
    result.pushed += pushRes.count;
    result.errors.push(...pushRes.errors);

    if (lastSync) {
      await processDeletions(token, 'todo');
    } else {
      await clearSyncDeletions('todo');
    }

    await setTodosLastSyncTimestamp(new Date().toISOString());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(msg);
    console.error('[loopd todos-sync] Error:', msg);
  }

  console.log('[loopd todos-sync] Result:', result);
  return result;
}

// Walk all entries' todos and return a flat list paired with the source entry
// so we can emit entry-level updates after modifying todos_json.
async function flattenLocalTodos(): Promise<{ entry: Entry; todo: TodoItem; index: number }[]> {
  const entries = await getAllEntries();
  const out: { entry: Entry; todo: TodoItem; index: number }[] = [];
  for (const entry of entries) {
    const todos = entry.todos ?? [];
    for (let i = 0; i < todos.length; i++) {
      out.push({ entry, todo: todos[i], index: i });
    }
  }
  return out;
}

async function pullTodos(
  token: string,
  dbId: string,
  lastSync: string | null,
  debug: string[],
  missingProperties: Set<string>,
): Promise<number> {
  // Pull recent pages (last 14 days by Created At, or all if filter fails)
  const cutoff = toLocalDateString(addDays(new Date(), -14));
  let pages;
  try {
    pages = await queryDatabase(token, dbId, {
      or: [
        { property: 'Created At', date: { on_or_after: cutoff } },
        { property: 'Created At', date: { is_empty: true } },
      ],
    });
  } catch {
    try {
      pages = await queryDatabase(token, dbId);
    } catch (err) {
      debug.push(`todos pull query failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }
  debug.push(`Fetched ${pages.length} todos from Notion`);

  const local = await flattenLocalTodos();
  const byLoopdId = new Map<string, { entry: Entry; todo: TodoItem; index: number }>();
  for (const row of local) byLoopdId.set(row.todo.id, row);

  // Pre-fetch all metas once and key by todoId so the merge step doesn't
  // hit the DB per-row.
  const allMetas = await getAllTodoMetas();
  const metaByTodoId = new Map(allMetas.map(m => [m.todoId, m]));

  // Entries we've mutated this pull — batched to a single updateEntry call
  // per entry at the end to avoid rewriting the same row multiple times.
  const touchedEntries = new Map<string, { todos: TodoItem[]; text?: string | null }>();

  // Pending TodoMeta updates / inserts to apply after the entry writes.
  const metaUpdates: { todoId: string; updates: Partial<TodoMeta> }[] = [];
  const metaInserts: TodoMeta[] = [];

  let count = 0;
  for (const page of pages) {
    if (page.archived) continue;
    try {
      const parsed = notionPageToTodo(page);
      const existing = byLoopdId.get(parsed.loopdId);

      if (existing) {
        // Last-edit-wins on the TodoItem fields: Notion wins only if its
        // last_edited_time is newer than the local row's updatedAt (best
        // proxy via the parent entry's updatedAt).
        const notionTime = new Date(parsed.notionEditedAt).getTime();
        const localProxy = existing.todo.completedAt ?? existing.todo.createdAt ?? existing.entry.updatedAt ?? existing.entry.createdAt;
        const localTime = localProxy ? new Date(localProxy).getTime() : 0;
        const notionWins = notionTime > localTime;

        if (notionWins) {
          // Per spec §11.2: TodoItem.text stays prose-canonical — don't pull
          // down Title edits. We DO pull down done/completedAt/notionPageId.
          const merged: TodoItem = {
            ...existing.todo,
            done: parsed.todo.done,
            completedAt: parsed.todo.completedAt,
            notionPageId: parsed.notionPageId,
          };
          const touch = touchedEntries.get(existing.entry.id) ?? { todos: [...(existing.entry.todos ?? [])] };
          touch.todos[existing.index] = merged;
          touchedEntries.set(existing.entry.id, touch);

          // Reconcile TodoMeta updates only for properties Notion actually
          // had (skipped for missing-property DBs).
          const updates: Partial<TodoMeta> = {};
          const localMeta = metaByTodoId.get(existing.todo.id);
          if (parsed.meta.type && parsed.meta.type !== localMeta?.type) {
            // Type changed in Notion — treat as manual override per spec §11.2
            updates.type = parsed.meta.type;
            updates.userOverriddenType = true;
          }
          if (parsed.meta.expandedMd != null && parsed.meta.expandedMd !== localMeta?.expandedMd) {
            updates.expandedMd = parsed.meta.expandedMd;
            updates.expandedAt = new Date().toISOString();
          }
          if (parsed.meta.model && parsed.meta.model !== localMeta?.model) {
            updates.model = parsed.meta.model;
          }
          if (parsed.meta.confidence && parsed.meta.confidence !== localMeta?.classifierConfidence) {
            updates.classifierConfidence = parsed.meta.confidence;
          }
          if (Object.keys(updates).length > 0) {
            metaUpdates.push({ todoId: existing.todo.id, updates });
          }

          count++;
        }
      } else {
        // New from Notion — append "[]" / "[x]" line to today's most recent
        // entry per spec §11.3 + plan §4. Prose stays canonical: we mint a
        // TodoItem with Notion's loopdId so the next scan text-pairs it
        // back into todos_json on the user's next journal commit.
        const targetDate = parsed.entryDate ?? getTodayString();
        const entriesForDate = await getEntriesByDate(targetDate);
        // Prefer an existing entry on the target date that has text; otherwise
        // create a fresh entry (kept as a small dedicated entry to avoid
        // dumping into a random other entry's prose).
        let target = entriesForDate.find(e => e.text || (e.todos?.length ?? 0) > 0);
        if (!target) {
          target = {
            id: generateId('entry'),
            date: targetDate,
            text: null,
            habits: [],
            todos: [],
            clipUri: null,
            clipDurationMs: null,
            clips: [],
            createdAt: parsed.todo.createdAt ?? new Date().toISOString(),
          };
          await insertEntry(target);
        }

        const newLine = `[${parsed.todo.done ? 'x' : ' '}] ${parsed.todo.text}`;
        const touch = touchedEntries.get(target.id) ?? {
          todos: [...(target.todos ?? [])],
          text: target.text,
        };
        const currentText = touch.text ?? target.text ?? '';
        const nextText = currentText
          ? (currentText.endsWith('\n') ? `${currentText}${newLine}` : `${currentText}\n${newLine}`)
          : newLine;
        touch.text = nextText;
        const sourceLine = nextText.split('\n').length - 1;
        touch.todos.push({
          ...parsed.todo,
          notionPageId: parsed.notionPageId,
          sourceLine,
        });
        touchedEntries.set(target.id, touch);

        // Mint a paired TodoMeta. Notion-originated → user_overridden_type=1
        // per spec §11.3 (sticky against future re-classification).
        const now = new Date().toISOString();
        metaInserts.push({
          todoId: parsed.loopdId,
          entryId: target.id,
          entryDate: target.date,
          type: parsed.meta.type ?? 'todo',
          expandedMd: parsed.meta.expandedMd,
          expandedAt: parsed.meta.expandedMd ? now : null,
          model: parsed.meta.model,
          classifierConfidence: parsed.meta.confidence,
          classifierModel: parsed.meta.model,
          userOverriddenType: true,
          createdAt: parsed.todo.createdAt ?? now,
          updatedAt: now,
        });
        count++;
      }
    } catch (err) {
      debug.push(`todos pull error for ${page.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const [entryId, touch] of touchedEntries) {
    const entry = await getEntryById(entryId);
    if (!entry) continue;
    const next: Entry = {
      ...entry,
      todos: touch.todos,
      text: touch.text !== undefined ? touch.text : entry.text,
    };
    await updateEntry(next);
  }

  for (const meta of metaInserts) {
    try {
      // Guard: a paired meta row may already exist if the entry's earlier
      // commit reconciled it (rare, but the scanner is async).
      const existing = await getTodoMeta(meta.todoId);
      if (!existing) await insertTodoMeta(meta);
    } catch (err) {
      debug.push(`todo_meta insert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const { todoId, updates } of metaUpdates) {
    try {
      await updateTodoMeta(todoId, updates);
    } catch (err) {
      debug.push(`todo_meta update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Quiet the unused-warning for the missingProperties param — it's read in
  // todoToNotionProperties via the push path; the pull path tolerates
  // missing properties at the parser level (notionPageToTodo just returns
  // null for absent keys), so this signature exists for symmetry/future use.
  void missingProperties;

  return count;
}

async function pushTodos(
  token: string,
  dbId: string,
  lastSync: string | null,
  titleColumn: string,
  missingProperties: Set<string>,
): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = [];
  let count = 0;

  // Build the set of properties present on the user's DB so the mapper can
  // skip writes for anything missing — keeps push backwards-compatible.
  const ALL_PHASE_D = ['Type', 'Expanded', 'Model', 'Confidence', 'User Overridden'];
  const baseSchema = new Set([
    titleColumn, 'Done', 'loopd ID', 'Created At', 'Entry Date',
    ...ALL_PHASE_D.filter(p => !missingProperties.has(p)),
  ]);

  const lastSyncMs = lastSync ? new Date(lastSync).getTime() : 0;
  const local = await flattenLocalTodos();

  // Pre-fetch all TodoMeta rows once so the per-row loop joins from a map.
  const allMetas = await getAllTodoMetas();
  const metaByTodoId = new Map(allMetas.map(m => [m.todoId, m]));

  // Group dirty todos by entry. A todo is dirty if it's never been synced,
  // its parent entry was modified after the last sync, OR its meta row
  // was modified after the last sync (so type/expanded edits push too).
  const byEntry = new Map<string, { entry: Entry; todos: TodoItem[]; dirtyIndexes: Set<number> }>();
  for (const { entry, todo, index } of local) {
    const neverSynced = !todo.notionPageId;
    const entryUpdatedMs = entry.updatedAt ? new Date(entry.updatedAt).getTime() : 0;
    const meta = metaByTodoId.get(todo.id);
    const metaUpdatedMs = meta?.updatedAt ? new Date(meta.updatedAt).getTime() : 0;
    const dirty = neverSynced || entryUpdatedMs > lastSyncMs || metaUpdatedMs > lastSyncMs;
    if (!dirty) continue;

    const row = byEntry.get(entry.id) ?? { entry, todos: [...(entry.todos ?? [])], dirtyIndexes: new Set() };
    row.dirtyIndexes.add(index);
    byEntry.set(entry.id, row);
  }

  for (const { entry, todos, dirtyIndexes } of byEntry.values()) {
    let mutated = false;
    for (const index of dirtyIndexes) {
      const todo = todos[index];
      if (!todo) continue;
      try {
        const meta = metaByTodoId.get(todo.id) ?? null;
        const props = todoToNotionProperties(todo, entry, titleColumn, meta, baseSchema);
        if (todo.notionPageId) {
          await updatePage(token, todo.notionPageId, props);
        } else {
          const page = await createPage(token, dbId, props);
          todos[index] = { ...todo, notionPageId: page.id };
          mutated = true;
        }
        count++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[loopd todos-sync] Push failed for todo', todo.id, msg);
        errors.push(`Push: ${msg.slice(0, 100)}`);
      }
    }
    if (mutated) {
      // Persist the newly-assigned notionPageIds back into the entry.
      try {
        const fresh = await getEntryById(entry.id);
        if (fresh) await updateEntry({ ...fresh, todos });
      } catch (err) {
        console.warn('[loopd todos-sync] Failed to persist notionPageIds for entry', entry.id, err);
      }
    }
  }

  return { count, errors };
}
