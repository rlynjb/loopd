# File-routed UI (expo-router)

**Industry name(s):** File-based routing, convention-based routing
**Type:** Industry standard · Language-agnostic

> Every file under `app/` is a route. `[param]` directories define dynamic segments. `_layout.tsx` is a wrapper that runs on every screen.

**See also:** → [01-local-first-request-flow](./01-local-first-request-flow.md) · → [15-storage-layer-summary](./15-storage-layer-summary.md)

---

## Why care

Imagine a library where the shelves *are* the catalogue. There's no index card system telling you which book sits in which row — the row a book sits in IS its address, and walking the shelves IS reading the catalogue. Want to add a new book? You put it on a shelf. Want to know where a book lives? You read the spine and you know. Compare this to a library where every book has a number in a card catalogue that may or may not match where the book actually is — the catalogue and the shelves are two systems that have to be kept in sync by hand, and one of them is always slightly wrong.

The question that library answers is one every app with more than a handful of screens has to answer: should there be a config file that maps URL patterns to components, or should the directory tree on disk be the map? Not a giant `routes.ts` lookup table — that's the first thing to drift from reality. The answer is *file-based routing*: a directory layout with naming rules for dynamic segments and shared layouts that defines the URL space directly.

**What depends on getting this right:** whether adding a screen is "create a file" or "create a file, edit the route table, register the import, restart the dev server," and whether removing a screen always also removes the route. In this codebase the `app/` directory tree IS the route map. `app/index.tsx` renders `/`. `app/journal/[date].tsx` renders `/journal/:date` with `date` as a dynamic param read via `useLocalSearchParams<{ date: string }>()`. `_layout.tsx` files at any level wrap their children — the root `app/_layout.tsx` runs `useDatabase()`, `bootstrap()`, theme providers, and font loading before any screen mounts. Navigation is `useRouter().push('/journal/2026-05-10')` — the path is the file path under `app/` minus the extension. Hardware back pops the navigation stack automatically. There is no `routes.ts`.

Without file-based routing (manual route table):
- Developer creates `screens/threads/ThreadDetail.tsx`
- Adds an entry to `routes.ts` mapping `/threads/:id` to the component
- Registers an import; restarts the dev server; updates the navigation typedef
- Forgets to update the typedef; runtime navigation works but TypeScript errors
- A week later removes the screen; deletes the file; forgets to remove the route entry
- A deep link to the now-dead route 404s in production

With expo-router file convention:
- Developer creates `app/threads/[id].tsx`
- Next dev-server reload picks it up; `/threads/<id>` is live
- Removes the file; the route ceases to exist; no orphan registration to clean up
- The file tree on disk IS the source of truth — there's no second map to drift

The filesystem is the router.

---

## How it works

A library where the shelves ARE the catalogue. There's no index card system telling you which book is in which row — the row a book sits in IS its address. Want to know the library's entire layout? Walk the shelves. expo-router does this for screens: the `app/` directory's tree of files IS the route map, and adding a route is the same gesture as creating a file.

### The route convention — file path equals URL path

`app/index.tsx` renders `/`. `app/todos.tsx` renders `/todos`. `app/journal/[date].tsx` renders `/journal/:date` with `date` becoming a dynamic param. The bracket convention `[param]` is the only syntax the framework cares about; everything else is the filesystem doing the work. If you're coming from frontend, this is the same idea as Next.js's `pages/` directory or Remix's `routes/` directory — same convention, same trade. Concrete consequence: a developer wants to add a `/threads/:id` screen. They create `app/threads/[id].tsx`. No router config, no route table edit, no manual import. The next dev server reload picks up the new file. Inside the component, `useLocalSearchParams<{ id: string }>()` reads the param. Boundary: this assumes the file convention is followed exactly — a file at `app/threads/show.tsx` would create `/threads/show`, not the dynamic `:id` route the developer intended. The bracket is load-bearing.

### Layouts — `_layout.tsx` at every level wraps its children

