# Chapter 10 — What I'd Do Differently

## Opening — what an honest retrospective looks like

The bad version of this chapter has one of two shapes. The first is "everything was perfect," which is a lie and an interviewer recognizes it instantly. The second is "I regret all of it," which signals either lack of conviction or theatrical humility — neither of which is a good signal. The honest version: name the calls that were reasonable at the time but I'd change now, name the ones I'd fix first if I had a week, and name the ones I'd leave alone even though they look weird at first glance.

Three things drive what I'd change. The first is hindsight on cost — the Notion sync layer (deleted in commit `dc8483a`) ate weeks of work and produced a worse architecture than the Supabase sync that replaced it. The second is observation of friction — the orchestrator's hand-maintained push/pull order arrays catch me every time I add a synced table. The third is awareness of risk surface that hasn't materialized — the absence of automated tests for the scanners is a reliability gap I haven't paid for yet, but I will.

Three things I would *not* change despite their quirkiness. The lack of a frontend state library is correct given the canonical-DB architecture and I'd resist any pressure to add one. The decision to make the journal a TextInput per entry rather than a ContentEditable rich editor is correct because rich editors fight you on Android in subtle ways and the prose-canonical model only needs plain text. The choice to commit the prebuilt `android/` directory looks weird to anyone who hasn't shipped a custom-native Expo app but is right for the platform constraints.

---

## What I'd do differently

### 1. Build a property-based test harness for the scanners on day one.

The three scanners (`scanTodosFromText`, `scanNutritionForEntry`, `parseTags` + `scanThreadMentionsForEntry`) are pure functions over text and existing typed rows. They are the easiest possible test surface — no React, no DB, no async, no provider keys. A property-based test using `fast-check` could exercise the two-pass matching invariant (input text + existing rows → output rows preserve identity for unchanged lines) on randomized inputs in milliseconds.

I shipped without this and have caught zero real bugs in the wild because of it, but every refactor of the scanners has been nervous. The cost of building it is one focused day; the cost of *not* having built it is a constant low tax on every change. I'd flip that on day one of a hypothetical do-over.

### 2. Replace the hand-maintained sync orchestrator order arrays with a topological sort.

`src/services/sync/orchestrator.ts` has `pushOrder` and `pullOrder` as two literal arrays of table names. Adding a synced table means editing both arrays and remembering FK constraints. A `SyncableTable.dependsOn: string[]` field plus a topological sort at boot would make this self-organizing. The smell is that every current adapter file already knows its FK dependencies (the upsert SQL implies them); the orchestrator config is duplicate state.

Cost to fix: an hour. I haven't done it because the current arrays have ten entries and fit on the screen. Marked in chapter 8 as "the worst code in this codebase." I'd fix it before the eleventh table lands.

### 3. Move the AI provider keys server-side before any multi-tenant launch.

Every device today holds its own Anthropic / OpenAI key in `expo-secure-store`. For a personal app this is fine; for any multi-user surface, the architecture has to flip. The keys belong on a server (Cloudflare Worker or Supabase Edge Function) where rate limiting, cost tracking, and prompt versioning can centralize. The device sends `{prompt, todoId}` and gets back `{output, usage}`.

I'd build this before Phase B (auth, RLS, paid tier). Doing it earlier would be premature; doing it after launch would require migrating users off device-stored keys, which is messy. The right window is "before paying users."

### 4. Add Sentry (or equivalent) before launching to anyone but me.

The current observability story is `console.warn` and `adb logcat`. That's fine for a single user who has the device in their hand. For anyone else, errors are invisible — if a user reports "the journal lost a paragraph" I have no telemetry to validate or invalidate it. Sentry's free tier covers this, the SDK install is one file, and the cost-of-operation is zero.

Tied for first with the property-based scanner tests as "what I'd flip on day one." I haven't done it because the surface area to monitor is small (the scanners, the sync push, the LLM calls) and I'm the only user, but as soon as a second user signs up, this becomes mandatory.

### 5. Spec the relatable-caption forbidden-pattern list as a structured config, not prompt text.

`src/services/ai/caption.ts` (and `docs/relatable-caption-spec.md`) has a list of forbidden patterns ("hustling energy," "generic platitudes") embedded in the system prompt. When I want to add a new forbidden pattern, I edit the prompt string — and I have no eval to confirm the new pattern actually shifted the output distribution.

I'd extract the patterns into a structured config, generate the prompt text from the config, and write a small eval harness that runs the existing prompt + a candidate prompt against a fixed set of inputs and reports the diff. This is the prompt-engineering equivalent of property-based tests for the scanners — a small one-time investment that pays off every time I tune the prompts. Same shape as the scanner tests; different layer.

---

## What I'd leave alone

### 1. The lack of a frontend state library.

I'm asked "why no Redux/Zustand?" enough that I have a stock answer in chapter 2. The decision is correct: the canonical state is SQLite, hooks per screen refetch on focus, no cross-screen state needs lifetime longer than a route mount. Adding a store would create two sources of truth (memory + DB) and require synchronization logic that's currently free.

The day I'd reconsider: when I have a third piece of cross-screen-persistent state. Today there's one (the export pipeline progress, which lives in the editor's component state). Adding the store for one outlier is over-engineering.

### 2. The `entries.text` as a single TextInput per row.

Looks naive. "Why not a rich editor with markdown rendering and inline icon support?" Because rich editors on Android fight you on subtle behaviors — cursor position after autocomplete insert, IME composition state during the keystroke, paste handling that doesn't break my line-index assumptions. The plain TextInput is boring and reliable; the autocompletes (NutritionAutocomplete, TagAutocomplete) handle the smart parts as siblings.

The day I'd reconsider: when the prose-canonical model needs structured rendering inline (e.g., `[]` rendering as a pretty checkbox glyph rather than literal characters). At that point I'd use a TextInput with inline overlay rendering rather than a true rich editor — the prose itself stays plain.

### 3. The decision to commit the prebuilt `android/` directory.

Anyone who hasn't shipped a custom-native Expo app sees this and asks why. It's because `@wokcito/ffmpeg-kit-react-native` and the SQLite native module need config that the Expo managed workflow can't apply. Committing `android/` keeps "clone, install, run" as the dev experience instead of "clone, install, prebuild, hope it works."

The day I'd reconsider: when Expo's Continuous Native Generation supports the FFmpeg module's config natively (which is on Expo's roadmap but not shipped). Until then, the committed `android/` is the right call.

### 4. The use of LWW for cross-device sync conflicts.

Looks lazy. "Why not a real CRDT for the journal text?" Because LWW resolves >99% of conflicts correctly at the device-count and edit-frequency this app actually sees, and a real CRDT would: triple the implementation complexity, add per-character merge metadata to every text column, and invalidate the simple `(user_id, id)` upsert on the cloud side. The constraint that distinguishes them is conflict frequency: LWW is good enough until conflict frequency makes it visibly bad.

The day I'd reconsider: when telemetry shows real cross-device conflicts on `entries.text` happening more than once per user per month. Until I have telemetry, I can't measure this — see "add Sentry."

### 5. The decision to keep the Notion sync code deleted.

Some users would want it back. I won't bring it back. The reasons it failed are structural (rate limits, page-vs-row mismatch, bidirectional canonical confusion) and bringing it back would mean fighting the same fights. The Notion-shaped users can use the export feature (which would write to a Notion-importable format if I built it; that's on the backlog) but the sync layer is gone for good. The architectural principle "cloud is a sync mirror, never canonical" was the lesson; bringing back two-way sync to a non-canonical store would violate it.
