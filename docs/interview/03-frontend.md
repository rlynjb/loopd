# 03 — Frontend engineering

> **The home turf.** As a frontend specialist transitioning to senior roles, this chapter is where I should sound most fluent and where the interviewer's questions will go deepest. The state model is the heart of it.

The frontend in loopd is React Native + Expo, file-routed via `expo-router`. Anyone with React experience reads it without trouble — most of the patterns transfer one-for-one. What's not standard is the state model. Most apps put input values in `useState` and call it a day. loopd doesn't, because that pattern lost data in past versions of this app.

The model is three-tier. Refs hold ephemeral state — the cursor position, the "did the user just type a character" flag, the live text mid-typing. React state holds what needs to render — the entry list, the filter chips, the modal open/closed state. SQLite holds what needs to be durable — the actual bytes of every journal entry. These three layers update on every keystroke, but they update in a deliberate order: refs and SQLite first, React state last. When focus cleanup races an idle timer, the bytes have already landed in SQLite, so even if the React tree unmounts mid-word, nothing is lost.

The dashboard added a second axis of complexity in late April: the **DAILY SCHEDULE** tracker (§6.7 of the spec) renders habits and threads as a single list of structurally identical rows — 80px name + flex 14-cell strip + 36px right-side affordance — bucketed by `time_of_day`. Habit cells distinguish four states (`completed`, `missed`, `today-pending`, `neutral`) instead of the old two; thread cells light up only on manual-touch toggles. Two row types, one layout, one mental model.

```
              State on every keystroke + the autocomplete handle

                  User types one character
                            │
                            ▼
                ┌────  TextInput onChangeText  ────┐
                │                                  │
        ┌───────┴──────┐                  ┌────────┴──────┐
        ▼              ▼                  ▼               ▼
  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐
  │  React   │  │ liveTextRef  │  │   SQLite     │  │  scanner   │
  │  state   │  │    (ref)     │  │ (silentSave) │  │  triggers? │
  └──────────┘  └──────────────┘  └──────────────┘  └────────────┘
       │              │                  │                │
       ▼              ▼                  ▼                ▼
   triggers       pending value      bytes safe        NO  — scanners
   re-render      for blur logic     even if React     only fire on
   of <Text>      (cleanup safe)     unmounts mid-     commit (blur,
                                     word               navigate)

       │                                                  selection?
       ▼                                                       │
  onSelectionChange  ──────────────►  marker probe (** | #tag) ┘
                                                │
                            ┌───────────────────┴─────────────────┐
                            ▼                                     ▼
              ┌─────────────────────────┐         ┌─────────────────────────┐
              │ NutritionAutocomplete   │         │  TagAutocomplete        │
              │ chip strip above kbd    │         │  chip strip, same Z     │
              │ tap → replaceRange()    │         │  tap → replaceRange()   │
              └─────────────────────────┘         └─────────────────────────┘
                            │                                     │
                            └────────────►  inputRef  ◄───────────┘
                                            (forwardRef +
                                             useImperativeHandle —
                                             two methods only)

  Refs + SQLite write before React state.
  The two autocompletes share one imperative-handle contract;
  TagAutocomplete is also reused on /todos for new + edit inputs.

              DAILY SCHEDULE tracker (dashboard, §6.7)

  ┌──────────────────────────────────────────────────────────────┐
  │ DAILY SCHEDULE                                    manage →   │
  │ ─ morning ─                                                  │
  │   Yoga          ░ ▓ ▓ · ▓ ▓ ▓ · ▓ ▓ · · ▓ ◌  ◌      ⋯ 12 🔥  │
  │   #onboarding   · · ▓ · · · · ▓ · · · · ▓  ◌      ⋯  →      │
  │ ─ midday ─                                                   │
  │   Walk          ▓ ▓ ▓ ▓ ▓ ░ ▓ ▓ ▓ ▓ ▓ ▓ ▓  ◌      ⋯  47 🔥  │
  │ ─ evening ─                                                  │
  │   Read          ▓ · ▓ · · · ▓ · ░ · · ▓ ◌  ◌      ⋯   3 🔥  │
  │   #book-club    · · · · · · · · · · · · ▓  ◌      ⋯   →     │
  └──────────────────────────────────────────────────────────────┘
   ▓ completed   ░ missed   ◌ today-pending   · neutral
   Mini-headers (morning/midday/…) only render when 2+ buckets
   are populated. Tap a thread row → toggleThreadTouchToday().
   Tap the → arrow → /threads/[id] (OPEN / DONE / ENTRIES).
```

