---
title: 3rd-plan
category: plans
scope: project
---
# Loopd — Build Plan
> Next.js · React · Netlify · Notion API · v1.0

---

## Project Info

| | |
|---|---|
| **Project** | Loopd — daily self-correcting productivity system |
| **Type** | Personal productivity PWA |
| **Stack** | Next.js 14 (App Router), React, TypeScript, Tailwind CSS |
| **Data** | Notion API — single database, two row types |
| **Deploy** | Netlify (static + API route for Notion proxy) |
| **Auth** | None in v1 — Notion credentials entered in-app via Settings screen, stored in `localStorage` |
| **Status** | Prototype complete · Build planning phase |

---

## 1. Overview

Loopd is a daily self-correcting productivity system where **journaling gives meaning to habits, and habits give evidence to journaling.**

There is one journal per day — not separate plan and reflect screens. The user opens the journal in the morning to set intentions, returns throughout the day with thoughts and realizations, and adds evening reflection when they're ready. Nothing locks. Nothing gates. The journal is a living document for the whole day.

When the user is ready, they tap "Generate improvement" and the engine reads the full journal entry + habit signals to produce 1–2 concrete adjustments for tomorrow. Those carry forward to the next day's home screen.

All data lives in a single Notion database. Notion credentials (token + DB ID) are entered directly in the app via a Settings screen. Before Notion is connected, the app renders empty states on every screen.

> **Core identity:** Loopd helps you understand **why** your habits succeed or fail, then helps you adjust tomorrow.

### The integration model

Habits and journal are one system:

- **Habits** answer: "What did I do?" — streaks, consistency, completion %, visible patterns
- **Journal** answers: "Why did it happen?" — mood context, friction, wins, self-observation, impromptu thoughts
- **Improve** combines both: "What should change next?" — 1 planning adjustment + 1 behavior adjustment

### Key design decisions

- **One journal, not two.** No plan/reflect split. One textarea per day, always editable, always appendable.
- **No locking or phase gates.** No "submit plan" → "unlock reflect". The journal is fluid. Generate improvement whenever you're ready.
- **Auto-save.** Changes persist automatically. No save button. A subtle "✓ saved" indicator flashes after a typing pause.
- **Snapshot is collapsible.** Inside the journal screen, a toggle bar shows quick stats (word count, habits done, mood). Expand for full detail. Stays out of the way when you just want to write.
- **Prompts span the full day.** 5 tabs: Plan, Intention, Thoughts (mid-day captures), Reflect, Habits.

### Already done (prototype)

- All 7 screens: Today, Journal, Improve, Habits, Tracker, History, Settings
- **Unified journal** — one screen, one textarea, always open
- **Journal card on home** — live preview with priority tick-offs, or accent-bordered CTA when empty
- **Collapsible Daily Snapshot** inside journal — priorities done, habits completed/skipped, mood, most consistent habit
- **Habits bar** inside journal — compact pills showing each habit's done/pending status
- **5-tab prompts drawer** — Plan, Intention, Thoughts, Reflect, Habits
- **Auto-save indicator** — "✓ saved" flashes after typing pause
- **Typed improve cards** — each tagged "planning" or "behavior"
- **Habit-aware improve engine** — uses habit completion rate + journal text signals
- Habit CRUD with color picker, frequency selector, 14-day mini heatmap
- Time-of-day aware greeting (morning / afternoon / evening)
- 7-day journal history with expand/collapse day cards + habit summary per day
- Settings screen with Notion credential entry, connection test, and status indicator

---

## 2. Tech Stack

### Frontend

| Layer | Technology | Notes |
|---|---|---|
| Framework | Next.js 14 (App Router) | File-based routing, client components for interactive UI |
| Language | TypeScript | Strict mode |
| Styling | Tailwind CSS | Prototype CSS variables map to Tailwind config |
| State | React state + Context | Hooks cover all data needs |
| Fonts | DM Serif Display + DM Mono + Instrument Sans | Via next/font |

### Backend / Data

| Layer | Technology | Notes |
|---|---|---|
| Database | Notion API | Single database, two row types: `daily-log` and `habit` |
| Credentials | `localStorage` | User pastes Notion token + DB ID into Settings screen |
| Proxy | Next.js API route | Reads credentials from request headers, ~20 lines |
| SDK | @notionhq/client | Handles retries, pagination, TypeScript types |

