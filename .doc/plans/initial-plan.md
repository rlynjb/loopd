---
title: initial-plan
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

Loopd is a daily self-correcting productivity system built around the **Plan → Live → Reflect → Improve** loop. Each day has a morning planning journal, an evening reflection, and an improvement engine that generates 1–2 specific adjustments for the next day. Habit tracking is integrated into the daily dashboard.

All data lives in a single Notion database. Notion credentials (token + DB ID) are entered directly in the app via a Settings screen — no env vars or file edits required from the user. Before Notion is connected, the app renders empty states on every screen with a clear prompt to connect via Settings.

> **Core principle:** The prototype is complete — all 8 screens are designed and interactive. This plan covers scaffolding the real app, wiring the Notion data layer, and building out each feature phase by phase.

### Already done (prototype)
- All 8 screens: Today, Plan, Reflect, Improve, Habits, Tracker, Journal, Settings
- Rule-based improve engine (text analysis → 1–2 suggestions)
- Habit CRUD with color picker, frequency selector, 14-day mini heatmap
- Free-form journal with prompts drawer (3 tabs × 6–8 prompts per tab)
- Plan summary card on home with live tick-off priority rows
- 7-day journal history view with expand/collapse day cards
- Notion schema designed — single database, two row types
- Settings screen with Notion credential entry, connection test, and status indicator

### Build plan covers
- Next.js app scaffold from prototype
- **Data provider** — Notion API via proxy, empty states when disconnected
- **Settings screen** — in-app Notion credential entry, stored in `localStorage`
- Netlify API route proxy — reads credentials from request headers
- Notion read/write layer
- Component architecture and hook pattern
- Phase-by-phase build order with step-level detail
- Claude API integration (Phase 4)

---

## 2. Tech Stack

### Frontend

| Layer | Technology | Notes |
|---|---|---|
| Framework | Next.js 14 (App Router) | File-based routing, client components for interactive UI |
| Language | TypeScript | Strict mode — typed across all data shapes |
| Styling | Tailwind CSS | Prototype CSS token system maps cleanly to Tailwind config + CSS vars |
| State | React state + Context | No Redux/Zustand needed — 3 hooks cover all data needs |
| Fonts | DM Serif Display + DM Mono + Instrument Sans | Via next/font — same fonts as prototype |

### Backend / Data

| Layer | Technology | Notes |
|---|---|---|
| Database | Notion API | Single database, two row types: `daily-log` and `habit` |
| Credentials | `localStorage` | User pastes Notion token + DB ID into Settings screen. Persists across sessions. |
| Proxy | Next.js API route | Reads credentials from `x-notion-token` / `x-notion-db-id` request headers. ~20 lines. |
| SDK | @notionhq/client | Official Notion SDK — handles retries, pagination, TypeScript types |
| Env vars | None required for Notion | Credentials come from the UI, not env vars |

---

## 3. Data Layer

All data flows through a single provider (`lib/notion/provider.ts`) that calls the Notion API via a local proxy route. If no credentials are present in `localStorage`, every hook returns empty/null and the UI renders empty states with a prompt to connect Notion in Settings.

### Connection flow

```
No credentials in localStorage  →  hooks return null/empty  →  UI shows empty states
Credentials present + connected  →  hooks call lib/notion/provider.ts  →  calls /api/notion proxy  →  Notion API
```

### Shared types

