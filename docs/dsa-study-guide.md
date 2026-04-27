# loopd — DSA study guide

A coding-interview prep deck where every problem is derived from a real operation in this codebase. Each problem cites the file:line where the pattern appears, gives both brute-force and optimal solutions in TypeScript, and ends with a follow-up question a senior interviewer would actually ask.

The closing **complexity cheat sheet** lists every significant data operation in loopd with current Big-O and a "would this hold at scale" judgment.

## Table of contents

1. [Array manipulation — apply a target order](#1-array-manipulation--apply-a-target-order)
2. [HashMap / Set — deduplicate by normalized content](#2-hashmap--set--deduplicate-by-normalized-content)
3. [Tree / nested data — flatten + join with metadata](#3-tree--nested-data--flatten--join-with-metadata)
4. [Sorting — composite priority sort](#4-sorting--composite-priority-sort)
5. [String manipulation — line-state-machine markdown parser](#5-string-manipulation--line-state-machine-markdown-parser)
6. [Queue / stack — rate-limited serial drain with retry](#6-queue--stack--rate-limited-serial-drain-with-retry)
7. [Complexity cheat sheet](#7-complexity-cheat-sheet)

---

## 1. Array manipulation — apply a target order

### Where this appears in loopd

When the user reorders a todo via the up/down arrows in [/todos](../app/todos.tsx), the page rebuilds visible-sort positions and persists them. The current implementation does an adjacent swap ([reorder.ts:51-62](../src/services/todos/reorder.ts#L51-L62)) — but the *generalized primitive* this problem covers is what you'd build for a drag-and-drop UI: given a target order of IDs, mutate positions to match. Same hashmap-driven shape, broader use case.

### Problem statement

You're given two arrays:

- `items: { id: string; position: number | null; createdAt: string }[]`
- `targetOrder: string[]` — a permutation of the visible IDs in their *new* desired order.

Update each item's `position` to a dense integer matching its index in `targetOrder`. Items not in `targetOrder` keep their current `position`. Return the updated `items` array (you may mutate in place).

### Brute force

For each id in `targetOrder`, scan `items` linearly for a match. `O(n × m)` time where `m = items.length`, `n = targetOrder.length`. Fine for tiny inputs, embarrassing if either grows.

```ts
function reorderBrute(items: Item[], targetOrder: string[]): Item[] {
  for (let i = 0; i < targetOrder.length; i++) {
    const id = targetOrder[i];
    for (const item of items) {        // O(m) per outer iter
      if (item.id === id) { item.position = i; break; }
    }
  }
  return items;
}
// Time: O(n × m)   Space: O(1)
```

### Optimal

Build a `Map<id, item>` once (`O(m)`), then iterate `targetOrder` with `O(1)` lookups. Total `O(n + m)` time, `O(m)` space.

```ts
function reorderOptimal(items: Item[], targetOrder: string[]): Item[] {
  const byId = new Map(items.map(it => [it.id, it]));   // O(m)
  for (let i = 0; i < targetOrder.length; i++) {
    const item = byId.get(targetOrder[i]);
    if (item) item.position = i;
  }
  return items;
}
// Time: O(n + m)   Space: O(m)
```

### Key insight

Trade space for time. The hashmap turns the inner `O(m)` scan into `O(1)`. This is the most-used array-with-lookups optimization in interview problems and shows up everywhere in this codebase: every two-pass matcher uses it, the entry/meta join uses it, the autocomplete query result dedupe uses it.

### Follow-up question

> "What if `targetOrder` contains an ID that doesn't exist in `items`?"

A senior answer: in this codebase I'd ignore unknown IDs (the `if (item)` guard) because the gesture library could send a stale ID after a delete. But in a stricter contract — say a server-side endpoint expecting the client to be consistent — I'd surface unknowns explicitly: collect them into a `missing[]` array and return `{ updated, missing }`. The choice is about *who's responsible for the contract* — defensive UI vs. strict API.

### Execution trace

```
items = [
  { id: "a", position: 0, createdAt: "..." },
  { id: "b", position: 1, createdAt: "..." },
  { id: "c", position: 2, createdAt: "..." },
]
targetOrder = ["c", "a", "b"]

Step 1 — build byId Map (O(m)):
  byId = { "a" → ref(items[0]),
           "b" → ref(items[1]),
           "c" → ref(items[2]) }

Step 2 — iterate targetOrder (O(n)):
  i=0  id="c"  byId.get("c") → items[2]  → items[2].position = 0
  i=1  id="a"  byId.get("a") → items[0]  → items[0].position = 1
  i=2  id="b"  byId.get("b") → items[1]  → items[1].position = 2

Output:
  [ {id:"a", position:1}, {id:"b", position:2}, {id:"c", position:0} ]

Re-sorted by position ASC:
  [ {id:"c", position:0}, {id:"a", position:1}, {id:"b", position:2} ]
```

---

## 2. HashMap / Set — deduplicate by normalized content

### Where this appears in loopd

[scanTodos.ts:33-40](../src/services/todos/scanTodos.ts#L33-L40) — when the parser walks an entry's text and finds two `[]` lines with the same content (case-insensitively, after trim), only the first is kept. The dedup uses a `seen: Set<string>` keyed by the normalized content.

### Problem statement

Given an array of strings (representing lines from a markdown document), return the unique entries preserving *first-seen* order. Equality is case-insensitive after trimming whitespace. Empty strings are ignored.

```ts
input  = ["Call mom", "  call mom  ", "buy milk", "Call MOM", "buy milk"]
output = ["Call mom", "buy milk"]
```

### Brute force

For each candidate, scan all already-emitted unique values for an existing match. `O(n²)` worst case.

```ts
function uniqueBrute(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const norm = line.trim().toLowerCase();
    if (!norm) continue;
    let dup = false;
    for (const existing of out) {            // O(k) per iter, k grows
      if (existing.trim().toLowerCase() === norm) { dup = true; break; }
    }
    if (!dup) out.push(line);
  }
  return out;
}
// Time: O(n²)   Space: O(n) for out (stored display values)
```

### Optimal

Use a `Set<string>` keyed by the normalized form. Track unique status in O(1). Push the *original* string into the output to preserve display formatting.

```ts
function uniqueOptimal(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const norm = line.trim().toLowerCase();
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(line);
  }
  return out;
}
// Time: O(n × L)   Space: O(n × L)   where L = avg line length (for hashing)
```

### Key insight

Two distinct concerns: *display format* (preserve original whitespace and capitalization) and *identity* (case-insensitive normalized). Don't conflate them. The Set holds normalized keys; the output array holds raw values. Same idea as how loopd hashes drop content separately from rendering it — see [scanTodos.ts:43](../src/services/todos/scanTodos.ts#L43) (`const key = content.toLowerCase()`).

### Follow-up question

> "What if the dataset is too large to fit in memory?"

A senior answer: the in-memory Set scales to roughly the number of distinct items, not raw lines. If distinct items also exceed memory, you'd switch to either (a) a Bloom filter — accept some false positives, get O(1) space per item bit-rate, or (b) external sort + adjacent-dedup — sort lines on disk, then walk linearly skipping consecutive duplicates. (a) trades correctness for memory; (b) trades latency for memory. In loopd's case, "distinct todos in one entry" maxes out in single digits, so the in-memory Set is correct and trivial.

### Execution trace

```
input = ["Call mom", "  call mom  ", "buy milk", "Call MOM", "buy milk"]

Iter | line              | normalized      | seen?  | out
─────┼───────────────────┼─────────────────┼────────┼─────────────────────────
  0  | "Call mom"        | "call mom"      | NO     | ["Call mom"]
  1  | "  call mom  "    | "call mom"      | YES    | ["Call mom"]
  2  | "buy milk"        | "buy milk"      | NO     | ["Call mom","buy milk"]
  3  | "Call MOM"        | "call mom"      | YES    | (skip)
  4  | "buy milk"        | "buy milk"      | YES    | (skip)

seen = { "call mom", "buy milk" }
out  = ["Call mom", "buy milk"]
```

---

## 3. Tree / nested data — flatten + join with metadata

### Where this appears in loopd

[app/todos.tsx](../app/todos.tsx) — building the row list for the screen. `Entry[]` is loaded; each entry has nested `todos: TodoItem[]`. Separately, `TodoMeta[]` is loaded from `todo_meta`. The render layer needs a flat array of rows where each todo carries its parent's `entryDate` plus its meta. This is a tree-flatten + hash-join in one pass.

### Problem statement

You're given:

- `entries: { id; date; todos: { id; text; done }[] }[]`
- `metas: { todoId; type; stage }[]` — 1:1 with each TodoItem

Return `Row[]` where each row is `{ ...todo, entryId, entryDate, meta }`. If a todo has no matching meta, fill in a default `{ type: 'todo', stage: 'todo' }`. Order doesn't matter for this problem (sorting is a separate question).

### Brute force

For each todo, scan `metas` linearly. `O(N × M)` where `N` = total todos, `M` = total metas.

```ts
function joinBrute(entries: Entry[], metas: Meta[]): Row[] {
  const out: Row[] = [];
  for (const entry of entries) {
    for (const todo of entry.todos) {
      let meta = metas.find(m => m.todoId === todo.id);  // O(M)
      if (!meta) meta = { todoId: todo.id, type: 'todo', stage: 'todo' };
      out.push({ ...todo, entryId: entry.id, entryDate: entry.date, meta });
    }
  }
  return out;
}
// Time: O(N × M)   Space: O(N)
```

### Optimal

Build `Map<todoId, Meta>` once. Walk the tree linearly, doing `O(1)` lookups. Total `O(N + M)`.

```ts
function joinOptimal(entries: Entry[], metas: Meta[]): Row[] {
  const byId = new Map(metas.map(m => [m.todoId, m]));   // O(M)
  const out: Row[] = [];
  for (const entry of entries) {
    for (const todo of entry.todos) {
      const meta = byId.get(todo.id) ?? defaultMeta(todo);
      out.push({ ...todo, entryId: entry.id, entryDate: entry.date, meta });
    }
  }
  return out;
}
// Time: O(N + M)   Space: O(M) for map + O(N) for output
```

### Key insight

The "tree flatten" doesn't add asymptotic cost — it's just nested iteration over a fixed dataset. The win is the same hashmap-join trick from problem 1, applied during the flatten. **Pre-build the lookup; keep the inner loop O(1).** The pattern is so common it has a name in databases: *hash join*. Loopd uses it in [app/todos.tsx:124-135](../app/todos.tsx#L124-L135) where `metas: Map<string, TodoMeta>` is built once on load, then keyed `metas.get(todo.id)` per row.

### Follow-up question

> "How would this scale to 100k todos and 1k entries?"

A senior answer: at that volume, the JS-side flatten becomes a render-time cliff. Three steps. (1) Move the join to SQL — a single `SELECT entries.id, entries.date, todos_json, todo_meta.* FROM entries LEFT JOIN todo_meta ON ...` returns the joined rows already, no JS hash needed. (2) Page the result — render only what's visible via virtualized lists (`FlashList` from Shopify in React Native). (3) Index `todo_meta(todo_id)` so the SQL join is `O(N log M)` rather than full scan. The principle: at small scale, JS-side hash joins are fine; at large scale, push the join to the layer with the index.

### Execution trace

```
entries = [
  { id: "e1", date: "2026-04-25", todos: [
      { id: "t1", text: "call mom", done: false },
      { id: "t2", text: "buy milk", done: true },
  ]},
  { id: "e2", date: "2026-04-26", todos: [
      { id: "t3", text: "review PR", done: false },
  ]},
]
metas = [
  { todoId: "t1", type: "todo",  stage: "todo" },
  { todoId: "t3", type: "idea",  stage: "in_progress" },
]

Step 1 — build byId Map (O(M)):
  byId = { "t1" → metas[0], "t3" → metas[1] }

Step 2 — flatten + join:
  e1.t1  byId.get("t1") → metas[0]    → row: { ...t1, entryDate:"04-25", meta:metas[0] }
  e1.t2  byId.get("t2") → undefined   → row: { ...t2, entryDate:"04-25", meta:default }
  e2.t3  byId.get("t3") → metas[1]    → row: { ...t3, entryDate:"04-26", meta:metas[1] }

Output rows: [
  { id:"t1", text:"call mom",  done:false, entryDate:"04-25", meta:{type:"todo"} },
  { id:"t2", text:"buy milk",  done:true,  entryDate:"04-25", meta:{type:"todo"} },  (default)
  { id:"t3", text:"review PR", done:false, entryDate:"04-26", meta:{type:"idea"} },
]
```

---

## 4. Sorting — composite priority sort

### Where this appears in loopd

[rank.ts:50-71](../src/services/todos/rank.ts#L50-L71) — the dashboard's `SmartTodoList` uses `rankTodos` to surface what the user should attend to. The sort is *lexicographic* across two keys: source priority (carried-from-yesterday < AI-generated < journal-origin), then `createdAt` ASC within each source.

### Problem statement

Given todos with `{ source: 'carried' | 'ai' | 'journal', createdAt: number }`, sort with this rule:

1. Primary key: source priority (carried < ai < journal).
2. Tiebreak: `createdAt` ascending.

The sort must be stable across identical sort keys.

### Brute force

Pass a comparator to `Array.prototype.sort`. The comparator parses dates per call. `O(n log n)` time, but with high constant factor from repeated parsing.

```ts
const PRIORITY = { carried: 0, ai: 1, journal: 2 };
function sortBrute(todos: Todo[]): Todo[] {
  return [...todos].sort((a, b) => {
    const ap = PRIORITY[a.source];
    const bp = PRIORITY[b.source];
    if (ap !== bp) return ap - bp;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    //     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ parsed every comparison
  });
}
// Time: O(n log n × C) where C = date-parse cost per call
// Space: O(n) for the new array
```

### Optimal

Pre-compute sort keys once. The sort comparator becomes pure number math.

```ts
function sortOptimal(todos: Todo[]): Todo[] {
  // Decorate
  const decorated = todos.map(t => ({
    todo: t,
    pri: PRIORITY[t.source],
    time: new Date(t.createdAt).getTime(),
  }));
  // Sort
  decorated.sort((a, b) => {
    if (a.pri !== b.pri) return a.pri - b.pri;
    return a.time - b.time;
  });
  // Undecorate
  return decorated.map(d => d.todo);
}
// Time: O(n log n), parses dates once per item (O(n))
// Space: O(n) for decorated array
```

### Key insight

Algorithmic complexity doesn't improve — both are `O(n log n)`. The optimization is the **decorate-sort-undecorate** pattern (also called "Schwartzian transform"). Pre-compute sort keys once so the comparator is `O(1)` per call. Beyond performance, this also makes stability obvious — the original todo references are preserved verbatim, so V8/JSC's stable sort holds. Same idea applies whenever your sort comparator does any non-trivial work per call.

### Follow-up question

> "What if I want to sort by *user-defined* priority (the user can drag categories around)?"

A senior answer: replace the static `PRIORITY` constant with a `Map<source, number>` parameter. Pass it in. The sort algorithm doesn't change; only the comparator's lookup does. This is the same pattern loopd uses for [TYPE_META in typeMeta.ts](../src/services/todos/typeMeta.ts) — type ordering is a constant today, but the data structure is already a Map so swapping in user-configurable order is a one-file change.

### Execution trace

```
input:
  [ { id:"a", source:"journal",  createdAt:"2026-04-26T10:00:00Z" },
    { id:"b", source:"carried",  createdAt:"2026-04-25T08:00:00Z" },
    { id:"c", source:"ai",       createdAt:"2026-04-26T09:00:00Z" },
    { id:"d", source:"carried",  createdAt:"2026-04-25T11:00:00Z" } ]

Step 1 — decorate (O(n) parse):
  [ {pri:2, time:T_a}, {pri:0, time:T_b}, {pri:1, time:T_c}, {pri:0, time:T_d} ]

Step 2 — sort (O(n log n)):
  Compare pairs by (pri, time) tuple ascending.
  Result indices: b (pri=0,time:08), d (pri=0,time:11), c (pri=1), a (pri=2)

Step 3 — undecorate:
  [ b, d, c, a ]
```

---

## 5. String manipulation — line-state-machine markdown parser

### Where this appears in loopd

[`RenderedMarkdown` in app/todos/[id].tsx](../app/todos/[id].tsx#L226-L284) — the expansion view renders a markdown subset (headings, key-value lines, bullet lists, paragraphs) into React. The current implementation is a hand-rolled state machine that walks the lines once and groups consecutive bullets / paragraphs together.

### Problem statement

Parse a markdown subset into structured blocks. Recognize:

- `## Heading` → `{ kind: 'heading', text }`
- `**Label:** value` → `{ kind: 'kv', key, value }`
- `- bullet` (one or more consecutive lines) → `{ kind: 'bullets', items: string[] }`
- Anything else (one or more consecutive non-blank lines) → `{ kind: 'paragraph', text: string }`
- Blank line → terminates the current paragraph or bullet block

Return `Block[]` in document order.

### Brute force

Two-pass: first pass classifies each line independently; second pass merges runs of bullets / paragraphs.

```ts
function parseBrute(md: string): Block[] {
  const lines = md.split('\n');
  // Pass 1 — classify
  type Tag = { kind: 'heading'|'kv'|'bullet'|'para'|'blank'; payload: any };
  const tagged: Tag[] = lines.map(line => { /* ... classify ... */ });
  // Pass 2 — group runs
  const out: Block[] = [];
  let i = 0;
  while (i < tagged.length) {
    if (tagged[i].kind === 'bullet') {
      const items: string[] = [];
      while (tagged[i]?.kind === 'bullet') { items.push(tagged[i].payload); i++; }
      out.push({ kind: 'bullets', items });
    } else if (tagged[i].kind === 'para') { /* similar grouping */ }
    /* etc. */
    else i++;
  }
  return out;
}
// Time: O(n) but with two passes and an intermediate Tag[] allocation
// Space: O(n) for tagged + O(n) for out
```

### Optimal

One-pass state machine. Walk lines once; track current open block; close it on type change. Same `O(n)` time but no intermediate array.

```ts
function parseOptimal(md: string): Block[] {
  const lines = md.split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Heading
    if (line.startsWith('## ')) {
      out.push({ kind: 'heading', text: line.slice(3).trim() });
      i++; continue;
    }
    // KV
    const kvMatch = line.match(/^\*\*([^*]+)\*\*\s*(.*)$/);
    if (kvMatch) {
      out.push({ kind: 'kv', key: kvMatch[1], value: kvMatch[2].trim() });
      i++; continue;
    }
    // Bullets — collect run
    if (line.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith('- ')) {
        items.push(lines[i].slice(2).trim());
        i++;
      }
      out.push({ kind: 'bullets', items });
      continue;
    }
    // Paragraph — collect until blank/heading/bullet/kv
    const para: string[] = [];
    while (i < lines.length && lines[i].trim()
           && !lines[i].startsWith('## ')
           && !lines[i].startsWith('- ')
           && !/^\*\*[^*]+\*\*/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push({ kind: 'paragraph', text: para.join(' ') });
  }
  return out;
}
// Time: O(n)   Space: O(n) for output
```

### Key insight

A markdown subset is a *line-level grammar*. Each line's classification depends only on its prefix, but a paragraph "block" is a run of consecutive lines. The state machine merges classification and grouping into a single pass: when you see a bullet, run a tight inner loop until the run ends, then emit one `bullets` block. The pattern generalizes: any time you parse a sequence with "groups of similar items," prefer a single-pass grouped consumer over a two-pass classify-then-group.

### Follow-up question

> "What if I need to support nested bullets (`  - sub-bullet` indented under `- bullet`)?"

A senior answer: nested bullets break the single-pass-flat model. You need a stack — push when indent increases, pop when it decreases — to track current depth. The block shape becomes recursive: `{ kind: 'bullets', items: (string | NestedBullets)[] }`. You can still do it in one pass with the right data structure; the algorithm is still O(n), but the state machine has more states (depth tracking). For loopd's expansion output, I deliberately ship without nesting because the LLM's output schema doesn't include hierarchical bullets — adding parser support before there's a producer is premature.

### Execution trace

```
input:
  ## Observed
  the build is failing with EACCES
  intermittently

  ## Repro Steps
  - rm -rf node_modules
  - npm install
  - watch it crash

State machine:
  i=0  "## Observed"                  → emit heading{"Observed"}; i=1
  i=1  "the build is failing..."      → start paragraph
  i=2  "intermittently"               → continue paragraph
  i=3  ""                             → blank, emit paragraph{"the build is... intermittently"}; i=4
  i=4  "## Repro Steps"               → emit heading{"Repro Steps"}; i=5
  i=5  "- rm -rf node_modules"        → start bullets run
  i=6  "- npm install"                → continue bullets run
  i=7  "- watch it crash"             → continue bullets run
  i=8  EOF                            → emit bullets{["rm -rf...", "npm install", "watch it crash"]}

output: [
  heading("Observed"),
  paragraph("the build is failing... intermittently"),
  heading("Repro Steps"),
  bullets(["rm -rf node_modules","npm install","watch it crash"]),
]
```

---

## 6. Queue / stack — rate-limited serial drain with retry

### Where this appears in loopd

Two parts. (1) [notion/api.ts:7-16](../src/services/notion/api.ts#L7-L16) — module-level rate limiter enforces ≥350ms between every Notion call, regardless of which feature is calling. (2) [database.ts:121-129](../src/services/database.ts#L121-L129) — `sync_deletions` table acts as a FIFO queue of pending Notion archive operations, drained in order on the next sync.

The pattern: jobs queued in SQLite, drained serially with rate limiting, with retry on rate-limit responses. This is what production-grade Notion-clients look like.

### Problem statement

Implement `drainQueue(jobs, callApi)` where:

- `jobs: () => Promise<Result>[]` is an array of async functions, each making one external API call.
- `callApi` is the underlying call that may return `{ ok: true }` or `{ ok: false, retryAfterMs?: number, status: number }`.
- The drain runs jobs serially.
- Between consecutive jobs, wait at least `350ms` from the start of the previous job.
- On `429` (rate-limited) response, wait `retryAfterMs` (or default 1000ms × 2^attempt) and retry the *same* job up to 3 times.
- On any other error, log and skip the job.
- Return `{ succeeded: number; failed: number }`.

### Brute force

Naive `Promise.all(jobs.map(...))` violates rate-limiting (all fire concurrently). It's not really a brute-force *for this problem* — it's just wrong. The acceptable brute-force is `for...of with await callApi(); await sleep(350)` and no retry handling — works but every transient 429 is a permanent failure.

```ts
async function drainBrute(jobs: Job[], callApi: ApiFn): Promise<Stats> {
  let succeeded = 0, failed = 0;
  for (const job of jobs) {
    try {
      const r = await job(callApi);
      if (r.ok) succeeded++; else failed++;
    } catch { failed++; }
    await sleep(350);
  }
  return { succeeded, failed };
}
// Time: O(n × 350ms) — bounded by rate limit, not algorithm
// Space: O(1)
// Failure mode: every 429 is permanent failure
```

### Optimal

Serial drain + per-job retry with exponential backoff. Tracks `lastCallAt` to enforce the 350ms gap *between* calls (so retries within a job don't wait twice).

```ts
async function drainOptimal(jobs: Job[], callApi: ApiFn): Promise<Stats> {
  let succeeded = 0, failed = 0;
  let lastCallAt = 0;
  const MIN_GAP = 350;
  const MAX_RETRIES = 3;

  for (const job of jobs) {
    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      const wait = Math.max(0, MIN_GAP - (Date.now() - lastCallAt));
      if (wait > 0) await sleep(wait);
      lastCallAt = Date.now();

      const r = await job(callApi);
      if (r.ok) { succeeded++; break; }

      if (r.status === 429 && attempt < MAX_RETRIES) {
        const backoff = r.retryAfterMs ?? 1000 * Math.pow(2, attempt);
        await sleep(backoff);
        attempt++;
        continue;
      }
      failed++; break;
    }
  }
  return { succeeded, failed };
}
// Time: O(n × max(350ms, retry_backoff))
// Space: O(1)
```

### Key insight

Three intertwined concerns: **serialization** (one call at a time), **rate gating** (≥350ms between calls), **retry policy** (re-run the *same* job on 429 with backoff). The trick is that the 350ms gap should be measured from `lastCallAt`, not "after every job blindly sleep 350ms" — otherwise you double-pay when a retry already waited longer than 350ms. This is exactly how [notion/api.ts:9-16](../src/services/notion/api.ts#L9-L16) tracks `lastRequestTime` as module state.

### Follow-up question

> "How would you support multiple concurrent workers, each rate-limited independently?"

A senior answer: replace the single `lastCallAt` with one per worker. If the rate limit is *per-account* (not per-worker), share a single `lastCallAt` across all workers — but then you've effectively re-serialized them and gained nothing. The honest pattern is a **token bucket**: a shared bucket holds N tokens; each call consumes one; tokens refill at the rate limit. Multiple workers compete for tokens. This decouples concurrency from rate limiting and lets you tune them independently. Loopd doesn't need this today (single client per device), but if I built a server-side sync gateway for the multi-user case, I'd reach for token-bucket-via-Redis.

### Execution trace

```
jobs    = [job1, job2, job3]
callApi → returns ok=true except job2 first time → 429 retryAfterMs=500

t=0      lastCallAt=0
         wait = max(0, 350 - 0) = 0
         exec job1 → ok            succeeded=1
         lastCallAt=t1≈0

t=350    wait = max(0, 350 - 350) = 0
         exec job2 → 429 retryAfter=500   attempt=0
         sleep(500)
         attempt=1

t=850    wait = max(0, 350 - 500) = 0  (350ms gap already exceeded by retry)
         exec job2 → ok                    succeeded=2
         lastCallAt=t≈850

t=1200   wait = max(0, 350 - 350) = 0
         exec job3 → ok                    succeeded=3

return { succeeded: 3, failed: 0 }
```

---

## 7. Complexity cheat sheet

Per-operation Big-O for everything significant in loopd. *N* = total entries, *T* = total todos across all entries, *M* = total `todo_meta` rows (= *T*).

| Operation | Time | Space | At scale | Notes |
|---|---|---|---|---|
| `getAllEntries()` | O(N) read + JSON parse | O(N) | OK to ~10k entries | Linear DB scan; JSON parse for `todos_json`/`clips_json` is the cost driver |
| `getEntriesByDate(date)` | O(log N + k) | O(k) | Fine | Uses `idx_entries_date` index; k = entries on that date |
| `/todos` flat-list build | O(T + M) join + O(T log T) sort | O(T) | Push to SQL at 5k+ todos | JS-side hash join via `metas: Map`, then comparator sort |
| `updateEntry()` | O(1) DB write | O(1) | Fine | Single row UPDATE |
| `deleteEntry()` | O(1) + 2 cascade DELETEs | O(1) | Fine | Cascades to `todo_meta` + `nutrition` for that entry |
| `moveTodoUp/Down()` | O(T) on first reorder, O(1) thereafter | O(1) | OK to ~1000 todos | First call runs `ensureAllTodoPositions` (O(T) bulk write) |
| `scanTodosFromText(text, existing)` | O(L + E) | O(L + E) | Fine | L = lines in text; E = existing todos for entry |
| `reconcileTodoMetaForEntry(entry)` | O(T_e + M_e) | O(M_e) | Fine | T_e, M_e = per-entry counts (single digits typical) |
| `pullTodos(notion)` | O(P + T) where P = Notion pages | O(P) | Fine; bounded by Notion API page size | Builds `byLoopdId` Map first |
| `pushTodos(notion, dirty)` | O(d × 350ms) where d = dirty rows | O(d) | Bounded by rate limit | One Notion API call per dirty row, serialized |
| `classifyTodo(text)` | 1 LLM call (~1-3s) | O(1) | Cost-bounded by `MAX_CONCURRENT=3` (expand) and ad-hoc (classify) | Module-level in-flight counter |
| `expandTodo(id, text)` | 1-2 LLM calls (~5-15s) | O(1) | Bounded by `MAX_CONCURRENT=3` | Auto-retry once on malformed JSON |
| `backfillTodoMeta()` | O(N × T_avg) | O(1) | One-time per install | SecureStore-gated |
| `classifyAmbiguousMeta()` | O(K × LLM) where K = unclassified rows | O(K) | Boot-time, fire-and-forget | Skips done-or-overridden rows |
| `getNutritionSuggestions(query)` | O(R) read + O(R) dedupe in JS | O(D) where D = distinct names | Fine to ~5k nutrition rows | Could push DISTINCT to SQL |
| `processDeletions(token, type)` | O(d × 350ms) | O(d) | Bounded by rate limit | FIFO drain of `sync_deletions` |
| `Notion sync overall` | O(rate-limit × dirty count) | O(d) | Acceptable up to ~1000 dirty rows per sync | Past that, the user waits noticeably |

### Where the cliffs are

- **`/todos` JS-side sort+filter** — at 5k+ todos starts to jank during scroll. Solution: virtualize the list (`FlashList`) and push sort/filter into a `useMemo` keyed only by inputs that affect them.
- **Notion sync** — at high dirty counts (>1000), 350ms × 1000 = 5+ minutes of serial pushes. Solution: batch where Notion supports it (it doesn't for individual page creates), or accept the wall-clock cost with a progress UI.
- **First reorder bulk write** — O(T) `updateTodoMeta` calls, each a SQL UPDATE. At 1000+ todos this is a noticeable pause. Solution: wrap in a single transaction (SQLite batch), or implement Linear-style sparse fractional indexing so positions don't need bulk reassignment.
- **LLM expansion latency** — 5-15s per call is fine UX-wise with a loading state, but if a user taps 10 expand buttons at once they see queueing behavior. Already handled by `MAX_CONCURRENT=3`, but a streaming response would feel snappier.

### Where you should *not* optimize prematurely

- **Single-entry scan** is O(L + E) where both are typically <50. No optimization needed.
- **Module-level rate limiter** is correct as-is. Don't reach for token buckets until you have multiple workers.
- **Heuristic classifier** is O(L) regex scan — already as cheap as it gets without sacrificing accuracy.

---

## How to use this guide

For each problem: **read the brute force, articulate why it's slow, then articulate why the optimal works.** Don't memorize the optimal; understand the *insight*. The interviewer's bar isn't whether you can solve the problem — it's whether you can name the data-structure tradeoff (hashmap for lookup, set for uniqueness, decorate-sort-undecorate for sort, state machine for grouping, token bucket for rate-distribution).

When asked any DSA question on this codebase, reach for these primitives in this order: **(1) is there a lookup I can hash?** **(2) is there a uniqueness check I can set?** **(3) is the per-comparison cost expensive — can I decorate?** **(4) is there a sequence I'm parsing — should it be a state machine?** **(5) is there an external resource I'm using — does it need a rate limiter or a token bucket?**

Five primitives cover almost every real interview problem. Every problem in this guide is a clean instance of one of them.
