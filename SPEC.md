# loopd — Product Specification

> Plan. Capture. Reflect. Think.

A mobile vlog journal app for Android that combines daily journaling, video clips, habit tracking, todo lists, and a lightweight NLE video editor — all synced bidirectionally with Notion.

---

## Screens & Navigation

### Global Bottom Nav
3 tabs: **Home** | **Record** | **Journal**
- Record opens device camera to capture a clip, saves to today's entries
- Hidden on editor and settings screens

### Home Screen
- Editable day title with date
- Weekly habit streak grid (Sun-Sat, colored dots per habit)
- Today's card with 2-sentence text preview
- Start/Continue Today's Vlog button
- Previous Vlogs list (title, date, text preview)
- Auto-archives past days at midnight
- Sync status in header (pull/push counts, last synced time)

### Journal Screen
- Chronological entry list for a single day
- Each entry displays: timestamp, text, todos, habit chips, clip thumbnails
- Tap entry to inline-edit (text input replaces text, content stays visible)
- "Write something..." prompt to add new entry
- Keyboard toolbar above keyboard: Todo, Clip, Habit buttons
  - Habit: toggleable chip picker in toolbar sub-view with back button
  - Clip: opens media picker, adds to current entry
  - Todo: adds todo list to current entry
- Edit Vlog button in header (opens video editor)
- Entries auto-save to DB on every keystroke (silent, no re-render)
- New entries auto-commit after 20s idle, dismiss keyboard
- Empty entries (no text, clips, habits, todos) auto-delete on 20s idle

### Video Editor Screen
- 9:16 vertical preview player (resizable 100-500px)
- Multi-track timeline:
  - Clip track: draggable clips with waveform, color bar, duration badge, trim handles
  - Text overlay track: positioned text blocks with trim/move handles
  - Filter overlay track: color adjustment blocks
- Pinch-to-zoom timeline (react-native-reanimated, UI thread)
- Zoom +/- buttons with percentage display
- Draggable playhead with transport controls
- Trim All: batch trim clips to 2s/3s/4s/5s
- Clip operations: trim, split, reorder, delete
- Text overlays: font (Nunito 200-900 + italic), size, color, alignment, position, leading, full-duration toggle
- Filter presets: 13 options (Vivid, Moody, Warm, Cool, Noir, Golden, Film, Dreamy, Bold, Muted, Sunset, Clean) with manual B/C/S sliders and color tint
- Export: FFmpeg H.264/AAC 1080x1920 MP4, progress modal, cancel support, auto-save to DCIM, share sheet
- Auto-save draft to DB with 1s debounce

### Settings
- Notion Sync: token, DB IDs, test connection, sync now, auto-sync toggle, disconnect
- Notion Setup Guide: step-by-step with property tables
- Export/Import Database: share .db file, restore from backup
- App Updates: OTA via Expo Updates

---

## Data Model

### Entry
| Field | Type | Description |
|-------|------|-------------|
| id | string | Generated ID |
| date | string | "2026-04-05" |
| text | string \| null | Journal text |
| category | string \| null | coding, gym, food, social, solo, errand |
| habits | string[] | Checked habit IDs |
| todos | TodoItem[] | Checkable items with completion timestamps |
| clips | ClipRef[] | Video files with duration |
| createdAt | string | ISO timestamp |
| notionPageId | string \| null | Notion page ID for sync |
| updatedAt | string \| null | Last edit timestamp |

Entries are unified — a single entry can have text + clips + habits + todos.

### TodoItem
| Field | Type | Description |
|-------|------|-------------|
| id | string | Generated ID |
| text | string | Item text |
| done | boolean | Checked state |
| completedAt | string \| null | ISO timestamp when checked |

### EditorProject
| Field | Type | Description |
|-------|------|-------------|
| id | string | Generated ID |
| date | string | One project per day |
| status | draft \| exported | |
| clips | ClipItem[] | Timeline clips with trim/order |
| textOverlays | TextOverlay[] | Text on video |
| filterOverlays | FilterOverlay[] | Color adjustments |
| exportUri | string \| null | Path to exported MP4 |

### Habit
| Field | Type | Description |
|-------|------|-------------|
| id | string | e.g. "workout" |
| label | string | Display name |
| sortOrder | number | Order in picker |

### Vlog
Archived day summary with clip count, habit count, mood, categories, duration, export URI.

---

## Storage

### SQLite Database
Tables: entries, habits, projects, vlogs, day_meta, sync_deletions

### File System
```
Documents/loopd/
  clips/{date}/{filename}.mp4
  exports/{date}/vlog-{date}.mp4
  temp/
```

### Secure Storage
Notion token, database IDs (encrypted via expo-secure-store)

---

## Notion Sync

### Bidirectional Entry Sync
- Push: text, habits (multi-select), clips (JSON), todos (JSON), date, loopd ID
- Pull: last 7 days, merge with local, preserve local clip URIs
- Conflict resolution: last-edit-wins by timestamp
- Deletion: tracked in sync_deletions table, archived in Notion

### Habit Schema Sync
- Reads habit names from Notion DB multi-select options
- Adds/removes local habits to match

### Daily Log (optional)
- One row per day with habit checkboxes, clip count, summary
- Checkbox changes sync back to entries

### Entries Database Columns
| Column | Type |
|--------|------|
| Title | Title (default) |
| Date | Date |
| Text | Rich text |
| Habits | Multi-select |
| Todos | Rich text (JSON) |
| Clips | Rich text (JSON) |
| loopd ID | Rich text |
| Created At | Date |

### Sync Behavior
- Auto-sync on app open (if enabled)
- Manual sync via header button or settings
- Rate limited: 350ms between API calls, retry on 429/5xx
- Auto-reimport missing clips from camera roll during sync

---

## Video Export Pipeline

1. **Trim**: Each clip → 1080x1920, H.264 baseline, 30fps, AAC 128k
2. **Concatenate**: Concat demuxer (no re-encode)
3. **Filters**: FFmpeg `eq` filter with time-based `enable` expressions + `colorchannelmixer` for tints
4. **Text**: Pre-rendered PNG overlays composited via `overlay` filter
5. **Output**: MP4 with `faststart`, saved to DCIM and share sheet

FFmpeg loaded lazily (234MB native heap) — only on export, not at app startup.

---

## Theme

### Colors
- Background: #0c0c0e, #141416, #1c1c1f
- Accent: #e8d5b0 (warm gold), #c4a96a
- Semantic: teal #4caf7d, purple #c46fd4, coral #e05555, amber #d4922a

### Typography
- Headings: DM Serif Display
- Labels: DM Mono
- Body: Instrument Sans
- Text overlays: Nunito (8 weights + italic), Poppins, TikTok Sans, Varela Round

### Layout
- Dark mode only, no border radius on buttons
- Global nav height: 112px
- Lucide icons throughout

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | React Native 0.83 + Expo SDK 55 |
| Language | TypeScript (strict) |
| Navigation | Expo Router (file-based) |
| Database | expo-sqlite |
| Video Playback | react-native-video |
| Video Export | ffmpeg-kit-react-native |
| Animations | react-native-reanimated |
| Gestures | react-native-gesture-handler |
| Icons | lucide-react-native |
| Updates | expo-updates (OTA) |
| Platform | Android only |

---

## Data Rules

- Database is the single source of truth — UI displays data as stored
- No frontend filtering unless explicitly requested
- Save to DB on every keystroke (silent, no re-render)
- Always read from DB before auto-deleting entries
- Don't auto-delete during sync operations
- Prefer saving over deleting
