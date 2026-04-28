# 03 — Frontend engineering

> **The home turf.** As a frontend specialist transitioning to senior roles, this chapter is where I should sound most fluent and where the interviewer's questions will go deepest. The state model is the heart of it.

The frontend in loopd is React Native + Expo, file-routed via `expo-router`. Anyone with React experience reads it without trouble — most of the patterns transfer one-for-one. What's not standard is the state model. Most apps put input values in `useState` and call it a day. loopd doesn't, because that pattern lost data in past versions of this app.

The model is three-tier. Refs hold ephemeral state — the cursor position, the "did the user just type a character" flag, the live text mid-typing. React state holds what needs to render — the entry list, the filter chips, the modal open/closed state. SQLite holds what needs to be durable — the actual bytes of every journal entry. These three layers update on every keystroke, but they update in a deliberate order: refs and SQLite first, React state last. When focus cleanup races an idle timer, the bytes have already landed in SQLite, so even if the React tree unmounts mid-word, nothing is lost.

```
              State on every keystroke

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
  │          │  │              │  │              │  │            │
  └──────────┘  └──────────────┘  └──────────────┘  └────────────┘
       │              │                  │                │
       ▼              ▼                  ▼                ▼
   triggers       pending value      bytes safe        NO  — scanners
   re-render      for blur logic     even if React     only fire on
   of <Text>      (cleanup safe)     unmounts mid-     commit (blur,
                                     word               navigate)

  Refs and SQLite write *before* React state.
  Past data-loss bugs were races between focus cleanup
  and idle timers — both writing through React state
  out-of-order. DB-first writes ended that class of bug.
```

The other thing worth knowing about the UI is the use of `forwardRef` + `useImperativeHandle` to expose typed imperative methods on `InlineTextInput`. Most React code lifts state up when a parent needs to mutate a child. I don't, because the things the parent needs to do — insert `[] ` at the cursor, replace a partial query with a canonical food name — are inherently imperative cursor operations that *don't belong in React state*. The handle exposes exactly two methods (`appendText`, `replaceRange`) and nothing else. It's a deliberate, narrow escape hatch.

## Interview questions

### Q1 [mid] How is state managed in the journal editor?

Three tiers. Refs for ephemeral state (cursor, focus flags, the live text value mid-typing). React state for what needs to render. SQLite for durability.

The most subtle piece is `liveTextRef` in [`app/journal/[date].tsx`](../../app/journal/[date].tsx) — a `useRef` that mirrors the TextInput value on every keystroke without triggering a re-render. The reason it exists is documented in [`CLAUDE.md`](../../CLAUDE.md): past versions of this app put text in `useState` and lost characters because React renders interleaved with focus-cleanup effects. The current pattern keeps the React tree stable while the underlying bytes are durable from keystroke one. It's a small thing that took a real incident to learn.

### Q2 [senior] How does the autocomplete work? You don't have a third-party drag-drop library or a popover system.

`InlineTextInput` exposes a typed imperative handle via `forwardRef` + `useImperativeHandle` at [`InlineTextInput.tsx:23-26`](../../src/components/journal/InlineTextInput.tsx#L23-L26). The handle has two methods: `appendText(str)` and `replaceRange(start, end, replacement)`. The journal screen owns a `useRef<InlineTextInputHandle>(null)` and watches `onSelectionChange` events.

When the cursor sits after `** ` on the active line, the journal screen detects it via simple substring inspection, opens [`NutritionAutocomplete`](../../src/components/journal/NutritionAutocomplete.tsx) with the partial query, and on chip-tap calls `inputRef.current?.replaceRange(...)` to insert the canonical `<food> 320 kcal ` string at the right position. The autocomplete itself is just a horizontal scroll of chips — no virtualization, no popover library.

The reason I used imperative handles instead of lifting state up: the parent has no business knowing the cursor position or the textarea's internal selection — those are owner-private. Lifting that state would have leaked everything just to expose two operations. The handle is a typed contract that exposes exactly what the parent needs and nothing else. It's the pattern Linear's editor uses, the pattern Notion uses, and it's the right fit when the child has imperative cursor semantics.

### Q3 [arch] How does this stay performant when an entry has hundreds of `[]` lines and a user has thousands of todos?

Honest answer: I haven't optimized for that scale and probably need to.

The scanner at [`scanTodos.ts:53-125`](../../src/services/todos/scanTodos.ts#L53-L125) is `O(L + E)` per pass where `L` is the lines in the entry and `E` is existing todos. That stays fine — single-entry parsing tops out in single-digit milliseconds even at thousands of lines.

The problem is the render path on `/todos`. It flattens every todo across every entry on every focus change, joins with `todo_meta` in JS via a Map, and renders a non-virtualized `ScrollView`. For ≤500 todos this is invisible. At 5,000 it would jank visibly during scroll. Three changes I'd make:

1. Replace `ScrollView` with [`FlashList`](https://shopify.github.io/flash-list/) from Shopify — virtualized list-of-record optimized for React Native.
2. Move the sort + filter to a `useMemo` keyed only by `entries.length + metas.size + status + category` so it doesn't re-run on unrelated state changes.
3. Track `entries.updated_at` and only re-scan changed entries — the current implementation re-scans everything on every focus.

The principle: profile before you optimize. My current data set is small enough that doing this work now would be speculative. At a job, with a real user load, I'd measure and then make these moves with confidence.

## The hard question

> "You have no virtualized list, no test suite, and you're rendering an unbounded JS-side sort. How fast does this break in production?"

At ~500 todos per user, the user feels nothing. At 2,000 the scroll has a small initial frame stutter. At 5,000 the page is visibly slow on lower-end Android devices — Samsung A-series, three-year-old hardware. At 10,000 the page is unusable.

What I'd ship to fix it, in order of effort: (1) `FlashList` swap is half a day. (2) `useMemo` keying on the right dependencies is a few hours. (3) Incremental scan needs maybe a day plus a test. (4) Pushing the sort to SQL with `LEFT JOIN todo_meta` and proper indexes is two days plus a query rewrite per filter combination.

The honest reason none of this is in the codebase yet: at solo-user scale (my data set) the current implementation is invisible. It would be premature optimization to do speculatively. At a job I'd benchmark first and let the numbers drive the priority. I'm not going to dress this up — the gap is real, the fixes are obvious, and I can articulate the right sequence. That's the senior-engineer signature: knowing what's wrong, what to do about it, and when to actually do it.

→ [04 — Backend and API design](./04-backend-api.md)