```ts
// lib/types.ts

export interface DailyLogEntry {
  id: string
  date: string                // "2026-03-19"
  plan: string
  moodMorning: number | null  // 1–5
  reflect: string
  moodEvening: number | null  // 1–5
  lesson: string
  dailyImprovement: Improvement[]
  completion: 'Yes' | 'Partially' | 'No' | null
}

export interface Improvement {
  icon: string
  title: string
  detail: string
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

### Empty states (when not connected)

Every screen shows a consistent empty state when `isConnected()` returns false:

| Screen | Empty state message |
|---|---|
| Today / Home | "Connect Notion to start your daily loop" + button to Settings |
| Plan | "Connect Notion in Settings to begin planning" |
| Reflect | "Connect Notion in Settings to reflect on your day" |
| Improve | Only reachable after reflect submit — no empty state needed |
| Habits | "No habits yet — connect Notion in Settings to start tracking" |
| Tracker | "Nothing to track yet — connect Notion to see your streaks" |
| Journal | "No entries yet — connect Notion to start journaling" |

Each empty state includes a direct link/button to the Settings screen. Once connected, the same screens show "no data yet" states until the user creates their first entries.

---

## 4. Notion Database Schema

**One database. Two row types** differentiated by a `Type` select property. Habit rows and daily log rows live side by side — use saved Notion filter views to browse them separately.

### Row Type: `daily-log`

| Property | Type | Notes |
|---|---|---|
| Name | Title | Date string: `"2026-03-19"` — page title |
| Type | Select | Always `daily-log` |
| Date | Date | ISO date — unique per day, used for querying |
| Plan | Rich Text | Morning journal (free-form) |
| Mood Morning | Select | 1–5: flat / ok / good / great / fired up |
| Reflect | Rich Text | Evening journal (free-form) |
| Mood Evening | Select | 1–5 — same options as morning |
| Lesson | Rich Text | One thing to improve — key handoff question |
| Daily Improvement | Rich Text | JSON: `[{icon, title, detail}]` — 1–2 items |
| Completion | Select | Yes / Partially / No |

### Row Type: `habit`

| Property | Type | Notes |
|---|---|---|
| Name | Title | Habit name: `"Morning run"` |
| Type | Select | Always `habit` |
| Color | Select | Hex value as option — pre-populate all 6 from the color picker: `#4caf7d`, `#5b8fe8`, `#d4922a`, `#c46fd4`, `#e05555`, `#e8d5b0` |
| Frequency | Select | `Daily` / `Weekdays` / `3x/week` / `Weekly` — must match TypeScript type exactly |
| Note | Rich Text | Optional context (`"Before breakfast"`) |
| Active | Checkbox | Soft delete — inactive rows filtered from UI |
| Check-ins | Rich Text | JSON: `["2026-03-17","2026-03-18"]` — append on check |

### Querying by row type

```ts
// Get today's log entry
filter: {
  and: [
    { property: 'Type', select: { equals: 'daily-log' } },
    { property: 'Date', date: { equals: today } }
  ]
}

// Get all active habits
filter: {
  and: [
    { property: 'Type', select: { equals: 'habit' } },
    { property: 'Active', checkbox: { equals: true } }
  ]
}

// Get last 7 daily log entries
filter: { property: 'Type', select: { equals: 'daily-log' } },
sorts: [{ property: 'Date', direction: 'descending' }],
page_size: 7
```

### Notion tip: create saved views

- **Daily Log view** — filter: `Type is daily-log`, sort by Date descending
- **Habits view** — filter: `Type is habit`, sort by Name

---

## 5. App Architecture

### 5.1 Directory Structure

```
app/
├── page.tsx                      # Today / Home dashboard
├── plan/page.tsx                 # Morning plan journal
├── reflect/page.tsx              # Evening reflect journal
├── improve/page.tsx              # Improve results screen
├── journal/page.tsx              # 7-day journal history
├── habits/page.tsx               # Habits CRUD list
├── tracker/page.tsx              # 28-day habit tracker
├── settings/page.tsx             # Notion credentials form + connection status
└── api/
    ├── notion/route.ts           # Proxy — reads credentials from request headers
    └── notion/test/route.ts      # Connection test — single lightweight Notion query

lib/
├── types.ts                      # Shared TypeScript types (DailyLogEntry, Habit, Improvement)
├── data-provider.ts              # Connection-aware wrapper — returns empty when disconnected
├── notion/
│   ├── provider.ts               # All Notion read/write functions
│   ├── daily-log.ts              # getTodayEntry, upsertEntry, getLast7Days
│   ├── habits.ts                 # getActiveHabits, createHabit, updateHabit, toggleCheckin
│   └── transforms.ts             # Notion API response → DailyLogEntry / Habit types
└── improve-engine.ts             # Rule-based improve logic (pure function, testable)

components/
├── journal/                      # JournalTextarea, PromptsDrawer, MoodPicker
├── home/                         # PlanSummaryCard, HabitCheckin, ImproveCarry
├── habits/                       # HabitRow, HabitModal, MiniHeatmap
├── tracker/                      # FullHeatmap, StreakStats, TrackerBlock
├── journal-log/                  # JournalLog, DayCard, DaySection
├── empty/                        # EmptyState, ConnectPrompt
└── ui/                           # Button, Card, NavBar, TopBar, Modal

hooks/
├── useConnection.ts              # Reads localStorage, provides isConnected flag
├── useDailyLog.ts                # Fetch + mutate today's log (via data-provider)
├── useHabits.ts                  # Fetch + mutate all habits + check-in toggle
└── useJournalHistory.ts          # Fetch last 7 daily-log entries
```

