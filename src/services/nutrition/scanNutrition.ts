import {
  getNutritionByEntry, insertNutrition, updateNutrition, deleteNutrition,
} from '../database';
import { generateId } from '../../utils/id';

// Matches a line starting with "**", then a food name, then a number, then a
// "kcal" unit. Examples:
//   "** oatmeal 320 kcal"
//   "  ** oatmeal with berries 320 kcal"
//   "** large pizza slice 1,200 kcal"
// The name is non-greedy up to the last number-then-kcal pair on the line so
// "5-grain oat 200 kcal" correctly splits as name="5-grain oat", kcal=200.
const NUTRITION_RE = /^\s*\*\*\s+(.+?)\s+(\d+(?:[.,]\d+)?)\s*kcal\b/i;

type ScannedMatch = {
  lineIndex: number;
  name: string;
  kcal: number;
};

function parseLine(line: string): Omit<ScannedMatch, 'lineIndex'> | null {
  const m = NUTRITION_RE.exec(line);
  if (!m) return null;
  const name = (m[1] ?? '').trim();
  const raw = (m[2] ?? '').replace(/,/g, '');
  const kcal = Math.round(parseFloat(raw));
  if (!name || !Number.isFinite(kcal)) return null;
  return { name, kcal };
}

function collectMatches(text: string): ScannedMatch[] {
  const lines = text.split('\n');
  const out: ScannedMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i]);
    if (!parsed) continue;
    out.push({ lineIndex: i, ...parsed });
  }
  return out;
}

// Runs on entry commit. Reconciles the scan result against the nutrition rows
// currently tied to this entry:
//
//   Pass 1 — exact (name, kcal) match (case-insensitive on name). Catches
//   unchanged lines.
//
//   Pass 2 — line-index fallback. Edits in place (changing either name or
//   value on an existing line) reuse the same row via matching source_line.
//
// Unmatched scanned lines become new rows. Unmatched existing rows are deleted
// — unlike todos, every row corresponds to a specific prose line, so if the
// line is gone, the row is gone.
export async function scanNutritionForEntry(
  entryId: string,
  entryDate: string,
  text: string | null | undefined,
): Promise<void> {
  if (!entryId) return;
  const matches = text ? collectMatches(text) : [];
  const existing = await getNutritionByEntry(entryId);

  const claimed = new Map<number, typeof existing[number]>();
  const usedIds = new Set<string>();

  // Pass 1: exact (name, kcal)
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const key = m.name.trim().toLowerCase();
    const prior = existing.find(
      e => !usedIds.has(e.id)
        && e.name.trim().toLowerCase() === key
        && e.kcal === m.kcal,
    );
    if (prior) {
      claimed.set(i, prior);
      usedIds.add(prior.id);
    }
  }

  // Pass 2: line-index
  for (let i = 0; i < matches.length; i++) {
    if (claimed.has(i)) continue;
    const lineIndex = matches[i].lineIndex;
    const prior = existing.find(
      e => !usedIds.has(e.id)
        && typeof e.sourceLine === 'number'
        && e.sourceLine === lineIndex,
    );
    if (prior) {
      claimed.set(i, prior);
      usedIds.add(prior.id);
    }
  }

  // Apply
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const prior = claimed.get(i);
    if (prior) {
      const changed =
        prior.name !== m.name ||
        prior.kcal !== m.kcal ||
        prior.sourceLine !== m.lineIndex;
      if (changed) {
        await updateNutrition(prior.id, {
          name: m.name,
          kcal: m.kcal,
          sourceLine: m.lineIndex,
        });
      }
    } else {
      await insertNutrition({
        id: generateId('nut'),
        name: m.name,
        kcal: m.kcal,
        entryId,
        entryDate,
        sourceLine: m.lineIndex,
        createdAt: new Date().toISOString(),
      });
    }
  }

  // Delete unmatched existing rows
  for (const row of existing) {
    if (usedIds.has(row.id)) continue;
    await deleteNutrition(row.id);
  }
}

// Exposed for the autocomplete UI — quickly parse a single line without
// touching the database.
export function parseNutritionLine(line: string): { name: string; kcal: number } | null {
  return parseLine(line);
}