---

## 3. Data Layer

### Connection flow

```
No credentials in localStorage  →  hooks return null/empty  →  UI shows empty states
Credentials present + connected  →  hooks → data-provider → notion/provider → /api/notion proxy → Notion API
```

### Shared types

```ts
// lib/types.ts

export interface DailyLogEntry {
  id: string
  date: string                // "2026-03-19"
  text: string                // Single journal entry — plans, thoughts, reflections, all in one
  mood: number | null         // 1–5, set/updated anytime during the day
  dailyImprovement: Improvement[]
  completion: 'Yes' | 'Partially' | 'No' | null
}

export interface Improvement {
  icon: string
  title: string
  detail: string
  type: 'planning' | 'behavior'
}

export interface Habit {
  id: string
  name: string
  color: string               // hex: "#4caf7d"
  frequency: 'Daily' | 'Weekdays' | '3x/week' | 'Weekly'
  note: string
  active: boolean
  checkIns: string[]          // ISO date strings: ["2026-03-17", "2026-03-18"]
}

// Computed live from current state — not stored in DB
export interface DailySnapshot {
  priorityCount: number
  prioritiesDone: number
  habitsTotal: number
  habitsCompleted: string[]   // habit names
  habitsSkipped: string[]     // habit names
  mood: number | null
  wordCount: number
}
```

### Connection-aware data provider

```ts
// lib/data-provider.ts

import * as notionProvider from './notion/provider'

function isConnected(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem('loopd_notion_connected') === 'true'
    && !!localStorage.getItem('loopd_notion_token')
    && !!localStorage.getItem('loopd_notion_db_id')
}

export async function getTodayEntry(): Promise<DailyLogEntry | null> {
  if (!isConnected()) return null
  return notionProvider.getTodayEntry()
}

export async function upsertEntry(entry: Partial<DailyLogEntry>): Promise<void> {
  if (!isConnected()) return
  return notionProvider.upsertEntry(entry)
}

export async function getLast7Days(): Promise<DailyLogEntry[]> {
  if (!isConnected()) return []
  return notionProvider.getLast7Days()
}

export async function getActiveHabits(): Promise<Habit[]> {
  if (!isConnected()) return []
  return notionProvider.getActiveHabits()
}

export async function createHabit(habit: Omit<Habit, 'id' | 'checkIns'>): Promise<Habit> {
  if (!isConnected()) throw new Error('Not connected to Notion')
  return notionProvider.createHabit(habit)
}

export async function updateHabit(id: string, updates: Partial<Habit>): Promise<void> {
  if (!isConnected()) return
  return notionProvider.updateHabit(id, updates)
}

export async function toggleCheckin(habitId: string, date: string): Promise<void> {
  if (!isConnected()) return
  return notionProvider.toggleCheckin(habitId, date)
}
```

### Auto-save behavior

The journal auto-saves after a typing pause (~800ms debounce). On save, call `upsertEntry({ text, mood })` to patch the current day's row. No save button. The UI shows a brief "✓ saved" indicator that fades after 1.5s.

On page load, `getTodayEntry()` returns the existing entry if one exists. The textarea populates with the stored text. The user picks up where they left off.

### Empty states (when not connected)

| Screen | Empty state |
|---|---|
| Today / Home | "Connect Notion to start your daily loop" + link to Settings |
| Journal | "Connect Notion in Settings to start writing" |
| Improve | Only reachable from journal — no empty state needed |
| Habits | "No habits yet — connect Notion in Settings" |
| Tracker | "Nothing to track yet — connect Notion" |
| History | "No entries yet — connect Notion" |

---

## 4. Notion Database Schema

**One database. Two row types** differentiated by a `Type` select property.

### Row Type: `daily-log`

| Property | Type | Notes |
|---|---|---|
| Name | Title | Date string: `"2026-03-21"` — page title |
| Type | Select | Always `daily-log` |
| Date | Date | ISO date — unique per day, used for querying |
| Text | Rich Text | The full journal entry for the day — plans, thoughts, reflections, everything |
| Mood | Select | 1–5: flat / ok / good / great / fired up. Updated anytime. |
| Daily Improvement | Rich Text | JSON: `[{icon, title, detail, type}]` — type is `"planning"` or `"behavior"` |
| Completion | Select | Yes / Partially / No |