The other thing worth knowing about the UI is the use of `forwardRef` + `useImperativeHandle` to expose typed imperative methods on `InlineTextInput`. Most React code lifts state up when a parent needs to mutate a child. I don't, because the things the parent needs to do — insert `[] ` at the cursor, replace a partial query with a canonical food name, swap `#xy` for `#xyz `  — are inherently imperative cursor operations that *don't belong in React state*. The handle exposes exactly two methods (`appendText`, `replaceRange`) and nothing else. It's a deliberate, narrow escape hatch — and crucially, it's the same contract that `NutritionAutocomplete` and the new `TagAutocomplete` both consume. Two markers, two chip strips, one handle.

## Interview questions

### Q1 [mid] How is state managed in the journal editor?

Three tiers. Refs for ephemeral state (cursor, focus flags, the live text value mid-typing). React state for what needs to render. SQLite for durability.

The most subtle piece is `liveTextRef` in [`app/journal/[date].tsx`](../../app/journal/[date].tsx) — a `useRef` that mirrors the TextInput value on every keystroke without triggering a re-render. The reason it exists is documented in [`CLAUDE.md`](../../CLAUDE.md): past versions of this app put text in `useState` and lost characters because React renders interleaved with focus-cleanup effects. The current pattern keeps the React tree stable while the underlying bytes are durable from keystroke one. It's a small thing that took a real incident to learn.

### Q2 [senior] You shipped a second autocomplete for `#tag` threads in late April. Walk me through how it composes with the nutrition one.

