# File-routed UI (expo-router)

**Industry name(s):** File-based routing, convention-based routing
**Type:** Industry standard · Language-agnostic

> Every file under `app/` is a route. `[param]` directories define dynamic segments. `_layout.tsx` is a wrapper that runs on every screen.

**See also:** → [01-local-first-request-flow](./01-local-first-request-flow.md) · → [15-storage-layer-summary](./15-storage-layer-summary.md)

---

## Why care

For a long time, routing was a config file: a giant lookup table that mapped URL patterns to handlers, lived in one place, and was the first thing to get out of sync with reality. Then a few frameworks noticed that the directory tree on disk already encodes the same hierarchy, and that you could just let the filesystem be the router. Adding a screen becomes "create a file." Removing one becomes "delete a file." The config file evaporates.

File-based routing is the convention that a directory layout, with naming rules for dynamic segments and shared layouts, defines the application's URL space directly. It belongs to the family of "convention over configuration" patterns, the same idea behind Rails' folder-based controllers and the way a static site generator turns Markdown files into URLs. You've seen this in Next.js, Nuxt, SvelteKit, Astro, and Remix — the pattern crossed frameworks because the ergonomic win is large and the loss is small. The shape it takes in this codebase is in Quick summary below.

---

## Quick summary
- **What:** expo-router 55 file-based routing. The `app/` directory tree IS the route tree.
- **Why here:** matches expo-router's convention so URLs and back-stack work without manual route configuration.
- **Checklist step:** 2 (Request flow)
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
   ├── vlogs.tsx                  ── /vlogs       (added 2026-05-08, bottom-nav tab)
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

**Boot path:**         `app/_layout.tsx` (287 lines) — initialises SQLite via `useDatabase`, runs cloud bootstrap, wraps providers (gesture handler, theme, fonts). Every route runs through this wrapper.
**Static routes:**     `app/index.tsx` (Today/dashboard), `app/todos.tsx` (1020 lines), `app/vlogs.tsx` (109 lines, dedicated vlogs tab — added 2026-05-08).
**Dynamic routes:**    `app/todos/[id].tsx`, `app/journal/[date].tsx`, `app/editor/[date].tsx`, `app/threads/[id].tsx`. Each reads its segment via `useLocalSearchParams<{ id?: string; date?: string }>()`.
**Nested groups:**     `app/more/{index,habits,threads,nutrition}.tsx`, `app/settings/{ai,cloud-sync,index,updates}.tsx`.
**Bottom nav:**        `src/components/nav/GlobalBottomNav.tsx` (L19, L39) — `pathname.startsWith('/vlogs')` detects the new tab; `router.push('/vlogs')` navigates. Bottom-nav tabs added in commit 78d70fb.
**Convention:**        the file system tree IS the route table — there is no `routes.ts`.

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

---

## Interview defense

### What an interviewer is really asking
File-based routing is a Next.js-ism that reads as "I follow the convention." The interviewer wants to know whether you understand what the convention buys you (no separate route table to drift) and what it costs (no easy way to share behavior across routes).

### Likely questions

[mid] Q: A user navigates to `/journal/2026-05-07`. What runs?

