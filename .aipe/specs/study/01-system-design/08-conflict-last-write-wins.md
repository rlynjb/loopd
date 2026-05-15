# Conflict resolution: last-write-wins

**Industry name(s):** Last-write-wins (LWW), Lamport-style conflict resolution
**Type:** Industry standard · Language-agnostic

> Pure function in `sync/conflict.ts`. Compares `updated_at` timestamps; whichever side is newer wins. Same-second ties go to cloud.

**See also:** → [07-cloud-sync-mirror](./07-cloud-sync-mirror.md) · → [05-soft-delete](./05-soft-delete.md)

---

## Why care

You've got a `posts` table with `id` and `title` columns plus a `last_updated TIMESTAMP` column on every row. Client A fires `UPDATE posts SET title = 'Hello', last_updated = now() WHERE id = 123` at 14:32; client B fires `UPDATE posts SET title = 'Hi', last_updated = now() WHERE id = 123` at 14:35. Postgres MVCC has each transaction see its own snapshot, and whichever commit lands later overwrites the earlier one — the table's value at quiescence is whichever update had the higher `last_updated`. There's no merge of `'Hello'` and `'Hi'` into something both writers might want; the database picks one row's value and the other disappears. Firebase Realtime Database and CouchDB ship the same rule by default at network scale: timestamp the writes, take the bigger one, drop the loser silently.

The question those concurrent edits answer is one any replicated store has to answer: when two writes claim the same row and neither side knows the other exists, who wins? Not "merge them" — that requires understanding what merging *means* for the data type, which is expensive. Not "ask the user" — that requires UI that doesn't exist on a background sync. The answer is *last-write-wins*: attach a timestamp to every row, compare on conflict, keep the bigger one.

**What depends on getting this right:** whether the sync layer can resolve a conflict without human intervention, and whether the resolution is the same on every device every time it runs. In this codebase the resolver lives in `src/services/sync/conflict.ts` as `chooseWinner(local, cloud)`. It's a pure function — no DB reads, no `Date.now()`, no side effects — that returns `"local"`, `"cloud"`, or `"tie-cloud-wins"`. The comparison is ISO 8601 string compare (`"2026-05-10T14:32:18.000Z" > "2026-05-10T14:30:00.000Z"`), which is lexicographically sortable and avoids Date.parse cost. Same-second ties go to cloud (biased to converge — prevents ping-pong between two devices that already agree). Malformed timestamps also go to cloud (defensive healing — a corrupt local row gets overwritten by the well-formed cloud copy).

Without LWW (sync errors on conflict):
- Device A writes `entries.text = "long version"` at 14:32 on the plane
- Device B writes `entries.text = "short version"` at 14:35 in a cafe
- Both reconnect; both push; Supabase has one of them (server-side LWW on upsert)
- Pull on A: the resolver sees a conflict and refuses to act
- The sync layer needs UI; there is no UI; the row stays unresolved forever

With LWW via `chooseWinner`:
- Same setup; both push; Supabase ends up with B's row (later timestamp)
- A's next pull: cloud has `updated_at = 14:35`, local has `14:32`; `chooseWinner` returns `"cloud"`
- A overwrites local with cloud; the cluster has converged
- Cost: A's "long version" edits are silently lost; the tradeoff was named at design time

The resolver is a referee that always blows the whistle the same way.

---

## How it works

Postgres MVCC + a `last_updated` timestamp is the canonical pattern. Two writes to the same row race; the row keeps the value of whichever write the server timestamped later. No negotiation, no merging, no "device A keeps half of the field and device B keeps the other half" — just pick the more recent timestamp. It's a brutal rule on purpose — fast, deterministic, easy to reason about. The cost is that one writer's value silently disappears every time there's a conflict; the win is that you never get stuck in a stalemate and replay always converges. CouchDB and Firebase Realtime Database both ship LWW as their default conflict resolver for the same reason.

The resolver in one picture:

```
   local row                             cloud row
   updated_at = "...14:32:18.000Z"       updated_at = "...14:35:00.000Z"
              │                                       │
              └─────────────────┬─────────────────────┘
                                ▼
                  chooseWinner(local, cloud)
                                │
                                ▼  ISO 8601 string compare
                                │
                ┌───────────────┴───────────────┐
                ▼                               ▼
         cloud > local                    local > cloud
         → "cloud" (apply pull)           → "local" (skip;
                                              push handles it)
                tie or malformed
                → "tie-cloud-wins"
                (defensive convergence)
```