### Row Type: `habit`

| Property | Type | Notes |
|---|---|---|
| Name | Title | Habit name: `"Morning run"` |
| Type | Select | Always `habit` |
| Color | Select | Pre-populate: `#4caf7d`, `#5b8fe8`, `#d4922a`, `#c46fd4`, `#e05555`, `#e8d5b0` |
| Frequency | Select | `Daily` / `Weekdays` / `3x/week` / `Weekly` |
| Note | Rich Text | Optional context |
| Active | Checkbox | Soft delete |
| Check-ins | Rich Text | JSON: `["2026-03-17","2026-03-18"]` |

### Key schema change from previous plan

The old plan had separate `Plan`, `Reflect`, `Mood Morning`, `Mood Evening`, and `Lesson` fields. The unified journal replaces all of these with a single `Text` field and a single `Mood` field. Simpler schema, simpler data flow, same information captured.

---

## 5. Screen Responsibilities

7 screens total. No plan/reflect split. No phase gates.

### Today / Home — the hub

**Purpose:** Dashboard where journal and habits meet. One journal card, habit check-ins, yesterday's carry-over.

**Journal card behavior:**
- Empty: accent-bordered CTA — "Tap to start writing — plan, reflect, think, anytime." Clicking opens journal.
- Has content: preview of text (first ~120 chars), priority tick-offs from `-` prefixed lines, mood emoji, word count. Clicking opens journal.

**Reads:** today's `DailyLogEntry`, active habits + check-ins, yesterday's `dailyImprovement`

**Writes:** habit check-in toggles, priority tick state (client-side only)

### Journal — the unified writing surface

**Purpose:** One textarea for the whole day. Open in the morning to plan, return at lunch with a thought, add evening reflection. Always editable.

**Key elements:**
- Time-of-day label (morning / afternoon / evening)
- Mood picker (single mood, updated anytime — not morning/evening split)
- Collapsible snapshot (priorities done, habits done/skipped, mood, most consistent habit)
- Habits bar (compact pills showing done/pending per habit)
- Prompts drawer with 5 tabs: Plan, Intention, Thoughts, Reflect, Habits
- Auto-save on typing pause
- "Generate improvement →" button always available in footer

**Reads:** today's `DailyLogEntry`, active habits + check-ins

**Writes:** `text` and `mood` on today's `DailyLogEntry` (auto-save on debounce)

### Improve — generated adjustments

**Purpose:** Convert journal + habit signals into 1–2 improvements for tomorrow.

**Inputs to improve engine:**
- Full journal text (text heuristics for overcommitment, low energy, positive signals)
- Mood value
- Habit completion rate + skipped habit names
- Journal word count (brevity signal)

**Outputs:** 1–2 `Improvement` objects, each tagged `planning` or `behavior`

**Reads:** today's `DailyLogEntry`, active habits, check-ins

**Writes:** `dailyImprovement` on today's `DailyLogEntry`

### Habits — CRUD management

