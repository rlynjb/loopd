# Clocks, coordination, and leadership — buffr's one good clock decision
## Industry name(s): server time, NTP skew, leases, leader election · Type: Foundational

> Buffr uses `Date.now()` on the device for `updated_at` (write ordering on the device) and a server-time RPC for `synced_at` (durable ordering in the cloud). The split is the right design — device clock can be wrong, server clock can be trusted.

## Zoom out, then zoom in

```
  TWO CLOCKS, TWO USES

  device Date.now():
   ─ used for updated_at (intra-device write ordering)
   ─ wrong by hours? still correct AS A LOCAL ORDER
   ─ writes on the same device monotonically advance updated_at
   ─ across devices: source of LWW conflict resolution

  server time (via Supabase RPC):
   ─ used for synced_at (durable timestamp on cloud)
   ─ source of truth for "when did cloud see this row"
   ─ cross-device cursor advancement uses synced_at
```

Zoom in: the load-bearing choice is "what time goes into the row when the cloud accepts it?" If the device sets `synced_at = Date.now()`, two devices with skewed clocks would have inconsistent ordering for the same row. Server time fixes this.

## Structure pass

```
  layers   ─ device clock ─ server clock ─ row timestamp
  axes     ─ source of time
             ─ purpose of timestamp
  seams    ─ updated_at ←→ device time   : local ordering
             ─ synced_at ←→ server time  : durable ordering
```

## How it works

### Move 1 — device clocks lie

```
  Date.now() on a phone whose user set the year to 2099 will
  return year-2099 timestamps. without correction, this would
  poison every LWW conflict — year-2099 always wins.
```

### Move 2 — server time anchors the durable timestamp

```
  pushTable does:
    SELECT NOW() FROM ... (or similar RPC)
    UPDATE local row SET synced_at = server_now
  
  the server's clock is authoritative for "cloud accepted this at T."
```

### Move 3 — no leadership needed

```
   ┌──────────────────────────────────────────────────┐
   │ buffr's coordination is hub-and-spoke through    │
   │ Supabase. there's no in-app leader to elect.     │
   │ no Raft. no ZooKeeper. the cloud is the leader   │
   │ by construction.                                 │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

```ts
// pattern; src/services/sync/server-time.ts
async function getServerTime(): Promise<number> {
  const { data } = await supabase.rpc('now_ms');
  return data;
}

// during sync push, server_time is the timestamp written to synced_at
const serverTime = await getServerTime();
for (const table of tables) {
  // push, then on success:
  //   UPDATE local SET synced_at = serverTime WHERE id IN (...);
}
```

If the RPC doesn't exist, buffr falls back to `Date.now()`. The fallback is what introduces the device-clock-skew risk; the RPC exists for a reason. Verify the RPC is configured server-side (Supabase function `now_ms` or equivalent).

## Elaborate

The "split-clock" pattern is the standard answer for any device-cloud system. iOS and Android also expose this via Apple/Google time services; cellular carriers anchor it via NTP. The choice of server-RPC vs platform-time is mostly about code locality — buffr uses Supabase RPC because the sync engine already talks to Supabase; no new dependency.

Leadership and leases come up when multiple workers need to coordinate. Buffr has one worker per device, period. No leadership.

## Interview defense

**Q [mid]:** Where does buffr get the time it stamps on synced rows?

**A:** Server-side RPC. The local device's clock is not trusted for cross-device ordering. The RPC adds ~50ms per sync cycle but eliminates a whole class of clock-skew bugs.

**Q [senior]:** When have you debugged a clock issue?

**A:** Not on buffr — the design pre-empted it. The classic case is a phone with a wrong-decade clock setting causing LWW to always win for that phone's writes, even when the user intended otherwise.

## Validate

### Level 1 — name the two clocks and what each is used for.

### Level 2 — explain why device clocks can't be trusted across devices.

### Level 3 — apply: a feature wants "scheduled tasks" (run at 8am). Device clock or server clock? Both — schedule by user-local time, but verify against server time before executing.

### Level 4 — defend: "Just use the device clock everywhere." Wrong; opens up the year-2099 LWW bug.

## See also

- `04-consistency-models-and-staleness.md` — LWW depends on these timestamps.
- `../study-database-systems/08-replication-and-read-consistency.md` — cursor advance uses these.
- `../study-system-design/02-debounced-batched-sync.md` — when the RPC fires.