A pure function from two rows to a label — the four sub-sections below trace the purity contract, the ISO-string compare, the same-second tie rule, and the malformed-timestamp healing path.

### `chooseWinner` is pure — input rows in, label out

`chooseWinner(local, cloud)` in `src/services/sync/conflict.ts` takes two rows and returns a string: `"local"`, `"cloud"`, or `"tie-cloud-wins"`. No side effects, no DB reads, no `Date.now()` call inside. The caller (`pull.ts`) is responsible for acting on the result. If you're coming from frontend, this is the same shape as a Redux reducer or a pure React selector: take the state, return the projection, don't reach for any external resource. Concrete consequence: every call to `chooseWinner(rowA, rowB)` with the same two rows returns the same answer forever — there's no race, no timestamp drift, no "this passed yesterday but fails today." Boundary: the purity only holds because the inputs are already typed (`updated_at` is an ISO string on the row). A malformed timestamp would make the parse return NaN, which the function handles explicitly.

The pure-function signature in one shape:

```
   inputs                             chooseWinner                  output
   ┌───────────────────────────┐      (pure function;             ┌──────────────────┐
   │ local: SyncableRow         │      no side effects,           │ "local"          │
   │   { updated_at, ... }      │ ──▶  no DB reads,         ──▶   │   or "cloud"     │
   │ cloud: SyncableRow         │      no Date.now(),             │   or             │
   │   { updated_at, ... }      │      no I/O)                    │ "tie-cloud-wins" │
   └───────────────────────────┘                                  └──────────────────┘

   caller in pull.ts acts on the label:
     "local"            → skip (push handles it later)
     "cloud"            → upsert locally, stamp synced_at = serverTime
     "tie-cloud-wins"   → upsert locally (convergence bias)
```

Testing is one-line — `expect(chooseWinner(rowA, rowB)).toBe('cloud')` — because the function never reaches outside its arguments.

### The comparison rule — ISO string compare, not Date math

`chooseWinner` compares `local.updated_at` and `cloud.updated_at` as ISO 8601 strings using string ordering. ISO 8601 (e.g. `"2026-05-10T14:32:18.000Z"`) is lexicographically sortable — string `>` produces the same result as `Date.parse(...) >`, but without the parse cost and without timezone footguns. If you're coming from frontend, this is the same trick `localStorage`-keyed records use when they want to sort by timestamp without parsing — the ISO string IS the sortable key. Concrete consequence: if local has `updated_at = "2026-05-10T14:32:18.000Z"` and cloud has `"2026-05-10T14:33:00.000Z"`, the string compare returns cloud > local → cloud wins. If cloud has the same string, the tie rule applies. Boundary: this assumes both sides write ISO strings; a future migration that changes the column format would break the comparator.

The compare itself — annotated to show why string ordering works:

```
   local.updated_at  = "2026-05-10T14:32:18.000Z"
   cloud.updated_at  = "2026-05-10T14:33:00.000Z"
                          │           │
                          │           └── seconds differ → '3' > '2'
                          └── prefix identical up to here

   string compare:   cloud.updated_at > local.updated_at   // true

      same result as:  Date.parse(cloud.updated_at) > Date.parse(local.updated_at)
                                    │
                                    └── but Date.parse adds a parse step
                                        and timezone-handling edge cases

   ISO 8601 is lexicographically sortable by design — that's the trick.
```

The whole compare is one `>` operator with no allocations, no exceptions, no Intl machinery.

### Same-second tie → cloud wins (biased to converge)

If `local.updated_at == cloud.updated_at` (same millisecond, identical strings), `chooseWinner` returns `"tie-cloud-wins"`. The bias toward cloud is deliberate: the path that calls `chooseWinner` is pull, and if cloud has a row with the same timestamp as local's, the cloud row probably arrived from a different device that's already converged on that value. Letting cloud win prevents an infinite ping-pong where two devices keep pulling the same row, each thinking their copy is fresher. Concrete consequence: device A writes `name='loopd'` at 14:32:18.000Z. Device B independently writes `name='loopd-app'` at exactly 14:32:18.000Z. Both push. Cloud now has one of them (last-write-wins on the server side via the upsert). On the next pull from device A, cloud's value comes back and the tie rule applies — cloud wins, A's local copy gets overwritten. The bias converges the cluster. Boundary: if two clocks are perfectly skewed and produce identical timestamps for genuinely different edits, the tie rule silently picks one. The fix is millisecond-grained timestamps and operational acceptance that ties are rare.