A: expo-router maps the URL to `app/journal/[date].tsx`. The `_layout.tsx` at the root runs first (it always does — that's the boot path that initializes SQLite, runs cloud bootstrap, and wraps providers). Then `journal/[date].tsx` mounts and reads the date param via `useLocalSearchParams<{ date: string }>()`. The component then queries the entry for that date through `useEntries.getEntryByDate(date)`. The whole chain is file-system-driven; there's no `routes.ts` to keep in sync.

[senior] Q: What's the cost of file-based routing on a small app like this?

A: Surprisingly little, because the app is small. The cost shows up in two places: first, every screen has to import its own version of shared header/footer components — there's no central route definition where you'd hang shared layout, except via `_layout.tsx` files. Second, refactoring URLs requires renaming files, which messes with version control history. For loopd's ~15 screens, both costs are negligible. If the app had 200 routes I'd reconsider; at this scale, file-as-route is the cheaper option.

[arch] Q: How does this compare to React Navigation's manual route configuration, and when would you switch?

A: React Navigation uses an explicit route registry — you declare every screen and its params in a typed config. The win is type-safety on params and centralized navigation logic; the cost is a registry that drifts from the actual screens. expo-router takes the inverse: file structure is the registry, type-safety on params is via `useLocalSearchParams<T>()` generics. I'd switch to React Navigation if I needed deeply nested navigators with complex stack/tab interactions — file-based routing handles flat plus simple nested fine, but multi-level nested back stacks get awkward. loopd's navigation is flat enough that file-based wins.

### The question candidates always dodge
Q: Your `_layout.tsx` initializes SQLite, runs the cloud bootstrap, and loads fonts. What happens to the user's first frame while all of that is happening?

A: It's a blank screen for the duration. SQLite open is fast (~50ms on Android), font loading is ~100ms, cloud bootstrap is fire-and-forget (it returns immediately and resolves async). The total cold-start to first interactive frame is around 300-500ms in my testing. That's slow enough that I should show a splash or skeleton, but I haven't because the app is single-user-mine and I don't notice it. The honest answer is the boot path is doing too much synchronously and the user's first frame pays the price; the fix is moving SQLite open into a background-resolved promise that the first screen awaits with a Suspense boundary, which is half a day of work I haven't done because I'm the only user. It's queued for the day a non-me user installs.

### One-line anchors
- "expo-router treats `app/` as the route table — `app/journal/[date].tsx` IS the route definition."
- "File-as-route eliminates one source of drift; the registry can't go out of sync with the files."
- "`_layout.tsx` at any depth wraps children below — that's where shared boot, providers, and chrome live."
- "Cost: shared route behavior is hard to abstract; for ~15 screens, the cost is negligible."

---

## Validate your understanding

### Level 1 — Reconstruct the diagram
Close this file. Open a blank document or whiteboard. Draw the primary diagram from memory. Label every box and every arrow.

Open the file. Compare.

✓ Pass: your diagram matches the structure and labels
✗ Fail: re-read the diagram section, wait 10 minutes, try again. Do not move to Level 2 until you pass.

### Level 2 — Explain it out loud
Explain file-routed UI to an imaginary colleague who just asked "how does this work in your project?" No notes. Under 90 seconds.

Checkpoints — did you:
- Name the specific file or function?  → `app/_layout.tsx` + `app/journal/[date].tsx` (representative route)
- Say why this approach was chosen over the alternative?
- Name the tradeoff in one sentence?

If you skipped any: you described it, you didn't understand it.

### Level 3 — Apply it to a new scenario
Answer this without looking at the file:

A user navigates from `/` (dashboard) to `/journal/2026-05-07` and then taps a `[]` line that opens a todo: `/todos/abc-123`. Walk the route tree, the `_layout.tsx` chain, and what params each screen reads. Then they hit hardware-back twice — what's the back-stack behaviour and why?

Write your answer. 3–5 sentences minimum. Then open `app/_layout.tsx`, `app/journal/[date].tsx`, and `app/todos/[id].tsx` to verify.

### Level 4 — Defend the decision you'd change
Pick the biggest tradeoff from the Tradeoffs section. Answer in writing:

"If you were starting this project today with the same constraints, would you make the same decision? Why or why not? If you'd change it, what would you do instead and what would that cost?"

Reference the actual code:
→ Point to `app/_layout.tsx` (the file-as-route convention) to support what exists
→ Point to where a React Navigation route registry would land (a new `src/navigation/routes.ts` plus refactored screen registrations) if you chose the alternative

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
Updated: 2026-05-10 — added `/vlogs` route (`app/vlogs.tsx`, 109 lines) + bottom-nav tab. Route count grew by one.
Updated: 2026-05-10 — converted subtitle to v1.14.0 two-line block + added Checklist step bullet.

---
Updated: 2026-05-10 — added Why care block (template v1.18.0).
