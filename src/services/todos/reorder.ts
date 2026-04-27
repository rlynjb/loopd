import { getAllTodoMetas, updateTodoMeta } from '../database';

// User-set ordering for /todos. Strategy:
//
// - Position is NULL by default; sort falls back to createdAt DESC.
// - On the first reorder action ever, ensureAllTodoPositions() walks the
//   user's current visual order and assigns dense integers to every meta
//   row. From then on, sort is by position ASC.
// - moveTodo swaps positions of two adjacent rows in the *currently
//   visible* (filtered) list. Hidden rows keep their existing positions
//   and don't shift, so the user reorders within their current view.
//
// New todos captured later get position=NULL again; sort tiebreak puts
// them ahead of the user-positioned block (NULLS FIRST equivalent in
// JS-side sorting) so fresh captures don't get lost behind a long
// pre-ordered list.

// Idempotently rebases every meta row to a dense integer based on the
// caller-provided visual order. Returns immediately if every row already
// has a position assigned.
export async function ensureAllTodoPositions(
  visualOrder: { id: string; meta: { position: number | null } }[],
): Promise<void> {
  const allMetas = await getAllTodoMetas();
  const allHavePositions = allMetas.every(m => m.position != null);
  if (allHavePositions) return;

  // Use the visual order as the seed. Anything in allMetas not in
  // visualOrder gets appended at the end (e.g. rows the user has filtered
  // out keep relative order based on whatever fallback sort they had).
  const seenIds = new Set(visualOrder.map(r => r.id));
  const tail = allMetas
    .filter(m => !seenIds.has(m.todoId))
    .sort((a, b) => {
      // Stable order for hidden rows: existing positions first, then
      // createdAt DESC for unpositioned rows. Mirrors the page's sort.
      const ap = a.position;
      const bp = b.position;
      if (ap != null && bp != null) return ap - bp;
      if (ap != null) return -1;
      if (bp != null) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  let i = 0;
  for (const r of visualOrder) {
    await updateTodoMeta(r.id, { position: i++ });
  }
  for (const m of tail) {
    await updateTodoMeta(m.todoId, { position: i++ });
  }
}

// Swap positions of two rows. Caller is responsible for picking the
// neighbor — typically the row immediately above/below in the filtered
// view. After the swap, ensureAllTodoPositions has already guaranteed
// both rows have integer positions.
export async function swapTodoPositions(
  a: { id: string; meta: { position: number | null } },
  b: { id: string; meta: { position: number | null } },
): Promise<void> {
  const aPos = a.meta.position;
  const bPos = b.meta.position;
  if (aPos == null || bPos == null) return;
  await updateTodoMeta(a.id, { position: bPos });
  await updateTodoMeta(b.id, { position: aPos });
}