Walking the ping-pong-that-doesn't-happen on a two-device tie:

```
   device A writes                  device B writes
   "name=loopd"                     "name=loopd-app"
   updated_at = "...18.000Z"        updated_at = "...18.000Z"   (same ms!)
              │                                │
              ▼                                ▼
   both push to cloud
              │  Supabase server-side LWW picks one (say B's)
              ▼
   cloud has: name="loopd-app", updated_at = "...18.000Z"
              │
              ▼  next pull from device A
              │  chooseWinner(local_18, cloud_18) — strings equal
              ▼
   returns "tie-cloud-wins"
              │
              ▼  pull overwrites A's local with cloud value
              ▼
   both devices now have name="loopd-app"; cluster converged
   no ping-pong (without the bias, both would think they're fresher)
```

The bias is a one-line defensive choice that buys eventual convergence on every tie.

### Malformed timestamp → cloud wins (defensive healing)

If `Date.parse(local.updated_at)` returns NaN (or `cloud.updated_at` does), `chooseWinner` returns `"cloud"`. The reason: a malformed timestamp on local probably means the local DB has a corrupt row (manual edit, migration bug, JSON parse glitch); overwriting it with the cloud version is the desired healing direction. If you've ever shipped a feature that started writing dates as Unix timestamps instead of ISO strings and then had to recover, you know how valuable this is — the pull path heals the corruption automatically. Concrete consequence: a user opens the app after a bad migration that wrote `updated_at = "ABCDEF"` to several rows. Next pull: `chooseWinner("ABCDEF", "2026-05-10T14:32:18.000Z")` parses local to NaN, returns `"cloud"`. The corrupt local row gets overwritten with the cloud's well-formed version. The user never sees the bug. Boundary: this only heals one direction — corrupt rows on the cloud are dragged into local. The reverse is a real problem; the codebase trusts cloud writes to be well-formed because they go through the typed Supabase SDK.

Walking the healing path:

```
   local.updated_at = "ABCDEF"     (corrupt — manual edit, bad migration)
   cloud.updated_at = "2026-05-10T14:32:18.000Z"
                                     │
                                     ▼  Date.parse(local) === NaN  detected
                                     │
                                     ▼
                       chooseWinner returns "cloud"
                                     │
                                     ▼  pull upserts cloud value to local
                                     ▼
                       local row's updated_at now valid
                       user never sees the corruption
                       healing direction: cloud → local only
                       (cloud writes are trusted to be well-formed
                        because they go through the typed Supabase SDK)
```

A single defensive branch buys automatic recovery from a whole class of "we accidentally wrote junk to the local store" bugs.

This is what people mean by "convergent merge under a total order." Last-write-wins is the simplest converging algorithm — it's not the *best* in every dimension (you lose the loser's edits), but it's the cheapest one that always terminates and always produces an identical result on every replica. Every distributed system that has ever shipped under a "good-enough" merge has done some version of this: DNS records, CRDT LWW-Registers, Riak's last-write-wins bucket type, Dropbox's "keep one, mark the other as conflict." The boundary case — true concurrent edits that need to merge content — is where CRDTs and operational transforms become load-bearing. Until then, the timestamp wins. The full picture is below.

---

## Conflict — diagram

```
  local.updated_at vs cloud.updated_at:

  ┌────────────────────────────┬───────────────────┐
  │ Comparison                 │ Winner            │
  ├────────────────────────────┼───────────────────┤
  │ local > cloud              │ local (skip pull) │
  │ cloud > local              │ cloud (apply)     │
  │ local == cloud             │ tie → cloud       │
  │ malformed timestamp        │ cloud (defensive) │
  └────────────────────────────┴───────────────────┘
```

---

## In this codebase

**File:** `src/services/sync/conflict.ts`
**Function / class:** `chooseWinner<T extends Tombstoned>(local, cloud)` — pure, no side effects
**Line range:** L20–L31 (the whole file is 31 lines; `Tombstoned` type at L13)

