# loopd — Product Specification

> Plan. Capture. Reflect. Think.

A mobile vlog journal app for Android that combines daily journaling, video clips, habit tracking, todo lists, and a lightweight NLE video editor — all synced bidirectionally with Notion.

---

## Screens & Navigation

### Global Bottom Nav
4 tabs: **Home** | **Record** | **Vlog** | **Journal**
- Record opens device camera to capture a clip, saves to today's entries
- Vlog opens the video editor for today's date
- Hidden on settings screens
- Active state highlights current route

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
- Text overlays: font (Nunito 200-900), size, leading, weight, alignment (left/center/right), position (top/center/bottom), full-duration toggle
- Filter presets: Moody, Cool, Film, Muted — applied as full-duration blocks
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
| habits | string[] | Checked habit IDs |
| todos | TodoItem[] | Checkable items with completion timestamps |
| clips | ClipRef[] | Video files with duration |
| clipUri | string \| null | Primary clip URI (legacy compat) |
| clipDurationMs | number \| null | Primary clip duration (legacy compat) |
| createdAt | string | ISO timestamp |
| notionPageId | string \| null | Notion page ID for sync |
| updatedAt | string \| null | Last edit timestamp |

Entries are unified — a single entry can have text + clips + habits + todos.

### ClipRef
| Field | Type | Description |
|-------|------|-------------|
| uri | string | File path |
| durationMs | number | Duration in milliseconds |

### TodoItem
| Field | Type | Description |
|-------|------|-------------|
| id | string | Generated ID |
| text | string | Item text |
| done | boolean | Checked state |
| completedAt | string \| null | ISO timestamp when checked |

### Habit
| Field | Type | Description |
|-------|------|-------------|
| id | string | e.g. "workout" |
| label | string | Display name |
| emoji | string | Optional emoji |
| sortOrder | number | Order in picker |
| notionPageId | string \| null | Notion page ID |
| updatedAt | string \| null | Last edit timestamp |

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
| updatedAt | string | Last edit timestamp |

### ClipItem (timeline)
| Field | Type | Description |
|-------|------|-------------|
| id | string | Generated ID |
| entryId | string | Source entry |
| clipUri | string | File path |
| caption | string | Display label |
| durationMs | number | Original duration |
| trimStartPct | number | Trim start (0-100) |
| trimEndPct | number | Trim end (0-100) |
| order | number | Position in timeline |
| color | string | Track color |

### TextOverlay
| Field | Type | Description |
|-------|------|-------------|
| id | string | Generated ID |
| text | string | Display text |
| startPct / endPct | number | Duration range (0-100) |
| fontSize | number | 12-48px |
| fontWeight | number | 200-900 |
| lineHeight | number | Line height (10-25) |
| color | string | Text color (default white) |
| textAlign | left \| center \| right | Horizontal alignment |
| position | top \| center \| bottom | Vertical position |

### FilterOverlay
| Field | Type | Description |
|-------|------|-------------|
| id | string | Generated ID |
| filterId | string | Preset ID (moody, cool, film, muted) |
| startPct / endPct | number | Duration range (0-100) |
| brightness | number | Brightness value |
| contrast | number | Contrast value |
| saturate | number | Saturation value |

### Filter Presets
| ID | Label | Brightness | Contrast | Saturate | Tint | Color |
|----|-------|-----------|----------|----------|------|-------|
| none | None | 100 | 100 | 100 | — | #94a3b8 |
| moody | Moody | 90 | 120 | 75 | #1a0a2e | #a78bfa |
| cool | Cool | 100 | 112 | 85 | #001a3a | #38bdf8 |
| film | Film | 95 | 92 | 80 | #2a1a0a | #d4a574 |
| muted | Muted | 100 | 105 | 40 | #1a1a1a | #9ca3af |

### Vlog
| Field | Type | Description |
|-------|------|-------------|
| id | string | Generated ID |
| date | string | Archived day |
| clipCount | number | Number of clips |
| habitCount | number | Number of habits logged |
| caption | string \| null | Auto-generated summary |
| durationSeconds | number | Total duration |
| exportUri | string \| null | Path to exported MP4 |
| createdAt | string | ISO timestamp |

---

## Storage

### SQLite Database
Tables: entries, habits, projects, vlogs, day_meta, sync_deletions

#### entries
| Column | Type |
|--------|------|
| id | TEXT PRIMARY KEY |
| date | TEXT NOT NULL |
| text | TEXT |
| habits_json | TEXT |
| todos_json | TEXT |
| clip_uri | TEXT |
| clip_duration_ms | INTEGER |
| clips_json | TEXT |
| created_at | TEXT NOT NULL |
| notion_page_id | TEXT |
| updated_at | TEXT |

#### habits
| Column | Type |
|--------|------|
| id | TEXT PRIMARY KEY |
| label | TEXT NOT NULL |
| emoji | TEXT |
| sort_order | INTEGER |
| notion_page_id | TEXT |
| updated_at | TEXT |

#### projects
| Column | Type |
|--------|------|
| id | TEXT PRIMARY KEY |
| date | TEXT NOT NULL UNIQUE |
| status | TEXT (draft/exported) |
| clips_json | TEXT |
| text_overlays_json | TEXT |
| filter_overlays_json | TEXT |
| export_uri | TEXT |
| updated_at | TEXT NOT NULL |

#### vlogs
| Column | Type |
|--------|------|
| id | TEXT PRIMARY KEY |
| date | TEXT NOT NULL |
| clip_count | INTEGER |
| habit_count | INTEGER |
| caption | TEXT |
| duration_seconds | INTEGER |
| export_uri | TEXT |
| created_at | TEXT NOT NULL |

#### day_meta
| Column | Type |
|--------|------|
| date | TEXT PRIMARY KEY |
| title | TEXT |
| updated_at | TEXT |

#### sync_deletions
| Column | Type |
|--------|------|
| id | INTEGER PRIMARY KEY AUTOINCREMENT |
| entity_type | TEXT NOT NULL |
| entity_id | TEXT NOT NULL |
| notion_page_id | TEXT NOT NULL |
| deleted_at | TEXT NOT NULL |

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
- Ghost cleanup: removes empty `notion-` prefixed entries before pull
- Deletion sync: processes sync_deletions table, archives pages in Notion

---

## Video Export Pipeline

1. **Trim**: Each clip -> 1080x1920, H.264 baseline, 30fps, AAC 128k
2. **Concatenate**: Concat demuxer (no re-encode)
3. **Filters**: FFmpeg `eq` filter with time-based `enable` expressions + `colorchannelmixer` for tints
4. **Text**: Pre-rendered PNG overlays composited via `overlay` filter
5. **Output**: MP4 with `faststart`, saved to DCIM and share sheet

FFmpeg loaded lazily (234MB native heap) — only on export, not at app startup.

---

## Error Handling

- Root-level React error boundary wraps entire app
- Catches render errors, displays error message with "Try Again" button
- Prevents full app crash from single component failure

---

## Theme

### Colors
- Background: #0c0c0e, #141416, #1c1c1f
- Accent: #e8d5b0 (warm gold), #c4a96a
- Semantic: teal #4caf7d, purple #c46fd4, coral #e05555, amber #d4922a, blue #5b8fe8

### Typography
- Headings: DM Serif Display
- Labels: DM Mono
- Body: Instrument Sans
- Text overlays: Nunito (8 weights), Poppins, TikTok Sans, Varela Round

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
- Empty entry cleanup uses deleteEntry() to track deletions for sync
