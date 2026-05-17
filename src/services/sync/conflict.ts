// Last-write-wins conflict resolution by `updated_at` per
// docs/buffr-cloud-sync-spec.md §4.6. Pure function — easily testable.
//
// The honest cases this resolves cleanly:
//   - Two devices edit same row → newer updated_at wins.
//   - Soft delete + concurrent edit → newer wins (delete may be undone, or
//     edit may be lost — whichever was later).
//
// Unresolved cases (acceptable for solo use; Phase B may need vector clocks):
//   - Same-second ties go to whichever the comparator's tie-break favors
//     (default: cloud, as a slight bias toward "the server saw it last").

export type Tombstoned = { updated_at: string; deleted_at?: string | null };

/**
 * Returns 'local', 'cloud', or 'tie'. The orchestrator decides what to do
 * with each — for incremental pull, ties go to cloud (no work); for push,
 * ties go to local (we're already in the push code path).
 */
export function chooseWinner<T extends Tombstoned>(local: T, cloud: T): 'local' | 'cloud' | 'tie' {
  const lt = Date.parse(local.updated_at);
  const ct = Date.parse(cloud.updated_at);
  if (Number.isNaN(lt) || Number.isNaN(ct)) {
    // Defensive: malformed timestamps. Prefer cloud — it just came down a
    // freshly-validated wire.
    return 'cloud';
  }
  if (lt > ct) return 'local';
  if (ct > lt) return 'cloud';
  return 'tie';
}