**Caller:** `src/services/sync/pull.ts` → `pullTable()` L34–L117 invokes `chooseWinner` per row to decide whether to upsert the cloud row over local.

---

## Elaborate

### Where this pattern comes from
LWW is the simplest conflict resolution rule in distributed systems. It's what Cassandra defaults to, what Riak ships out of the box, what DynamoDB uses for last-modified-by-time semantics. Its appeal is operational simplicity: no tombstones, no vectors, no metadata bloat.

### The deeper principle
**Pick the simplest rule that solves your real conflict surface, not the imagined one.** Loopd's only conflict surface is the same person on two devices. Vector clocks and CRDTs would add complexity for a problem the app doesn't have.

### Where this breaks down
- Two humans editing the same row at once. LWW silently drops one user's work.
- Distributed clock skew larger than the typical edit gap. The "newer" timestamp may not be the chronologically newer write.
- Operations that aren't last-write-style — e.g., counters, sets, where merge semantics matter. LWW would lose one increment in two.

### What to explore next
- CRDTs (LWW-Set, OR-Set, RGA) → for the case where merging matters.
- Vector clocks → for ordering events without trusting wall-clock time.

---

## Tradeoffs

We traded conflict-aware merging for operational simplicity: every conflict is decided by one integer comparison, and the cost is that a true concurrent edit silently loses one writer's work.

### Comparison table — both costs in one frame

