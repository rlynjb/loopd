# File-routed UI (expo-router)

> Every file under `app/` is a route. `[param]` directories define dynamic segments. `_layout.tsx` is a wrapper that runs on every screen.

**See also:** → [01-local-first-request-flow](./01-local-first-request-flow.md) · → [15-storage-layer-summary](./15-storage-layer-summary.md)

---

## Quick summary
- **What:** expo-router 55 file-based routing. The `app/` directory tree IS the route tree.
- **Why here:** matches expo-router's convention so URLs and back-stack work without manual route configuration.
- **Tradeoff:** harder to abstract a route shape across many screens — each file is its own thing. For a small app, fine.

---

## File-routed UI — diagram

```
  app/
   ├── _layout.tsx                ── root layout, the boot path
   ├── index.tsx                  ── /            (Today / dashboard)
   ├── todos.tsx                  ── /todos
   ├── todos/
   │    └── [id].tsx              ── /todos/<todoId>
   ├── journal/
   │    └── [date].tsx            ── /journal/2026-05-07
   ├── editor/
   │    └── [date].tsx            ── /editor/2026-05-07
   ├── threads/
   │    └── [id].tsx              ── /threads/<threadId>
   ├── more/
   │    ├── index.tsx, habits.tsx, threads.tsx, nutrition.tsx
   └── settings/
        └── ai.tsx, cloud-sync.tsx, index.tsx, updates.tsx
```

---

## How it works

expo-router scans `app/` at build time and generates a route map. `_layout.tsx` at any level wraps the children below it. Dynamic segments are folder names in `[brackets]` and the param is read with `useLocalSearchParams()`.

The root `_layout.tsx` is the boot path: it initialises SQLite (via `useDatabase`), runs the bootstrap (cloud sync init), and wraps everything in providers (gesture handler, theme, fonts).

Navigation uses `useRouter().push('/path')`. Hardware back goes to the previous file in the stack. There is no manual route table.

---

## In this codebase

- `app/_layout.tsx` — boot path; initialises DB and bootstrap.
- `app/index.tsx` — Today/dashboard.
- `app/todos.tsx`, `app/todos/[id].tsx`.
- `app/journal/[date].tsx`, `app/editor/[date].tsx`.
- `app/threads/[id].tsx`.
- `app/more/{index,habits,threads,nutrition}.tsx`.
- `app/settings/{ai,cloud-sync,index,updates}.tsx`.

---

## Elaborate

### Where this pattern comes from
File-based routing came out of Next.js, which borrowed it from older PHP/Rails conventions. Expo adopted it to replicate the Next.js mental model in React Native. The win: `app/journal/[date].tsx` *is* the route definition; no separate `routes.ts` to keep in sync.

### The deeper principle
**Convention-as-code: the file system carries information that would otherwise need configuration.** When the location of a file decides its URL and its position in the navigation tree, you can't get those out of sync because they're the same fact.

### Where this breaks down
- Routes that don't map cleanly to a single file (modals, nested back stacks). expo-router has solutions but they're more complex than the basic shape.
- Apps where many routes share rich behaviour. Each file has to import the shared bits; abstraction at the route level is awkward.

### What to explore next
- expo-router groups (`(tabs)`, `(modal)`) → for nested navigation patterns.
- Next.js App Router → the same pattern with React Server Components.

---

## Tradeoffs

- **File-as-route** — gives: zero route configuration. Costs: hard to abstract over many routes.
- **`_layout.tsx` everywhere** — gives: scoped wrappers (e.g., a settings stack with its own header). Costs: another file per scope.
- **`[param]` segments** — gives: type-friendly param reading. Costs: the param is always a string; you parse and validate downstream.