Both consume the same imperative-handle contract on `InlineTextInput` ([`InlineTextInput.tsx:23-26`](../../src/components/journal/InlineTextInput.tsx#L23-L26)) — `appendText(str)` and `replaceRange(start, end, replacement)`. The journal screen owns a `useRef<InlineTextInputHandle>(null)` and watches `onSelectionChange`. On each selection event it probes the active line for a `** ` prefix (nutrition) or a `#` partial token (threads). At most one marker is hot at a time, so the screen renders at most one chip strip above the keyboard toolbar.

[`NutritionAutocomplete`](../../src/components/journal/NutritionAutocomplete.tsx) and the new [`TagAutocomplete`](../../src/components/journal/TagAutocomplete.tsx) are sibling components — same Z order, same horizontal-scroll-of-chips skeleton, same "tap → `replaceRange(...)` on the parent's ref" interaction. `TagAutocomplete` adds two things: it's recency-sorted via `getThreadSuggestions` (LEFT JOIN on `thread_mentions` with NULLS LAST), and it surfaces a `+ create #xyz` chip when the partial doesn't match any existing slug. The create chip writes through to `threads/crud.ts` immediately so the next scan resolves cleanly.

The reason I built it as a sibling instead of a generalized "marker autocomplete" component: the two markers have different data shapes, different ranking heuristics, and different fallback affordances. A generalized component would have meant a config bag, prop drilling, and a single component that knows about both nutrition and threads — leaky. The pattern I'm matching here is "share the contract (imperative handle + chip skeleton), not the component." Same reason `TagAutocomplete` is reused verbatim on `/todos` for both the new-todo input and per-row edit-todo inputs: the contract travels, the component composition stays local.

The reason I used imperative handles instead of lifting state up: the parent has no business knowing the cursor position or the textarea's internal selection — those are owner-private. Lifting that state would have leaked everything just to expose two operations. The handle is a typed contract that exposes exactly what the parent needs and nothing else. It's the pattern Linear's editor uses, the pattern Notion uses, and it's the right fit when the child has imperative cursor semantics.

### Q3 [senior] The dashboard tracker renders habits and threads as one list. How did you keep two different data models behind one row layout?

The trick is that `HabitHeatmapRow` and the thread variant share a layout primitive — 80px name, flex 14-cell strip, 36px right-side — and differ only in two slots: the cell-state computation and the right-side affordance. Habits use the cadence-aware streak math from [`habits/streaks.ts`](../../src/services/habits/streaks.ts) and surface four cell states (`completed` / `missed` / `today-pending` / `neutral`); the right-side shows the streak count. Threads compute `activeDates` as a `Set<string>` of YYYY-MM-DD where the user manually-touched the thread in the last 14 days, render two states (touched / not), and put a `→` nav arrow on the right that routes to `/threads/[id]`.

Bucketing is a separate concern: both row types carry `time_of_day` (`'morning' | 'midday' | 'evening' | 'anytime'`), so the dashboard groups by that field and renders adaptive mini-headers — the headers only appear when 2+ buckets are actually populated, otherwise they'd be visual noise on a sparse list. Within a bucket, habits render before threads.

The deliberate design call: thread cells light up *only* on manual-touch toggles, not on `#tag` prose mentions. Mentions in prose are surfaced on `/threads/[id]` (the ENTRIES section, with line excerpts) — the dashboard's strip is a "did I do this today" indicator, not a "did I write about it" indicator. This is the only documented deviation from Principle 11 ("mentions are derived from prose"): `toggleThreadTouchToday` in [`services/threads/touch.ts`](../../src/services/threads/touch.ts) writes a `thread_mentions` row with NULL `entry_id` and NULL `todo_id`. Justified because the schema permits it, the staleness math composes uniformly across mention shapes, and toggling off cleanly deletes only the manual row.

### Q4 [arch] How does this stay performant when an entry has hundreds of `[]` lines and a user has thousands of todos?

Honest answer: I haven't optimized for that scale and probably need to.

The scanner at [`scanTodos.ts:53-125`](../../src/services/todos/scanTodos.ts#L53-L125) is `O(L + E)` per pass where `L` is the lines in the entry and `E` is existing todos. That stays fine — single-entry parsing tops out in single-digit milliseconds even at thousands of lines. The thread scanner is similar shape on top of code-span masking.

The problem is the render path on `/todos`. It flattens every todo across every entry on every focus change, joins with `todo_meta` in JS via a Map, and renders a non-virtualized `ScrollView`. For ≤500 todos this is invisible. At 5,000 it would jank visibly during scroll. Three changes I'd make:

1. Replace `ScrollView` with [`FlashList`](https://shopify.github.io/flash-list/) from Shopify — virtualized list-of-record optimized for React Native.
2. Move the sort + filter to a `useMemo` keyed only by `entries.length + metas.size + status + category + threadFilter` so it doesn't re-run on unrelated state changes.
3. Track `entries.updated_at` and only re-scan changed entries — the current implementation re-scans everything on every focus.

The principle: profile before you optimize. My current data set is small enough that doing this work now would be speculative. At a job, with a real user load, I'd measure and then make these moves with confidence.

## The hard question

> "You have no virtualized list, no test suite, and you're rendering an unbounded JS-side sort. How fast does this break in production?"

At ~500 todos per user, the user feels nothing. At 2,000 the scroll has a small initial frame stutter. At 5,000 the page is visibly slow on lower-end Android devices — Samsung A-series, three-year-old hardware. At 10,000 the page is unusable.

What I'd ship to fix it, in order of effort: (1) `FlashList` swap is half a day. (2) `useMemo` keying on the right dependencies is a few hours. (3) Incremental scan needs maybe a day plus a test. (4) Pushing the sort to SQL with `LEFT JOIN todo_meta` and proper indexes is two days plus a query rewrite per filter combination.

The honest reason none of this is in the codebase yet: at solo-user scale (my data set) the current implementation is invisible. It would be premature optimization to do speculatively. At a job I'd benchmark first and let the numbers drive the priority. I'm not going to dress this up — the gap is real, the fixes are obvious, and I can articulate the right sequence. That's the senior-engineer signature: knowing what's wrong, what to do about it, and when to actually do it.

One Android-specific pitfall I did fix on 2026-04-29, because it was actually breaking the editor sheets: the persistent `GlobalBottomNav` was occluding the bottom of `HabitEditor` and `ThreadEditor` when the keyboard came up. The fix is a one-liner per sheet — `useSafeAreaInsets()` and `paddingBottom: GLOBAL_NAV_HEIGHT + insets.bottom` on the scroll content — but the lesson is that a global navigation chrome and a per-screen sheet have to negotiate vertical space explicitly; assuming the sheet is the bottom of the screen is the kind of cross-platform assumption that bites you on Android with a gesture bar and a persistent nav.

→ [04 — Backend and API design](./04-backend-api.md)
