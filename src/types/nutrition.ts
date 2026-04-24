// One row per `** <name> <kcal> kcal` line in a journal entry.
// Each occurrence is its own row — logging the same food twice on the same
// day produces two rows (intake events, not a single running total).
export type NutritionEntry = {
  id: string;
  name: string;           // food name, case preserved as typed
  kcal: number;
  entryId: string;        // source journal entry
  entryDate: string;      // YYYY-MM-DD, tagged from the source entry
  sourceLine?: number;    // line index in entry.text; used by scanner's two-pass match
  notionPageId?: string | null;
  createdAt: string;      // ISO
  updatedAt?: string | null;
};

// Shape returned by autocomplete queries — one row per distinct food name,
// carrying the most-recent kcal value and a recency timestamp for sorting.
export type NutritionSuggestion = {
  name: string;
  kcal: number;
  lastLoggedAt: string;
};
