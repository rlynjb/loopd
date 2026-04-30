import type { Thread, Staleness } from '../../types/thread';

// Pure staleness computation. Hybrid model per spec § 7.4:
//   - If thread has a target_cadence_days, measure against it (1× = fresh,
//     2× = aging, 4× = stale, beyond = cold).
//   - Otherwise default thresholds: 1d / 3d / 7d / cold (plan decision #1).
//   - Never-mentioned threads are 'cold'.
export function computeStaleness(
  thread: Pick<Thread, 'targetCadenceDays'>,
  lastMentionAt: string | null,
  nowDate: Date = new Date(),
): Staleness {
  if (!lastMentionAt) return 'cold';
  const last = new Date(lastMentionAt);
  const days = differenceInDays(nowDate, last);
  const target = thread.targetCadenceDays;

  if (target && target > 0) {
    if (days <= target) return 'fresh';
    if (days <= target * 2) return 'aging';
    if (days <= target * 4) return 'stale';
    return 'cold';
  }
  if (days <= 1) return 'fresh';
  if (days <= 3) return 'aging';
  if (days <= 7) return 'stale';
  return 'cold';
}

// Whole-day-difference, rounded down. Both inputs are interpreted in local
// time so a mention at 11pm yesterday reads as "1 day ago" today.
export function differenceInDays(later: Date, earlier: Date): number {
  const ms = later.getTime() - earlier.getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

// Human label for the card. "touched today" / "2d ago" / etc.
export function formatStalenessLabel(
  staleness: Staleness,
  daysSinceLast: number | null,
): string {
  if (daysSinceLast == null) return 'never mentioned';
  if (daysSinceLast === 0) return 'touched today';
  if (daysSinceLast === 1) return '1d ago';
  const suffix =
    staleness === 'stale' ? ' — STALE' :
    staleness === 'cold' ? ' — COLD' : '';
  return `${daysSinceLast}d ago${suffix}`;
}