### 5.2 Data Flow

```
Hook → useConnection check
  → disconnected → return null/empty → UI renders empty state
  → connected → lib/data-provider.ts → lib/notion/provider.ts → /api/notion (proxy) → Notion API
```

The hooks and components handle both states — connected (real data) and disconnected (empty states). The `useConnection` hook provides the flag.

> **Rate limit note:** Notion allows 3 requests/second. Loopd uses 3–5 reads on load, 1–2 writes per action. Cache reads in React state for the session.

---

## 6. Build Phases

The prototype is the spec for every screen. Build the Notion connection flow first, then wire each feature to live data.

| Phase | Name | Scope | Target |
|---|---|---|---|
| 1 | Foundation | Scaffold, settings + proxy, plan + reflect flow wired to Notion | ~1 week |
| 2 | Habits | Habit CRUD, check-in toggle, home dashboard live | ~1 week |
| 3 | Journal + Tracker | History view, 28-day tracker, improve engine wired | ~1 week |
| 4 | AI + Polish | Claude API improve, weekly analysis, PWA, skeleton loaders | ~2 weeks |

---

### Phase 1 — Foundation

**Step 1: Scaffold**
- `npx create-next-app@latest loopd --typescript --tailwind --app`
- Port Tailwind config from prototype CSS variables (`--bg`, `--accent`, `--text`, etc.)
- Set up `next/font` with DM Serif Display, DM Mono, Instrument Sans
- Bottom nav layout shell with screen routing matching all 8 prototype screens
- Deploy empty shell to Netlify immediately — confirm CI before building

**Step 2: Types + data provider**
- Write `lib/types.ts` — `DailyLogEntry`, `Habit`, `Improvement` interfaces
- Write `lib/data-provider.ts` — connection-aware wrapper with `isConnected()` check
- Write `hooks/useConnection.ts` — reads `localStorage`, provides connection state
- At this point all hooks return empty/null — UI shows empty states everywhere

**Step 3: Settings screen + Notion proxy**
- Build `app/settings/page.tsx` — token field, DB ID field, test button, status indicator
- Create `app/api/notion/route.ts` — reads `x-notion-token` / `x-notion-db-id` from request headers
- Create `app/api/notion/test/route.ts` — lightweight connection test endpoint (single DB query)
- Write `lib/notion/transforms.ts` — maps Notion API response shapes to `DailyLogEntry` / `Habit`
- Write `lib/notion/provider.ts` — reads credentials from `localStorage`, attaches to all requests
- Verify: paste credentials in Settings → test → green status → `useConnection` returns connected

**Step 4: Port screens + wire to Notion**
- Port all 8 screens from prototype, wiring hooks to `lib/data-provider.ts`
- `useDailyLog` hook: calls `getTodayEntry()` and `upsertEntry()` from provider
- `useHabits` hook: calls `getActiveHabits()`, `createHabit()`, `updateHabit()`, `toggleCheckin()`
- `useJournalHistory` hook: calls `getLast7Days()`
- Build empty state components — consistent across all screens, link to Settings
- Verify: disconnected → all screens show empty states. Connected → plan/reflect flow works end-to-end with live Notion data

---

### Phase 2 — Habits

- Habit CRUD wired to Notion provider — create, edit, delete (soft delete via Active checkbox)
- `toggleCheckin`: read Check-ins JSON from Notion, append/remove today's ISO date, PATCH back
- `MiniHeatmap`: parse Check-ins, map last 14 ISO dates to filled/empty cells
- Home dashboard habit check-ins driven by `useHabits` state
- Streak + completion % computed client-side — no extra Notion queries
- Verify: create a habit, check in, refresh — data persists in Notion

---

### Phase 3 — Journal History + Tracker