```
┌──────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Path taken (LWW)             │ Alternative (CRDT / vectors) │
├──────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Code surface     │ 31 LOC (conflict.ts)         │ +version_vector JSON column  │
│                  │                              │ on every synced table +      │
│                  │                              │ per-table mergers (~5–10     │
│                  │                              │ new files, ~500 LOC)         │
│ Resolution speed │ one timestamp comparison/row │ vector domination check +    │
│                  │ — microseconds               │ possibly call merger         │
│ Multi-writer     │ silent loss — older write    │ both writes preserved /      │
│ correctness      │ vanishes, no log/warning     │ merged per type semantics    │
│ Testability      │ pure function, no I/O,       │ merger may need state,       │
│                  │ trivial table tests          │ harder to unit test          │
│ Migration cost   │ N/A (already shipped)        │ ~2 weeks: schema + backfill  │
│                  │                              │ + bootstrap re-keying        │
│ Debuggability    │ "newer timestamp won" —      │ "vectors A=[1,3], B=[2,2]    │
│                  │ readable in 5 seconds        │ are concurrent" — needs a    │
│                  │                              │ mental model and a tool      │
│ Fits user model  │ solo user, sequential        │ multi-user or true concurrent│
│                  │ devices                      │ devices                      │
└──────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### What we gave up

The whole row is the unit of resolution; field-level merging is impossible. If a user edits entry text on phone A and adds a habit-check on phone B in the same window, LWW picks one row's entirety — both edits should logically coexist, but one is dropped. Solo journaling rarely produces this scenario, but it is the design's blind spot.

Same-second ties always go to cloud. In practice this is a termination rule (prevents the pull path from oscillating), not a fairness rule — but it does mean that on rare clock-aligned writes, a cloud row equal-timestamp-but-different-bytes overwrites local. The window is millisecond-narrow and the rows are usually byte-identical (it's the same row I just pushed), so the user observes nothing.

The function is pure — no side-effects, no DB reads. That makes it trivially testable but blocks using richer signals at resolution time: we can't consult `pinned`, can't consult per-field freshness, can't inspect `user_overridden_type`. Anything beyond "compare two timestamps" requires rewriting the function and threading more state through `pullTable`.

### What the alternative would have cost

A vector-clock or CRDT migration adds a `version_vector` JSON column to every synced table, populates it on every write, teaches `chooseWinner` a third `'merge'` path, and adds per-table mergers (likely one file per table with non-trivial fields — entries, todo_meta, ai_summaries are the big three). That's ~500 LOC of new code, ~5–10 new files, plus a Supabase migration that backfills vectors on every existing row.

The hidden cost is bootstrap. The first pull's cursor would have to re-key from `updated_at` to a vector-aware shape, which means the firstPull code path (which is already the hairiest in the sync layer) gets a second special case. We'd also lose the ability to debug "which row won" by reading two timestamps — instead a contributor has to reason about vector domination, which needs a mental model that takes time to build.

In return: real concurrent edits compose. Two writers on the same row produce a merge call instead of a silent loss. For a single-user app today, that's a feature with no consumer.

### The breakpoint

Fine until a second human edits a row, or until true concurrent device usage becomes common (e.g., the user routinely has phone and tablet open at the same time, editing the same entry within seconds of each other). LWW silently picks one — at that point silence is the bug, and migrating to vector clocks plus per-field merge becomes a real two-week project. RLS-enabled Phase B is the natural trigger: the moment "another user" is a real concept, this assumption needs to be re-examined.

### What wasn't actually a tradeoff

Per-row "merge whole rows by concatenation" wasn't on the table. The prose field is a string — concatenating two divergent versions produces nonsense. Any real merge needs field-level semantics (text uses CRDT, integers use add/max, booleans use OR), which is the CRDT migration above. There's no halfway version.

---

## Tech reference (industry pairing)

### @supabase/supabase-js + Supabase Postgres

- **Codebase uses:** Supabase Postgres as the cloud side of the conflict; `chooseWinner` determines whether `pullTable` upserts the cloud row over local, with same-second ties going to cloud to prevent ping-pong in the pull path.
- **Why it's here:** the "tie → cloud" rule and the "malformed → cloud heals" rule both depend on Supabase being the authoritative well-formed copy; the file frames LWW as a deliberate choice against the complexity of CRDT-aware Supabase schema changes.
- **Leading today:** Supabase — `adoption-leading` for Postgres-as-a-service, 2026.
- **Why it leads:** managed Postgres + auth + RLS + Storage in one console; SDK mirrors PostgREST; the same upsert path that carries edits also carries conflict resolution without a separate protocol.
- **Runner-up:** Neon + Drizzle — `innovation-leading` typed SQL with branch-per-PR; Convex is the reactive-first alternative.

---

## Summary

Last-write-wins is the simplest conflict resolution rule: attach a timestamp to every row, and on a conflict keep the row with the bigger timestamp — it sits at the cheap end of a spectrum that runs through vector clocks up to CRDTs and operational transforms. In this codebase `chooseWinner<T extends Tombstoned>(local, cloud)` in `src/services/sync/conflict.ts` (L20–L31) is a pure function that compares `updated_at` and returns `'local' | 'cloud'`, with same-second ties going to cloud (to prevent pull-path ping-pong) and malformed timestamps defaulting to cloud (to heal locally-corrupt rows); `pullTable` invokes it per row to decide whether to upsert. The constraint was solo Phase A — two devices means the same user, sequential intent, where "we kept the most recent one" is an acceptable answer. The cost is silent loss in true concurrent multi-writer cases — LWW picks the newer `updated_at` and the older write is just gone, with no log, merge, or warning, and the pure-function design means field-level merging isn't possible (the whole row is the unit). The migration to vector clocks plus per-field merge would add a `version_vector` JSON column on every synced table and teach `chooseWinner` a third `'merge'` path — roughly two weeks of work, deferred until the conflict surface actually changes.

Key points to remember:
- `chooseWinner` is a pure function returning `'local' | 'cloud'`; ties go to cloud as a termination rule, not a fairness rule.
- LWW is the right complexity for the actual conflict surface (one user, sequential devices); it becomes wrong when two humans share a workspace.
- Lives in step 5 (Failure handling) of the system-design checklist.
- Malformed timestamps default to cloud so locally-corrupt rows heal toward the well-formed cloud version.
- The cost is silent loss in concurrent multi-writer cases — no log, no merge, no warning; the migration target is vector clocks plus per-field merge.

---

## Interview defense

### What an interviewer is really asking
LWW is the boring answer to a much-too-interesting topic. The interviewer wants to know whether you understand that LWW *silently* loses data and whether your usage actually fits — because most engineers say "we use last-write-wins" and then describe an app that doesn't.

### Likely questions

[mid] Q: A row has `local.updated_at == cloud.updated_at` to the millisecond. What does `chooseWinner` return and why?

A: It returns `'cloud'`. The same-millisecond tie biases toward cloud because the caller is the pull path — if cloud has a row at the same timestamp as local, that row arrived from cloud after this device's last pull, and pulling resolves the bounce. Letting local win on a tie would mean the next pull comes back, sees the same tie, and ping-pongs forever. The rule is documented in `conflict.ts` and is the reason the function returns a string instead of a boolean — to make the tie path explicit.

```
[chooseWinner decision]

  inputs:  local.updated_at, cloud.updated_at
        │
        ▼
  compare timestamps
        │
        ├── local > cloud  → return 'local'  (skip pull)
        ├── cloud > local  → return 'cloud'  (apply pull)
        ├── local == cloud → return 'cloud'  (tie; prevents ping-pong)
        └── malformed      → return 'cloud'  (defensive heal)