**Purpose:** Create, edit, archive habits. Not for daily check-ins (that's on Home).

### Tracker — visualization

**Purpose:** 28-day heatmap per habit. Streaks, completion %, best streak.

### History — journal history

**Purpose:** 7-day expandable history. Each day card shows: journal text, mood, improvement, and habit summary (completed/skipped chips).

**Key behavior:** Habit chips per day computed by cross-referencing each habit's `checkIns` array against that day's date.

### Settings — Notion connection

**Purpose:** Connect/disconnect Notion. Token + DB ID input, connection test, status indicator.

---

## 6. App Architecture

### 6.1 Directory Structure

```
app/
├── page.tsx                      # Today / Home dashboard
├── journal/page.tsx              # Unified journal (write/edit today's entry)
├── improve/page.tsx              # Improve results screen
├── history/page.tsx              # 7-day journal history + habit summary per day
├── habits/page.tsx               # Habits CRUD list
├── tracker/page.tsx              # 28-day habit tracker
├── settings/page.tsx             # Notion credentials form + connection status
└── api/
    ├── notion/route.ts           # Proxy — reads credentials from request headers
    └── notion/test/route.ts      # Connection test endpoint

lib/
├── types.ts                      # DailyLogEntry, Habit, Improvement, DailySnapshot
├── data-provider.ts              # Connection-aware wrapper — returns empty when disconnected
├── snapshot.ts                   # computeSnapshot(text, habits, checkins, mood) → DailySnapshot
├── notion/
│   ├── provider.ts               # All Notion read/write functions
│   ├── daily-log.ts              # getTodayEntry, upsertEntry, getLast7Days
│   ├── habits.ts                 # getActiveHabits, createHabit, updateHabit, toggleCheckin
│   └── transforms.ts             # Notion API response → app types
└── improve-engine.ts             # Journal text + habit signals → Improvement[]

components/
├── journal/                      # JournalTextarea, PromptsDrawer, MoodPicker, SnapshotToggle, HabitsBar
├── home/                         # JournalCard, HabitCheckinList, ImproveCarry, StatsBar
├── habits/                       # HabitRow, HabitModal, MiniHeatmap
├── tracker/                      # FullHeatmap, StreakStats, TrackerBlock
├── history/                      # DayCard, DaySection, HabitSummaryChips
├── improve/                      # ImproveCard, ImproveBadge
├── empty/                        # EmptyState, ConnectPrompt
└── ui/                           # Button, Card, NavBar, TopBar, Modal

hooks/
├── useConnection.ts              # Reads localStorage, provides isConnected flag
├── useDailyLog.ts                # Fetch + auto-save today's log
├── useHabits.ts                  # Fetch + mutate habits + check-in toggle
├── useJournalHistory.ts          # Fetch last 7 daily-log entries
└── useSnapshot.ts                # Derives DailySnapshot from current state (no fetch)
```

### 6.2 Data Flow

```
Hook → useConnection check
  → disconnected → return null/empty → empty state
  → connected → data-provider → notion/provider → /api/notion proxy → Notion API
```

**Auto-save flow:**
```
User types in journal
  → onInput fires, updates React state
  → debounce timer (800ms)
  → upsertEntry({ text, mood }) → Notion API
  → "✓ saved" indicator flashes
```

**Snapshot flow (client-side, no API calls):**
```
Journal screen opens or habits change
  → useSnapshot reads: useDailyLog (text, mood), useHabits (habits, check-ins)
  → computeSnapshot() → DailySnapshot
  → SnapshotToggle renders collapsed bar with quick stats
  → User expands → full snapshot with habit rows, context sentence
```

**Improve engine flow:**
```
User taps "Generate improvement"
  → improve-engine receives: journal text, mood, habit list, check-in state
  → Generates 1–2 Improvement objects (tagged planning or behavior)
  → Navigate to Improve screen
  → User taps "Save & continue" → upsertEntry({ dailyImprovement })
  → Carries forward to tomorrow's home screen
```

> **Rate limit note:** Notion allows 3 requests/second. Auto-save is debounced at 800ms. Cache reads in React state for the session.

---

## 7. Build Phases

| Phase | Name | Scope | Target |
|---|---|---|---|
| 1 | Foundation | Scaffold, settings + proxy, journal screen wired to Notion with auto-save | ~1 week |
| 2 | Habits + Home | Habit CRUD, check-ins, home dashboard with journal card + habit list | ~1 week |
| 3 | History + Tracker + Improve | History with habit summary, tracker, improve engine | ~1 week |
| 4 | AI + Polish | Claude API improve, weekly analysis, PWA, skeleton loaders | ~2 weeks |

---

### Phase 1 — Foundation

**Step 1: Scaffold**
- `npx create-next-app@latest loopd --typescript --tailwind --app`
- Port Tailwind config from prototype CSS variables
- Set up `next/font` with DM Serif Display, DM Mono, Instrument Sans
- Bottom nav layout shell with routing for all 7 screens
- Deploy empty shell to Netlify — confirm CI before building

**Step 2: Types + data provider**
- Write `lib/types.ts` — `DailyLogEntry` (with single `text` + `mood`), `Habit`, `Improvement`, `DailySnapshot`
- Write `lib/data-provider.ts` — connection-aware wrapper with `isConnected()` check
- Write `hooks/useConnection.ts` — reads `localStorage`, provides connection state

**Step 3: Settings screen + Notion proxy**
- Build `app/settings/page.tsx` — token field, DB ID field, test button, status indicator, how-to accordion
- Create `app/api/notion/route.ts` — reads `x-notion-token` / `x-notion-db-id` from request headers
- Create `app/api/notion/test/route.ts` — lightweight connection test
- Write `lib/notion/transforms.ts` and `lib/notion/provider.ts`
- Verify: paste credentials → test → green status

**Step 4: Journal screen with auto-save**
- Build `app/journal/page.tsx` — unified journal with single textarea
- Wire `useDailyLog` hook with auto-save (800ms debounce → `upsertEntry`)
- On mount: load today's entry, populate textarea and mood
- Mood picker: single mood, updates via auto-save
- "✓ saved" indicator on debounce completion
- Write `lib/snapshot.ts` — `computeSnapshot()` pure function
- Build collapsible SnapshotToggle (priorities + mood only — habits come in Phase 2)
- Build 5-tab prompts drawer (Plan, Intention, Thoughts, Reflect, Habits)
- Build empty state components
- Verify: open journal → type → auto-saves to Notion → reload → text persists

---

### Phase 2 — Habits + Home

**Habits:**
- Build Habits screen — CRUD wired to Notion (create, edit, soft delete)
- `toggleCheckin`: read Check-ins JSON, append/remove today's date, PATCH back
- `MiniHeatmap`: parse Check-ins, map last 14 dates to cells
- Streak + completion % computed client-side

**Home dashboard:**
- Build `app/page.tsx` (Home) with time-of-day greeting
- Journal card: reads `useDailyLog` for preview text, mood, word count, priority tick-offs
- Empty state: accent-bordered CTA → opens journal. Has content: preview card → opens journal.
- Habit check-in list driven by `useHabits`
- Yesterday's improvement carry-over from `getLast7Days()[1]`
- Stats bar (day streak, completion %, days logged — computed from `getLast7Days`)

**Wire habits into journal:**
- Habits bar inside journal: compact pills showing done/pending per habit
- Snapshot now includes habit completion data
- Verify: create habit → check in on home → open journal → snapshot shows done/skipped, habits bar updates

---

### Phase 3 — History + Tracker + Improve Engine

**History:**
- Build `app/history/page.tsx` — `getLast7Days()` on mount
- Render expandable `DayCard` components — journal text, mood, improvement, habit chips
- Habit chips: cross-reference each habit's `checkIns` against the day's date
- Today's card reads from `useDailyLog` state

**Tracker:**
- Build `app/tracker/page.tsx` — 28-day heatmap per habit
- Current streak, best streak, total days, completion %

**Improve engine:**
- Port `improve-engine.ts` from prototype — takes journal text + habit signals
- Engine receives: full text, mood, habit list, check-in state
- Outputs 1–2 `Improvement` objects, each tagged `planning` or `behavior`
- Build `app/improve/page.tsx` — cards with animation
- "Save & continue" writes `dailyImprovement` via `upsertEntry()`
- Home carry-over card reads yesterday's improvement

---

### Phase 4 — AI + Polish

- Claude API: send journal text, habit completion data, mood
- Prompt: *"Based on today's journal and habit completion (X/Y done, skipped: [names]), suggest 1 planning adjustment and 1 behavior adjustment for tomorrow. Short, specific, non-judgmental."*
- Weekly analysis: Sunday query of last 7 entries → Claude pattern detection
- PWA: `manifest.json`, service worker, install prompt
- Polish: skeleton loaders, error boundaries, optimistic UI, smooth transitions

---

## 8. Component Map

| Screen | Route | Key Components |
|---|---|---|
| Today / Home | `app/page.tsx` | JournalCard (CTA or preview), HabitCheckinList, ImproveCarry, StatsBar |
| Journal | `app/journal/page.tsx` | JournalTextarea, MoodPicker, SnapshotToggle, HabitsBar, PromptsDrawer (5 tabs), SaveIndicator |
| Improve | `app/improve/page.tsx` | ImproveCard (×2, planning/behavior badge), ImproveActions |
| Habits | `app/habits/page.tsx` | HabitRow, HabitModal, ColorPicker, FreqPicker, MiniHeatmap |
| Tracker | `app/tracker/page.tsx` | FullHeatmap, StreakStats, TrackerBlock |
| History | `app/history/page.tsx` | DayCard, DaySection, HabitSummaryChips |
| Settings | `app/settings/page.tsx` | NotionCredentialsForm, ConnectionStatus, HowToAccordion |

---

## 9. Settings Screen — Notion Credentials

### What it does

1. User opens Settings (gear icon in topbar)
2. User pastes **Notion integration token** and **database ID**
3. User taps **Test connection** — single Notion API call to verify
4. On success: credentials saved to `localStorage`, all screens switch to live data
5. On failure: clear error message

### Proxy

```ts
// app/api/notion/route.ts
export async function POST(req: Request) {
  const token = req.headers.get('x-notion-token')
  const dbId  = req.headers.get('x-notion-db-id')
  if (!token || !dbId) return Response.json({ error: 'No credentials' }, { status: 401 })

  const notionRes = await fetch('https://api.notion.com/v1/...', {
    headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
  })
  return Response.json(await notionRes.json())
}
```

### Provider — attaching credentials

```ts
// lib/notion/provider.ts
function getHeaders() {
  return {
    'x-notion-token': localStorage.getItem('loopd_notion_token') ?? '',
    'x-notion-db-id': localStorage.getItem('loopd_notion_db_id') ?? '',
  }
}
```

### `localStorage` keys

| Key | Value |
|---|---|
| `loopd_notion_token` | Notion integration token |
| `loopd_notion_db_id` | Notion database ID |
| `loopd_notion_connected` | `"true"` after successful test |

---

## 10. Environment Variables

| Variable | When | Value |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | Always | `http://localhost:3000` in dev, deployed URL in prod |
| `ANTHROPIC_API_KEY` | Phase 4 only | Claude API key |

Notion credentials are **not** env vars — they come from the Settings screen.

---

## 11. Setup Checklist

### Notion setup
1. Create integration at notion.so/my-integrations — copy the token
2. Create a single Notion database with the schema from Section 4
3. Pre-populate Color select with 6 hex values, Frequency select with 4 options
4. Create two saved filter views: **Daily Log** and **Habits**
5. Share the database with the integration
6. Open Loopd → Settings → paste credentials → Test connection

### Netlify
1. Connect GitHub repo — auto-deploy on push to main
2. Build command: `next build` | Publish directory: `.next`
3. Env vars: `NEXT_PUBLIC_APP_URL` (and `ANTHROPIC_API_KEY` for Phase 4)

---

## 12. Out of Scope (v1)

- Multi-user / authentication
- Push notifications / reminders
- Data export (CSV, PDF)
- Full offline-first PWA (partial in Phase 4)
- Mobile native app
- Rich text editor — free-form textarea is intentional
- Separate plan/reflect fields — unified journal is the model
- Phase gates or locking — the journal is always editable

---

## 13. Next Actions

Ordered. Start at the top.

1. Scaffold Next.js: `create-next-app`, Tailwind config, font setup
2. Port CSS design tokens from prototype into Tailwind config
3. Write `lib/types.ts` — `DailyLogEntry` (single `text` + `mood`), `Habit`, `Improvement`, `DailySnapshot`
4. Write `lib/data-provider.ts` with `isConnected()` check
5. Write `hooks/useConnection.ts`
6. Build Settings screen — credentials, test, status, how-to
7. Build `app/api/notion/route.ts` and `test/route.ts`
8. Write `lib/notion/transforms.ts` and `lib/notion/provider.ts`
9. Build Journal screen — textarea, mood, auto-save, prompts drawer, snapshot toggle
10. Write `lib/snapshot.ts` and `hooks/useSnapshot.ts`
11. Build empty state components
12. Create Notion database, connect via Settings, verify journal auto-saves and reloads
13. Phase 2: habit CRUD, home dashboard with journal card + habit check-ins
14. Phase 3: history with habit chips, tracker, improve engine
15. Deploy to Netlify — use for a full week before Phase 4
16. Phase 4: Claude API, PWA, polish

---

> **Reminder:** The prototype is the spec. When in doubt about what a screen should look like or how it should behave, open `loopd-prototype.html`.