- Journal history: `getLast7Days()` on mount, render `DayCard` components
- Today's entry reads from `useDailyLog` state — no extra fetch
- 28-day tracker: parse each habit's Check-ins against last 28 dates
- `FullHeatmap`: map dates to coloured cells using `habit.color`
- Port `improve-engine.ts` from prototype — pure function, easy to test
- Wire engine output: save to `dailyImprovement` on reflect submit via `upsertEntry()`
- Home carry-in card: reads yesterday's improvement from `getLast7Days()[1]`

---

### Phase 4 — AI + Polish

- Claude API: after reflect submit, call Claude Sonnet with plan vs reflect text
- Prompt: *"Based on today's plan vs outcome, suggest 1–2 improvements for tomorrow. Short, specific, non-judgmental."*
- Parse response into `[{icon, title, detail}]` array, save to `dailyImprovement` via `upsertEntry()`
- Weekly improve: Sunday query of last 7 entries → Claude pattern analysis
- PWA: `manifest.json`, `next-pwa` service worker, install prompt on mobile
- Polish: skeleton loaders, error boundaries, empty states, optimistic UI throughout

---

## 7. Component Map

| Screen | Page | Key Components |
|---|---|---|
| Today / Home | `app/page.tsx` | PlanSummaryCard, HabitCheckinList, ImproveCarry, PhaseCards, EmptyState |
| Plan journal | `app/plan/page.tsx` | JournalTextarea, PromptsDrawer, MoodPicker, JournalFooter |
| Reflect journal | `app/reflect/page.tsx` | JournalTextarea, PromptsDrawer, MoodPicker, JournalFooter |
| Improve | `app/improve/page.tsx` | ImproveCard (×2), ImproveActions |
| Habits | `app/habits/page.tsx` | HabitRow, HabitModal, ColorPicker, FreqPicker, EmptyState |
| Tracker | `app/tracker/page.tsx` | FullHeatmap, StreakStats, TrackerBlock, EmptyState |
| Journal history | `app/journal/page.tsx` | JournalLog, DayCard, DaySection, EmptyState |
| Settings | `app/settings/page.tsx` | NotionCredentialsForm, ConnectionStatus, ConnectionTest |

---

## 8. Settings Screen — Notion Credentials

The Settings screen is the mechanism by which the user connects Loopd to their Notion workspace. No env vars, no CLI, no file editing.

### What it does

1. User opens Settings (gear icon in topbar or nav)
2. User pastes their **Notion integration token** and **database ID**
3. User taps **Test connection** — app makes a single Notion API call to verify
4. On success: credentials saved to `localStorage`, status set to connected, all screens switch from empty states to live data
5. On failure: clear error message with guidance on what went wrong

### `localStorage` flow

```
User pastes token + DB ID
        ↓
Tap "Test connection"
        ↓
POST /api/notion/test  (proxy passes headers to Notion, tries a simple DB query)
        ↓
Success → save to localStorage → set loopd_notion_connected = "true"
Failure → show error, clear loopd_notion_connected
        ↓
useConnection hook re-evaluates on every page load
→ credentials present + connected → hooks fetch from Notion
→ no credentials → hooks return empty, UI shows empty states
```

### Proxy — reading credentials from headers

```ts
// app/api/notion/route.ts
export async function POST(req: Request) {
  const token  = req.headers.get('x-notion-token')
  const dbId   = req.headers.get('x-notion-db-id')

  if (!token || !dbId) {
    return Response.json({ error: 'No credentials' }, { status: 401 })
  }

  // Forward to Notion with the user's token
  const notionRes = await fetch('https://api.notion.com/v1/...', {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
    },
    // ... body
  })
  return Response.json(await notionRes.json())
}
```

### Notion provider — attaching credentials

```ts
// lib/notion/provider.ts
function getHeaders() {
  return {
    'x-notion-token': localStorage.getItem('loopd_notion_token') ?? '',
    'x-notion-db-id': localStorage.getItem('loopd_notion_db_id') ?? '',
  }
}

export async function getTodayEntry() {
  const res = await fetch('/api/notion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getHeaders() },
    body: JSON.stringify({ action: 'getTodayEntry' }),
  })
  return res.json()
}
```

### Settings screen UI elements