```

[senior] Q: When does LWW silently destroy data, and have you accepted that?

A: When two writers edit the same row in the same window with different values. LWW picks the newer `updated_at` and the older write is just gone — there's no log, no merge, no warning. I've accepted that for Phase A because the only multi-writer scenario is "the user on phone, then the user on tablet" — same person, sequential intent, the loss is "the older edit was already obsolete to me anyway." The day there's a second human or true concurrent device usage, LWW becomes wrong; the migration is to per-field merge or operational transforms on the prose field specifically (where the loss would actually hurt). Until then, LWW is the right complexity for the problem.

```
                  Path taken (LWW, Phase A solo)        Alternative (CRDT today)
                  ──────────────────────────────        ──────────────────────────────
conflict surface  one user, sequential devices          would also support 2 humans
code surface      31 LOC pure function                  +500 LOC, 5–10 new files
data loss when    truly concurrent edits to same row    none — both edits compose
                  (rare in solo journaling)
detectability     silent — no log, no warning           merge call is observable
testability       trivial table tests                   need divergent-state fixtures
migration cost    none — already shipped                ~2 weeks (schema + backfill +
                                                          bootstrap re-keying)
right today?      yes — fits real surface               no — premature, no real consumer
right at Phase B? no — RLS + multi-user is the trigger  yes — the moment 2 humans exist
```

[arch] Q: How would you migrate this to vector clocks or CRDTs without rewriting the whole sync layer?

A: I'd start by adding a `version_vector` JSON column on each synced table, populated alongside `updated_at` on every write. `chooseWinner` would learn a third path: if version vectors are concurrent (neither dominates), return `'merge'` and call a per-table merger; if one dominates, return that side. The push and pull cursors would still use `updated_at`; the conflict resolution would consult the vector. Per-table mergers handle the divergent fields. The migration risk is the backfill — every existing row needs a vector, and the bootstrap pull must re-key the cursor. It's two weeks of work to do right, which is why I haven't done it for a hypothetical use case.

```
At Phase B (RLS-on, multi-user collaborative):

  ┌─ UI layer ──────────────────────────────────┐
  │ unchanged — reads from local SQLite          │
  └─────────────────────────────────────────────┘
              │
  ┌─ Push/Pull cursors (updated_at) ────────────┐
  │ unchanged — vectors don't replace timestamps│
  │ they augment them                            │
  └─────────────────────────────────────────────┘
              │
  ┌─ chooseWinner ──────────────────────────────┐
  │ learns 'merge' path                          │  ◀── BREAKS FIRST
  │ vector domination check + per-table merger  │     (pure function becomes impure;
  │ +5–10 new merger files                       │      32 LOC grows to ~200; bootstrap
  └─────────────────────────────────────────────┘     pull must re-key cursor shape)
              │
  ┌─ Schema (every synced table) ───────────────┐
  │ +version_vector JSON column on each table   │
  │ migration backfills vectors on every row    │
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: Your same-second tie rule says cloud wins. Walk me through the edge case where the user types on the device, the row is pushed, and then a network blip causes pull to fire on the same second. Doesn't local lose its own write?

