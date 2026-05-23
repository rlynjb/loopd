# Refactor — orchestrator silent-sync-error logging

## What to refactor

`src/services/sync/orchestrator.ts` — the `pullAll()` loop (lines 61–82) and the `pushAll()` loop (lines 38–60).

Inside each loop's `for (const table of ordered)` block there's currently a log guard:

```typescript
// pullAll
if (r.applied > 0 || r.fetched > 0) {
  console.log(`[buffr sync] pull ${r.tableName}: ${r.applied} applied, ${r.skipped} skipped (of ${r.fetched})`);
}

// pushAll
if (r.succeeded > 0 || r.failed > 0) {
  console.log(`[buffr sync] push ${r.tableName}: ${r.succeeded} ok, ${r.failed} failed`);
}
```

When `pullTable()` / `pushTable()` returns a result with `error` set but `applied/fetched/succeeded/failed = 0`, neither branch fires and the error is invisible in logcat. The only error path that currently logs is the outer `try/catch` — which catches thrown errors, not returned-error results.

Add an `else if (r.error)` branch on each guard that surfaces the stored error to the console without otherwise touching the loop, the result shape, or the `recordSyncError` write into `sync_meta`.

## Why

On 2026-05-19, migration 0010 moved cloud tables into the `buffr` schema; the activation step (adding `buffr` to "Exposed schemas" in the Supabase dashboard) wasn't done at the same time as the migration. Every sync call started returning PGRST106 "Invalid schema: buffr" — a returned-error result, not a thrown exception. The orchestrator stored those errors in `sync_meta.last_error` but logged nothing. Logcat showed only the unrelated `clipMigration` warnings and the `expo-updates` check failure. Diagnosis took an hour and required a `curl` round-trip from the laptop against the Supabase REST endpoint to see the actual PostgREST error.

The fix-shape is the cheapest possible add of observability: the error already exists on the result object, the storage path is unchanged, and the addition surfaces a failure mode that has bitten the project at least once and would bite again on any future schema/exposure/auth change.

## Target structure

`pullAll()` loop body:

```typescript
for (const table of ordered) {
  try {
    const r = await pullTable(table);
    results.push(r);
    if (r.applied > 0 || r.fetched > 0) {
      console.log(`[buffr sync] pull ${r.tableName}: ${r.applied} applied, ${r.skipped} skipped (of ${r.fetched})`);
    } else if (r.error) {
      console.warn(`[buffr sync] pull ${r.tableName} failed:`, r.error);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[buffr sync] pull ${table.tableName} threw:`, msg);
    results.push({ tableName: table.tableName, fetched: 0, applied: 0, skipped: 0, error: msg });
  }
}
```

`pushAll()` loop body mirrors the change:

```typescript
for (const table of ordered) {
  try {
    const r = await pushTable(table);
    results.push(r);
    if (r.succeeded > 0 || r.failed > 0) {
      console.log(`[buffr sync] push ${r.tableName}: ${r.succeeded} ok, ${r.failed} failed`);
    } else if (r.error) {
      console.warn(`[buffr sync] push ${r.tableName} failed:`, r.error);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[buffr sync] push ${table.tableName} threw:`, msg);
    results.push({ tableName: table.tableName, attempted: 0, succeeded: 0, failed: 0, error: msg });
  }
}
```

Two `else if (r.error)` branches added; nothing removed; nothing reordered. The push branch references `r.error` — verify the field exists on `PushResult` (it does — `recordSyncError` writes it via the existing return shape).

## Must not change

<!-- To be filled in via `/aipe:refactor` before execution. Candidates to enumerate:
     - The result-object shape (PullResult / PushResult) returned from each loop iteration
     - The recordSyncError call site and timing
     - The order in which tables are pulled / pushed
     - The control flow when a result has both error and applied > 0 (currently rare but possible)
     - The existing console.log message format for the success path -->

## Must not introduce

<!-- To be filled in via `/aipe:refactor` before execution. Candidates to enumerate:
     - A retry on returned-error results (that's a behaviour change)
     - An exception re-throw for returned-error results
     - Any new field on PullResult / PushResult
     - Dependency on a logger library (use console.warn, same as the existing catch branches)
     - Logging of successful-but-zero-rows pulls (still suppressed by design) -->