`_layout.tsx` files are special: at any directory level, the `_layout.tsx` wraps everything below it. The root `app/_layout.tsx` wraps the entire app — it's the boot path. `app/(main)/_layout.tsx` (if it exists) wraps every screen in the `(main)` group. Think of it like React Router's `<Outlet />` in a parent route, or Next.js's `layout.tsx` files — the same composition pattern. Concrete consequence: the root `app/_layout.tsx` runs `useDatabase()` (initialises SQLite, runs migrations, sets up the connection pool), runs `bootstrap()` for cloud sync ([10-bootstrap-decision-tree](./10-bootstrap-decision-tree.md)), and wraps the rest of the tree in `<GestureHandlerRootView>`, theme provider, font loader, and the navigation stack. Every screen below sees a ready DB, a converged sync state, and the gesture system. Boundary: if the root layout's async setup throws (e.g. SQLite can't open), the entire tree never mounts. There's no "render the screen anyway with a broken DB" fallback because every screen depends on the DB being ready.

### Dynamic params — `[date]` resolves at runtime

`app/journal/[date].tsx`'s param `date` resolves to whatever string is in the URL slot. The component reads it via `useLocalSearchParams<{ date: string }>()` — a typed React hook from expo-router. If you're coming from frontend, this is the same shape as Next.js's `useParams()` or React Router's `useParams()`. Concrete consequence: the dashboard's "open today's entry" navigation calls `router.push('/journal/2026-05-10')`. Expo-router resolves this to `app/journal/[date].tsx` with `date = '2026-05-10'`. The component runs `useEntries(date)` to fetch the matching SQLite row. Closing the screen pops the navigation stack back to whatever pushed it. Boundary: the param is always a string — coercion to Date or number happens in the component. A malformed param (e.g. `/journal/not-a-date`) doesn't throw at the routing layer; the component is responsible for handling it (usually by returning an empty entry or rendering an error state).

### Navigation — `useRouter().push()` and hardware back

There's no manual route table, no `<Link to={...}>` requiring registration, no `routes.ts` file mapping names to components. Navigation is just `useRouter().push('/path')` where `/path` is the file path under `app/` minus the extension. Hardware back on Android pops the stack back to the previous file — Expo-router maintains the stack automatically based on push history. Think of it like the browser's history stack, except the entries are file paths instead of URLs. Concrete consequence: a screen at `app/threads/[id].tsx` shows a list with each row calling `router.push('/journal/2026-05-10')`. The user enters the journal, hits back on the device, lands at `/threads/<id>` again. No `goBack()` plumbing in the component code — the system handles it. Boundary: deep linking from outside the app (e.g. opening a push notification's link) goes through the same `router.push` API but with the URL coming from the OS — same code path, different trigger.

This is what people mean by "convention over configuration for routes." The file system IS the source of truth; there's no map between names and components because the names ARE the components' paths. Every framework that has ever made routing pleasant — Next.js, Remix, Astro, SvelteKit, expo-router — has reached for some version of this. The cost is that the file tree's depth is the route depth, which can produce deep folders; the win is that "where does this route live?" never has a wrong answer. The full picture is below.

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

We traded route-level abstraction for a registry that can never drift: the file tree IS the route table, and at ~15 screens the abstraction cost is invisible.

### Comparison table — both costs in one frame

```
┌──────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Cost dimension   │ Path taken (file-as-route)   │ Alternative (React Navigation│
│                  │                              │  + manual route registry)    │
├──────────────────┼──────────────────────────────┼──────────────────────────────┤
│ Drift risk       │ zero — file IS the registry  │ real — registry and screens  │
│                  │                              │ can diverge silently         │
│ Code surface     │ ~15 files in app/            │ ~15 files + 1 routes.ts +    │
│                  │ no central config            │ navigator declarations       │
│ Type-safety on   │ via useLocalSearchParams<T>()│ via typed RootStackParamList │
│ params           │ generic — declared at use    │ — centralized                │
│ Param parsing    │ always string at first read; │ same — params are strings    │
│                  │ parse + validate downstream  │ until parsed                 │
│ Shared behaviour │ via _layout.tsx wrappers     │ via navigator-level options  │
│                  │ scoped by directory          │ + screen-options config      │
│ Refactor URL     │ rename file in repo →        │ edit routes.ts → screens     │
│                  │ history-aware tools (`git mv`│ unchanged → less history     │
│                  │ helps)                       │ disruption                   │
│ Deep nesting     │ awkward beyond 2–3 levels    │ first-class — navigators     │
│                  │                              │ compose explicitly           │
│ Onboarding       │ "open app/ to see routes"    │ "open routes.ts to see       │
│                  │                              │ routes" + read navigators    │
│ Fits ~15 screens │ yes — zero ceremony          │ overkill                     │
│ Fits 200 screens │ awkward — shared behaviour   │ first-class — registry +     │
│                  │ duplicated across files      │ navigator-level abstraction  │
└──────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### What we gave up

Sharing behaviour across many routes is awkward. There's no central place to declare "every settings screen gets this header" — instead, `app/settings/_layout.tsx` wraps the settings subtree, and any shared behaviour lives there. For ~15 screens distributed across 6 directory groups, this cost is invisible. At 200 screens it would mean ~15 `_layout.tsx` files for each scope plus duplication where scopes overlap.

Refactoring URLs requires renaming files, which messes with git history. `app/todos.tsx` → `app/tasks.tsx` is a 1-line file move but every prior `git log` for that file requires `--follow`. For a one-time rename it's fine; for an app that frequently re-organises its URL scheme, it's friction.

The `_layout.tsx` chain runs synchronously on cold start — root layout opens SQLite (~50ms), loads fonts (~100ms), wraps providers — before any screen mounts. The first interactive frame waits ~300–500ms. For a single-user app this is invisible (I don't notice it); for a public app it would warrant a splash screen or Suspense boundary. The cost is queued for the day a non-me user installs.

### What the alternative would have cost

React Navigation's manual route registry would have meant a `routes.ts` file declaring every screen and its params in a typed `RootStackParamList`, plus navigator declarations stitching them together. ~50 LOC of registry + per-screen registration call + a navigator tree.

In return: type-safety lives in one place (the param list type defines every route's params globally); deep nesting is first-class (you can compose `Stack` inside `Tab` inside `Drawer` explicitly); shared behaviour hangs off navigator-level options. The cost is the registry — which is exactly the source-of-drift we're trying to avoid in the first place. On a 15-screen app, the registry is overhead; on a 200-screen app with nested navigators, it's the right shape.

### The breakpoint

Fine until ~50 screens OR until nested navigation depth exceeds 2 levels. Past that, file-as-route's flat structure becomes a navigation drawer of nested folders that takes longer to visually scan than a typed registry. The fix is React Navigation's manual registry with a typed `RootStackParamList`. Today loopd has 15 screens and 1 level of nesting (e.g. `app/settings/index.tsx`); the registry would be pure overhead.

### What wasn't actually a tradeoff

Hybrid "file-based + manual override for nested cases" wasn't a real option. expo-router does support groups and modals (`(tabs)`, `(modal)` directory conventions) for nested patterns, but combining them with a manual registry means maintaining two routing models in parallel — one for the convention-driven screens, one for the registry-driven escape hatches. The complexity tax is higher than picking one model and living with its limits.

---

## Tech reference (industry pairing)

### expo-router

- **Codebase uses:** `expo-router` 55.
- **Why it's here:** file-based routing drives the entire `app/` directory as the route table with no separate `routes.ts`.
- **Leading today:** `expo-router` — `adoption-leading`, 2026.
- **Why it leads:** file-based routing brings Next.js-style ergonomics to mobile; EAS and Expo ecosystem align on it as the default.
- **Runner-up:** React Navigation — older bare-RN default; larger existing production install base.

---

## Summary

File-based routing is the convention that a directory layout, with naming rules for dynamic segments and shared layouts, defines the application's URL space directly — the filesystem is the router. In this codebase the `app/` directory tree is the route tree under expo-router 55: `app/_layout.tsx` (287 lines) is the boot path that initialises SQLite via `useDatabase`, runs the cloud bootstrap, and wraps providers; `[param]` directories like `app/journal/[date].tsx` define dynamic segments read via `useLocalSearchParams()`; and there is no `routes.ts`. The constraint was that a separate route registry drifts from the actual screens it documents, and convention-as-code keeps the URL and the file as the same fact. The cost is that abstracting behaviour across many routes is awkward — each file imports its own shared bits — but for loopd's ~15 screens that cost is negligible. A 200-route app or one with deeply nested back stacks would push toward React Navigation's explicit registry instead.

Key points to remember:
- `app/_layout.tsx` is the boot path that every route runs through — SQLite open, bootstrap, providers all land here before any screen mounts.
- The file system tree is the route table; there is no `routes.ts` to keep in sync with the screens.
- Lives in step 2 (Request flow) of the system-design checklist.
- Dynamic segments are folder names in `[brackets]` and the param is always a string until you parse it downstream.
- Abstracting behaviour across many routes is awkward — at ~15 screens the cost is negligible, at 200 the registry-based alternative starts paying back.

---

## Interview defense

### What an interviewer is really asking
File-based routing is a Next.js-ism that reads as "I follow the convention." The interviewer wants to know whether you understand what the convention buys you (no separate route table to drift) and what it costs (no easy way to share behavior across routes).

### Likely questions

[mid] Q: A user navigates to `/journal/2026-05-07`. What runs?

A: expo-router maps the URL to `app/journal/[date].tsx`. The `_layout.tsx` at the root runs first (it always does — that's the boot path that initializes SQLite, runs cloud bootstrap, and wraps providers). Then `journal/[date].tsx` mounts and reads the date param via `useLocalSearchParams<{ date: string }>()`. The component then queries the entry for that date through `useEntries.getEntryByDate(date)`. The whole chain is file-system-driven; there's no `routes.ts` to keep in sync.

```
[/journal/2026-05-07 navigation]

  URL: /journal/2026-05-07
        │
        ▼  expo-router resolves at build time
  app/_layout.tsx  (root boot path — runs on every route)
        │   opens SQLite, runs cloud bootstrap, wraps providers
        ▼
  app/journal/[date].tsx  (matched by directory + param)
        │   const { date } = useLocalSearchParams<{ date: string }>()
        ▼
  useEntries.getEntryByDate("2026-05-07")
        │
        ▼ render
  UI shows the journal entry for that date
```

[senior] Q: What's the cost of file-based routing on a small app like this?

A: Surprisingly little, because the app is small. The cost shows up in two places: first, every screen has to import its own version of shared header/footer components — there's no central route definition where you'd hang shared layout, except via `_layout.tsx` files. Second, refactoring URLs requires renaming files, which messes with version control history. For loopd's ~15 screens, both costs are negligible. If the app had 200 routes I'd reconsider; at this scale, file-as-route is the cheaper option.

```
                  Path taken (file-as-route)            Alternative (React Navigation
                                                          + routes.ts)
                  ──────────────────────────────        ──────────────────────────────
route registry    file tree (no drift possible)         routes.ts (drifts from screens)
shared behaviour  per-directory _layout.tsx wrappers    navigator-level options
type-safety       useLocalSearchParams<T>() per screen  typed RootStackParamList globally
file count today  15 screens + ~3 _layout.tsx files     15 screens + 1 routes.ts +
                                                          navigator declarations
refactor URL      rename file (git history split)       edit routes.ts (screens unchanged)
ceremony per     "create file → it's a route"          "create file + register +
 new screen                                              navigator option"
right call when   small flat nav (15 screens, ≤2       deep nested nav, 50+ screens,
                  levels)                                or shared behaviour matters
this codebase     yes — flat enough, registry would    no — would add ceremony for
                  be overhead                            features the app doesn't need
```

[arch] Q: How does this compare to React Navigation's manual route configuration, and when would you switch?

A: React Navigation uses an explicit route registry — you declare every screen and its params in a typed config. The win is type-safety on params and centralized navigation logic; the cost is a registry that drifts from the actual screens. expo-router takes the inverse: file structure is the registry, type-safety on params is via `useLocalSearchParams<T>()` generics. I'd switch to React Navigation if I needed deeply nested navigators with complex stack/tab interactions — file-based routing handles flat plus simple nested fine, but multi-level nested back stacks get awkward. loopd's navigation is flat enough that file-based wins.

```
At 50+ screens OR nested navigation depth > 2 levels:

  ┌─ UI / app surface ──────────────────────────┐
  │ unchanged — screens still render the same   │
  └─────────────────────────────────────────────┘
              │
  ┌─ Routing layer ─────────────────────────────┐
  │ file tree depth grows; mental scan slows    │  ◀── BREAKS FIRST
  │ shared behaviour duplicated across many     │     (nav drawer of nested folders
  │ _layout.tsx files                            │      takes longer to read than
  │ multi-level nested back stacks ergonomically │      a typed registry)
  │ awkward                                       │
  └─────────────────────────────────────────────┘
              │
  ┌─ Migration target ──────────────────────────┐
  │ React Navigation + typed RootStackParamList │
  │ + explicit navigator composition            │
  │ + screen-options at navigator level          │
  └─────────────────────────────────────────────┘
              │
  ┌─ Storage / data layer ──────────────────────┐
  │ unchanged — useDatabase, useEntries the same│
  └─────────────────────────────────────────────┘
```

### The question candidates always dodge
Q: Your `_layout.tsx` initializes SQLite, runs the cloud bootstrap, and loads fonts. What happens to the user's first frame while all of that is happening?

A: It's a blank screen for the duration. SQLite open is fast (~50ms on Android), font loading is ~100ms, cloud bootstrap is fire-and-forget (it returns immediately and resolves async). The total cold-start to first interactive frame is around 300-500ms in my testing. That's slow enough that I should show a splash or skeleton, but I haven't because the app is single-user-mine and I don't notice it. The honest answer is the boot path is doing too much synchronously and the user's first frame pays the price; the fix is moving SQLite open into a background-resolved promise that the first screen awaits with a Suspense boundary, which is half a day of work I haven't done because I'm the only user. It's queued for the day a non-me user installs.

```
                  Path taken (blank screen 300–500ms)   Suggested (splash + Suspense)
                  ──────────────────────────────        ──────────────────────────────
first frame       blank, then first screen mounts       branded splash, then first screen
user experience   "is the app frozen?" at slow boots    visible feedback during init
cost today        ~ms blank — invisible to me           ~half-day of work to ship
                  (single user)                         (splash + Suspense + skeleton)
fail case         user thinks app is broken at first    no user-visible failure path
                  cold start on slow device
worsens at        slower device, larger SQLite          unchanged — splash is constant cost
                  initial state, font cache miss
right today?      yes for me (single user)              no for me, yes for any non-me user
ship trigger      a real user installs                  same
queued?           yes — "first non-me user install"     n/a
honest cost       0 LOC + bad UX                        ~30 LOC + clean UX
```

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
Updated: 2026-05-10 — Quick summary moved to after Tradeoffs and reshaped to v1.19.0 recap form (paragraph + key-point bullets).

---
Updated: 2026-05-10 — v1.20.0 swap: moved primary diagram to after How it works (now the recap visual); rewrote Why care handoff sentence; appended How-it-works handoff to the diagram.

---
Updated: 2026-05-10 — v1.21.0 pass: renamed Quick summary → Summary; expanded Tradeoffs into comparison table + 4 sub-blocks; added per-answer diagrams in Interview defense Q&As; added comparison diagram to dodge Q&A.

---
Updated: 2026-05-10 — v1.22.0 tech-stack-rule pass: added industry-leader pairing block at end of Tradeoffs for expo-router.

---
Updated: 2026-05-10 — v1.23.0 pass: promoted Tech reference from H3 inside Tradeoffs to dedicated H2 section between Tradeoffs and Summary; reformatted ASCII boxes as `###` per-tech subsections with five labelled bullets.

---
Updated: 2026-05-10 — v1.24.0 pass: restructured How it works into three moves (library-shelves-as-catalogue metaphor opening / 4 layered sub-sections — file path equals URL, _layout.tsx wrapping, dynamic params, useRouter + hardware back — each with frontend bridges and concrete consequences / principle paragraph on convention-over-configuration routing).

---
Updated: 2026-05-13 — v1.30.0 pass: restructured Why care into five-move form (library-where-shelves-are-the-catalogue scenario → file-based routing named as the answer → bolded "what depends on getting this right" with `app/`-tree + `[date]` + `_layout.tsx` stakes → before/after walking add-and-remove-a-screen with a manual route table → one-line "the filesystem is the router").