A: Almost. After the push succeeds, the local row has `updated_at = T` and `synced_at = T'` (where T' is server time, slightly later). The cloud row has `updated_at = T`. On the immediate pull, `chooseWinner` sees `local.updated_at == cloud.updated_at` and returns `'cloud'`. Then pull upserts the cloud row over local. The values are byte-identical (it's the same row I just pushed) so the user notices nothing — but the local `synced_at` stays correct because the upsert path stamps it again. The case where this would actually hurt is if my local row had a *newer* `updated_at` than what cloud received (because my push was racy and stamped after the cloud's accept timestamp), but my code path stamps `updated_at` before push specifically to avoid that. The risk is real but bounded; if I observed it in the wild I'd add a strict `>` instead of `>=` in `chooseWinner` and accept the rare miss.

```
                  Path taken (tie → cloud)              Suggested (tie → local)
                  ──────────────────────────────        ──────────────────────────────
ping-pong         impossible — pull terminates after    pull keeps re-applying local;
                  one tie resolution                    every pull cycle re-runs
data outcome      byte-identical row overwrites local   local stays; cloud round-trips
                  (no observable change)                back next push
synced_at         restamped on upsert — correct         needs a separate fix
                                                          (currently relies on push stamp)
edge case where   theoretical: local newer than what    no edge — but pull-cycle
 it hurts         cloud actually stored                 inefficiency is real
mitigation if     swap `>=` → strict `>` in compare;    none simple — would need to
 observed in wild accept rare miss                      teach pull to skip self-pushed rows
real risk today   bounded (push stamps updated_at       unbounded — pull churn grows
                  before send; same-second tie rare)    with row count
```

### One-line anchors
- "LWW is the simplest rule that fits the actual conflict surface — single user, sequential devices."
- "The tie-goes-to-cloud rule prevents pull-path ping-pong; it's not a fairness rule, it's a termination rule."
- "Pure function = trivially testable; the cost is no field-level merging."
- "When the conflict surface changes (real concurrency, multi-user), LWW becomes wrong — and the migration target is vector clocks plus per-field merge."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain last-write-wins conflict resolution to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `src/services/sync/conflict.ts:chooseWinner`
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

The user has the app on phone and tablet. They edit entry e123 on the phone at 2026-05-07T09:00:00.500Z (so `local.updated_at = T+500ms`), then on the tablet they edit the same entry one millisecond later at 09:00:00.501Z. The phone's push fires first (gets to cloud), then the tablet pulls. What does `chooseWinner` return on the tablet for that row? What if both clocks were perfectly in sync but the times happened to be byte-identical?

Write your answer. 3–5 sentences minimum. Then open `src/services/sync/conflict.ts` L20–L31 to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `src/services/sync/conflict.ts:chooseWinner` to support what exists
→ Point to where a `version_vector` column would have to thread through (`src/services/sync/tables/*`, the migration, every push/pull mapper) if you chose the alternative

There is no right answer. The point is specificity. Vague answers mean you don't know the code well enough to have an opinion about it yet.

### Quick check — code reference test
Without opening any files, answer:
- What file does this pattern live in?
- What is the function or class name?
- Approximately what line range?

Then open the file and verify.

✓ Pass: you named the file and function correctly
✗ Fail on lines: that's fine — line numbers change. File and function are what matter.

---
Updated: 2026-05-07 — appended Interview defense section (template v1.11.1).
Updated: 2026-05-07 — added Validate your understanding section + structured code reference (template v1.12.0).
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).

---
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram. Skipped layer labels — the diagram is a pure-function decision table, not a cross-layer composition.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for @supabase/supabase-js.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (two-children-one-toy metaphor opening / 4 layered sub-sections — pure chooseWinner, ISO-string compare, same-second cloud bias, malformed-timestamp healing — each with frontend bridges and concrete consequences / principle paragraph on convergent merge under total order).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (two-children-one-toy adult-rule scenario → LWW pattern named as the deterministic answer → bolded "what depends on getting this right" with pure-function/ISO-compare stakes → before/after walking a plane-vs-cafe concurrent edit → one-line "the resolver is a referee that always blows the whistle the same way").

---
Updated: 2026-05-14 — v1.31.0 pass (system-design re-scan): rewrote Move 1 of Why care + How it works to anchor on real software (replaced two-children-with-toy analogies with Notion two-device concurrent edits + CouchDB/Firebase LWW + Postgres MVCC last_updated timestamp). Both Move 1s were missed by the original triage agent.

---
Updated: 2026-05-14 — v1.32.0 pass: swapped Why care Move 1 from a whole-product anchor (Notion two-device edits) down to a level-1 primitive (a `posts` table with `last_updated` and two UPDATE statements + Postgres MVCC). Kept How it works Move 1 anchor on Postgres MVCC (level-4 industry primitive); kept Firebase/CouchDB as level-4 examples. Added Move 1 mnemonic diagram (resolver decision tree) + 4 Move 2 sub-section diagrams: pure-function signature, ISO-string compare with annotation, ping-pong-prevented tie trace, malformed-timestamp healing trace. Total: 5 new diagrams.