- **Token field** — password input (masked), paste-friendly, with a "show/hide" toggle
- **Database ID field** — text input with placeholder showing the URL format
- **Test connection button** — triggers the verification call, shows spinner while testing
- **Connection status indicator** — green dot "Connected to Notion" / amber dot "Not connected"
- **Disconnect button** — clears `localStorage`, reverts all screens to empty states
- **Help link** — opens Notion integration docs in a new tab
- **Step-by-step instructions** — collapsed accordion showing how to create an integration and share a database

### Security note

Storing a Notion token in `localStorage` is acceptable for a single-user personal app. The token can only access the specific database it was shared with. The user owns the token and controls access from the Notion integration dashboard. This is no different from how apps like Obsidian handle personal API keys.

---

## 9. Environment Variables

Notion credentials are **not** stored in env vars. The user enters them in the Settings screen and they are saved to `localStorage`. The proxy reads them from request headers.

| Variable | When | Value / Source |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | Always | `http://localhost:3000` in dev, deployed URL in prod |
| `ANTHROPIC_API_KEY` | Phase 4 only | Claude API key — still an env var, not user-facing |

`.env.local` for development:
```
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

`.env.production` / Netlify env vars:
```
NEXT_PUBLIC_APP_URL=https://loopd.netlify.app
ANTHROPIC_API_KEY=sk-ant-xxx  # Phase 4 only
```

### `localStorage` keys (set by Settings screen)

| Key | Value |
|---|---|
| `loopd_notion_token` | Notion integration token (`secret_xxx...`) |
| `loopd_notion_db_id` | Notion database ID |
| `loopd_notion_connected` | `"true"` — set after successful connection test |

---

## 10. Setup Checklist

### Notion setup (done in-app by the user)
1. Create integration at notion.so/my-integrations — copy the token
2. Create a single Notion database named `Loopd` with the full schema from Section 4
3. Pre-populate the Color select with all 6 hex values: `#4caf7d`, `#5b8fe8`, `#d4922a`, `#c46fd4`, `#e05555`, `#e8d5b0`
4. Pre-populate the Frequency select with: `Daily`, `Weekdays`, `3x/week`, `Weekly`
5. Create two saved filter views: **Daily Log** (`Type is daily-log`) and **Habits** (`Type is habit`)
6. Share the database with the integration (Share → search integration name)
7. Open Loopd → Settings → paste the token and database ID → tap **Test connection**
8. Green status = connected. App now reads/writes Notion automatically.

### Netlify
1. Connect GitHub repo — auto-deploy on push to main
2. Build command: `next build` | Publish directory: `.next`
3. Only env var needed: `NEXT_PUBLIC_APP_URL` (and `ANTHROPIC_API_KEY` for Phase 4)
4. No Notion credentials in Netlify env vars — they come from the user's Settings screen

---

## 11. Out of Scope (v1)

- Multi-user / authentication — single user, token is the auth
- Push notifications / reminders
- Data export (CSV, PDF)
- Full offline-first PWA — partial in Phase 4, full offline deferred
- Mobile native app — React Native is a v2 conversation
- Rich text editor — free-form textarea is intentional

---

## 12. Next Actions

Ordered. Start at the top.

1. Scaffold Next.js: `create-next-app`, Tailwind config, font setup
2. Port CSS design tokens from prototype into Tailwind config
3. Write `lib/types.ts` — `DailyLogEntry`, `Habit`, `Improvement`
4. Write `lib/data-provider.ts` with `isConnected()` check and empty returns
5. Write `hooks/useConnection.ts` — reads localStorage, provides connection flag
6. Build Settings screen — token field, DB ID field, test button, connection status
7. Build `app/api/notion/route.ts` — reads credentials from request headers
8. Build `app/api/notion/test/route.ts` — connection test endpoint
9. Write `lib/notion/transforms.ts` and `lib/notion/provider.ts`
10. Port all 8 screens from prototype, wired to data provider
11. Build empty state components — consistent design, link to Settings
12. Create Notion database, open Settings in app, paste credentials, test — verify all screens work
13. Phase 2: habit CRUD + check-in works end-to-end with Notion
14. Phase 3: journal history + tracker from real data
15. Deploy to Netlify — use for a full week before Phase 4
16. Phase 4: Claude API, PWA, polish

---

> **Reminder:** The prototype is the spec. When in doubt about what a screen should look like or how it should behave, open `loopd-prototype.html` — it is the source of truth.