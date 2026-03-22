---
title: 4th-plan
category: plans
scope: project
---
# loopd — Build Plan for Claude Code

> **What this is:** A complete implementation plan for building loopd, a mobile daily vlogging app for Android. Feed this entire document to Claude Code as your starting prompt.

---

## Project Overview

**loopd** is a daily vlogging app that combines a story journal (timeline of daily entries), habit tracking, and a lightweight video editor — all in one vertical workflow. Users capture moments throughout their day (clips, journal entries, habits, mood/category moments), then at end-of-day they arrange clips in a timeline editor with text overlays, color filters, and trimming, and export a final vertical (9:16) vlog.

**This is NOT a camera app.** Users record clips with their native phone camera, then import them into loopd as timeline entries.

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Framework | React Native + Expo (SDK 52+) | TypeScript, fast iteration, Android builds |
| Language | TypeScript (strict mode) | Developer preference, type safety |
| Navigation | Expo Router (file-based) | Familiar pattern from Next.js |
| Video Playback | `react-native-video` (v6) | Preview clips in editor |
| Video Processing | `ffmpeg-kit-react-native` | Trim, concat, filters, text overlay, export |
| Local Storage | `expo-sqlite` | Structured data (entries, projects, habits) |
| File Storage | `expo-file-system` | Clip files, exports, project assets |
| Gestures | `react-native-gesture-handler` + `react-native-reanimated` | Timeline scrubbing, drag interactions |
| Styling | NativeWind (Tailwind for RN) or StyleSheet | Developer preference, keep consistent |

### Important: Expo Development Build (not Expo Go)

Since we use `ffmpeg-kit-react-native` and `react-native-video`, we need a **custom dev build**, not Expo Go. Set up with:
```bash
npx expo prebuild
npx expo run:android
```

---

## Architecture Principles

1. **Feature-first directory structure** — not layer-first
2. **Offline-first** — all data stored locally, no network dependency
3. **File-based project format** — each day is a folder with JSON + video files, easy to backup
4. **Thin screens, fat modules** — screens are layout wrappers, logic lives in hooks and services
5. **Progressive complexity** — build the journal/capture flow first, then layer on the video editor

---

## Directory Structure

```
loopd/
├── app/                          # Expo Router screens
│   ├── _layout.tsx               # Root layout (providers, fonts)
│   ├── index.tsx                 # Home screen (slogan + past vlogs)
│   ├── journal/
│   │   └── [date].tsx            # Journal/timeline for a specific day
│   └── editor/
│       └── [date].tsx            # Video editor for a specific day
├── src/
│   ├── components/
│   │   ├── ui/                   # Reusable primitives (Button, Chip, Card)
│   │   ├── timeline/
│   │   │   ├── TimelineEntry.tsx
│   │   │   ├── TimelineList.tsx
│   │   │   └── CaptureCard.tsx   # Inline capture options at bottom of timeline
│   │   ├── capture/
│   │   │   ├── CaptureSheet.tsx  # Bottom sheet for capture flow
│   │   │   ├── ClipCapture.tsx
│   │   │   ├── JournalCapture.tsx
│   │   │   ├── HabitCapture.tsx
│   │   │   └── MomentCapture.tsx
│   │   ├── editor/
│   │   │   ├── EditorTimeline.tsx    # NLE timeline with proportional clips
│   │   │   ├── ClipTrack.tsx         # Video clip track
│   │   │   ├── TextTrack.tsx         # Text overlay track
│   │   │   ├── FilterTrack.tsx       # Filter overlay track
│   │   │   ├── TimeRuler.tsx         # Timecode ruler
│   │   │   ├── Playhead.tsx          # Scrubber/playhead
│   │   │   ├── PreviewPlayer.tsx     # 9:16 vertical preview
│   │   │   ├── ClipEditor.tsx        # Edit panel (caption, trim, reorder)
│   │   │   ├── TextEditor.tsx        # Text overlay editor (content, size, weight, color, timing)
│   │   │   ├── FilterEditor.tsx      # Filter editor (preset, brightness, contrast, saturation, timing)
│   │   │   └── ExportModal.tsx       # Export progress modal
│   │   └── home/
│   │       ├── HomeHeader.tsx
│   │       ├── PastVlogCard.tsx
│   │       └── HabitStreak.tsx
│   ├── hooks/
│   │   ├── useDatabase.ts        # SQLite setup and migrations
│   │   ├── useEntries.ts         # CRUD for daily entries
│   │   ├── useHabits.ts          # Read habits (later: Notion sync)
│   │   ├── useProject.ts         # Video editor project state
│   │   ├── useFFmpeg.ts          # FFmpeg command builder and executor
│   │   └── useExport.ts          # Export pipeline with progress
│   ├── services/
│   │   ├── database.ts           # SQLite schema, queries, migrations
│   │   ├── fileManager.ts        # File operations (copy clips, manage day folders)
│   │   ├── ffmpeg.ts             # FFmpeg command construction
│   │   └── exportPipeline.ts     # Full export: trim → concat → filters → text → encode
│   ├── types/
│   │   ├── entry.ts              # Entry, Clip, Journal, Habit, Moment types
│   │   ├── project.ts            # EditorProject, ClipItem, TextOverlay, FilterOverlay
│   │   └── common.ts             # Shared types (Mood, Category, etc.)
│   ├── constants/
│   │   ├── moods.ts
│   │   ├── categories.ts
│   │   ├── filters.ts            # Filter presets (Vivid, Moody, Warm, Cool, Noir)
│   │   └── theme.ts              # Colors, fonts, spacing
│   └── utils/
│       ├── time.ts               # formatTime, formatDate, formatDuration
│       └── id.ts                 # generateId utility
├── assets/
│   └── fonts/                    # Syne, JetBrains Mono, Inter
├── app.json                      # Expo config
├── tsconfig.json
└── package.json
```

---

## Data Model

### SQLite Schema

```sql
-- Habits (pre-populated, later synced from Notion)
CREATE TABLE habits (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  emoji TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

-- Daily entries (the journal timeline)
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,              -- "2026-03-22"
  type TEXT NOT NULL,              -- "video" | "journal" | "habit" | "moment"
  text TEXT,                       -- caption, note, or journal content
  mood TEXT,                       -- "calm" | "chaotic" | "focused" | "energized" | null
  category TEXT,                   -- "coding" | "gym" | "food" | etc. | null
  habits_json TEXT,                -- JSON array of habit IDs (for habit entries)
  clip_uri TEXT,                   -- local file path for video clips
  clip_duration_ms INTEGER,        -- clip duration in milliseconds
  created_at TEXT NOT NULL         -- ISO timestamp
);

-- Editor projects (one per day, stores timeline state)
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,       -- "2026-03-22"
  status TEXT DEFAULT 'draft',     -- "draft" | "exported"
  clips_json TEXT,                 -- JSON: array of ClipItem
  text_overlays_json TEXT,         -- JSON: array of TextOverlay
  filter_overlays_json TEXT,       -- JSON: array of FilterOverlay
  export_uri TEXT,                 -- path to exported video
  updated_at TEXT NOT NULL
);

-- Past vlogs (history feed on home screen)
CREATE TABLE vlogs (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  clip_count INTEGER DEFAULT 0,
  habit_count INTEGER DEFAULT 0,
  mood TEXT,
  caption TEXT,
  categories_json TEXT,            -- JSON array of category strings
  duration_seconds INTEGER,
  export_uri TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_entries_date ON entries(date);
CREATE INDEX idx_projects_date ON projects(date);
```

### TypeScript Types

```typescript
// src/types/entry.ts
type EntryType = 'video' | 'journal' | 'habit' | 'moment';

type Entry = {
  id: string;
  date: string;           // "2026-03-22"
  type: EntryType;
  text: string | null;
  mood: string | null;
  category: string | null;
  habits: string[];       // habit IDs
  clipUri: string | null;
  clipDurationMs: number | null;
  createdAt: string;      // ISO
};

// src/types/project.ts
type ClipItem = {
  id: string;
  entryId: string;        // links to the entry
  clipUri: string;
  caption: string;
  durationMs: number;
  trimStartPct: number;   // 0-100
  trimEndPct: number;     // 0-100
  order: number;
};

type TextOverlay = {
  id: string;
  text: string;
  startPct: number;       // 0-100 position on timeline
  endPct: number;
  fontSize: number;
  fontWeight: 300 | 400 | 700;
  color: string;          // hex
};

type FilterOverlay = {
  id: string;
  filterId: string;       // "vivid" | "moody" | "warm" | "cool" | "noir"
  startPct: number;
  endPct: number;
  brightness: number;     // 50-150
  contrast: number;       // 50-150
  saturate: number;       // 0-200
};

type EditorProject = {
  id: string;
  date: string;
  status: 'draft' | 'exported';
  clips: ClipItem[];
  textOverlays: TextOverlay[];
  filterOverlays: FilterOverlay[];
  exportUri: string | null;
  updatedAt: string;
};
```

---

## File Storage Layout

```
{DocumentDirectory}/loopd/
├── clips/
│   └── 2026-03-22/
│       ├── clip-001.mp4          # Imported from camera roll
│       ├── clip-002.mp4
│       └── clip-003.mp4
├── exports/
│   └── 2026-03-22/
│       └── vlog-2026-03-22.mp4   # Final exported vertical video
└── temp/                         # FFmpeg intermediate files (cleaned on export complete)
```

When a user adds a clip entry, the app copies the video from the device's media library to `clips/{date}/` so it's self-contained. The original stays in the camera roll.

---

## Build Phases

### Phase 1: Foundation + Journal (Week 1)

**Goal:** Home screen, journal timeline, all 4 capture types working, local persistence.

Tasks:
1. Initialize Expo project with TypeScript, install all dependencies
2. Set up Expo Router with `app/` directory (index, journal/[date], editor/[date])
3. Implement SQLite database service with schema and migrations
4. Build the home screen: loopd header, "Plan. Capture. Reflect. Think." slogan, "Start Today's Vlog" button
5. Build the journal timeline screen:
   - Header with back button, loopd logo, habit streak indicator
   - Scrollable timeline with TimelineEntry components
   - Inline CaptureCard at bottom with 4 options (Clip, Journal, Habit, Moment)
   - Fixed "CLOSE DAY" button at bottom
6. Build CaptureSheet as a bottom sheet with 4 capture flows:
   - **Clip:** opens device media picker (`expo-image-picker` with video), copies file to local storage, saves entry with clipUri and duration
   - **Journal:** textarea, saves directly
   - **Habit:** inline chips (from habits table), optional note, saves directly
   - **Moment:** mood chips + category chips + optional note, saves directly
7. Seed habits table with defaults: Workout, Study, Vlog, Meditate, Read
8. All entries persist in SQLite and reload on app reopen

**Acceptance criteria:** User can start a day, add entries of all 4 types, see them on the timeline, navigate back to home, and start a new day. Video clips are imported from camera roll and stored locally. Data persists across app restarts.

### Phase 2: History + Project Persistence (Week 2)

**Goal:** Past vlogs feed, saving editor projects as drafts, day-to-day continuity.

Tasks:
1. Build the PastVlogCard component and history feed on home screen
2. Implement vlogs table — when user closes a day, save summary to vlogs
3. Previous vlogs show on home with date (relative), mood dot, caption, clip/habit counts, category emojis, duration
4. Implement project persistence — when entering the editor, create or load a project for that date
5. "Save Draft" from editor saves project state to SQLite and returns to journal
6. Re-entering editor loads the saved project state (clips, text overlays, filter overlays, trim points)
7. Tapping a past vlog from home opens it in read-only journal view

**Acceptance criteria:** Home screen shows history of previous days. Editor state persists between sessions. User can save draft, close app, reopen, and resume editing.

### Phase 3: Video Editor — Timeline UI (Week 3)

**Goal:** Functional NLE-style timeline with clip manipulation.

Tasks:
1. Build the editor screen layout: top bar, 9:16 preview area, transport controls, timeline, bottom bar (Save Draft + Export & Close)
2. Pre-load video clips from that day's entries into the timeline
3. Build the NLE timeline with 3 tracks:
   - **Text track (T):** positioned text overlay blocks
   - **Filter track (FX):** positioned filter overlay blocks  
   - **Clip track:** proportional-width clip blocks based on duration, with waveform visualization
4. Implement the playhead — tap timeline to seek, animated playback
5. Build the timecode ruler above tracks
6. Clip selection — tap a clip block to select it, playhead jumps to clip start
7. ClipEditor panel: caption editing, trim IN/OUT sliders with waveform visualization, reorder (move left/right), delete
8. Add new clips from within the editor (opens media picker)

**Acceptance criteria:** Editor shows all video clips from the day in a proportional timeline. User can select, reorder, trim, delete, and add clips. All changes reflect immediately in the timeline visualization.

### Phase 4: Video Editor — Text + Filter Overlays (Week 4)

**Goal:** Text and filter overlay editing on the timeline.

Tasks:
1. TextEditor panel: content input, font size slider (12-48px), weight buttons (Thin/Normal/Bold), color swatches (6 colors), start/end timing sliders, live preview
2. Text overlay blocks on text track — add, select, edit, delete, resize timing
3. FilterEditor panel: filter type preset picker (Vivid, Moody, Warm, Cool, Noir), brightness/contrast/saturation sliders, reset to preset, start/end timing sliders
4. Filter overlay blocks on filter track — add, select, edit, delete
5. 9:16 Preview player:
   - Shows current clip at playhead position via `react-native-video`
   - Applies CSS-like filter to the video view based on active filter overlay at playhead
   - Renders text overlays on top of video when visible at playhead position
6. Preview updates in real-time as user adjusts text/filter properties

**Acceptance criteria:** User can add text overlays with custom styling and timing. User can add filter overlays with presets and manual adjustments. Preview accurately shows the composition at the current playhead position.

### Phase 5: FFmpeg Export Pipeline (Week 5)

**Goal:** Render final 9:16 vertical video using FFmpeg.

The export pipeline runs these FFmpeg operations in sequence:

```
Step 1: Trim each clip to its IN/OUT points
  ffmpeg -i clip-001.mp4 -ss {startSec} -to {endSec} -c copy trimmed-001.mp4

Step 2: Scale all clips to 1080x1920 (9:16)
  ffmpeg -i trimmed-001.mp4 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black" scaled-001.mp4

Step 3: Concatenate clips in timeline order
  ffmpeg -f concat -safe 0 -i filelist.txt -c copy concat.mp4

Step 4: Apply filter overlays (time-ranged color grading)
  ffmpeg -i concat.mp4 -vf "
    eq=brightness={b1}:contrast={c1}:saturation={s1}:enable='between(t,{start1},{end1})',
    eq=brightness={b2}:contrast={c2}:saturation={s2}:enable='between(t,{start2},{end2})'
  " filtered.mp4

Step 5: Burn in text overlays
  ffmpeg -i filtered.mp4 -vf "
    drawtext=text='{text1}':fontsize={size1}:fontcolor={color1}:x=(w-text_w)/2:y=h-th-100:enable='between(t,{start1},{end1})',
    drawtext=text='{text2}':fontsize={size2}:fontcolor={color2}:x=(w-text_w)/2:y=h-th-100:enable='between(t,{start2},{end2})'
  " output.mp4

Step 6: Final encode (H.264, AAC, optimized for mobile)
  ffmpeg -i output.mp4 -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k -movflags +faststart final.mp4
```

Tasks:
1. Build `ffmpeg.ts` — command builder that generates FFmpeg commands from project state
2. Build `exportPipeline.ts` — orchestrates the pipeline, runs each step, reports progress
3. Build `useExport.ts` hook — manages export state, progress percentage, stage labels
4. Build ExportModal component — fullscreen overlay with progress ring, percentage, stage text, clip/text/filter counts
5. On export complete: save export path to project, create vlog entry, navigate to home
6. Clean up temp files after export

**Acceptance criteria:** User taps "Export & Close", sees progress modal with accurate stages, gets a final 1080x1920 MP4 video saved to device. Video plays correctly with all trims, filters, and text overlays applied.

### Phase 6: Polish + Backup (Week 6)

Tasks:
1. Add share functionality — share exported video to TikTok, Instagram, etc. via `expo-sharing`
2. Implement backup: export day folder (project.json + clips + export.mp4) as a zip, share to Google Drive or any cloud
3. Import: read a backup zip and restore a day's project
4. Add haptic feedback on interactions (`expo-haptics`)
5. Loading states, error handling, edge cases (no clips, corrupt video, etc.)
6. App icon, splash screen, final theme polish

---

## Key Implementation Notes

### Importing Clips from Camera Roll
```typescript
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';

const pickClip = async (date: string): Promise<{ uri: string; duration: number } | null> => {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Videos,
    quality: 1,
  });
  if (result.canceled) return null;
  
  const asset = result.assets[0];
  const destDir = `${FileSystem.documentDirectory}loopd/clips/${date}/`;
  await FileSystem.makeDirectoryAsync(destDir, { recursive: true });
  
  const filename = `clip-${Date.now()}.mp4`;
  const destUri = `${destDir}${filename}`;
  await FileSystem.copyAsync({ from: asset.uri, to: destUri });
  
  return { uri: destUri, duration: asset.duration ?? 0 };
};
```

### FFmpeg Command Builder Pattern
```typescript
// src/services/ffmpeg.ts
import { FFmpegKit, ReturnCode } from 'ffmpeg-kit-react-native';

export const trimClip = async (
  inputUri: string, 
  startSec: number, 
  endSec: number, 
  outputUri: string
): Promise<boolean> => {
  const cmd = `-i "${inputUri}" -ss ${startSec} -to ${endSec} -c copy "${outputUri}"`;
  const session = await FFmpegKit.execute(cmd);
  const code = await session.getReturnCode();
  return ReturnCode.isSuccess(code);
};
```

### Project JSON Format (for backup/restore)
```json
{
  "version": 1,
  "date": "2026-03-22",
  "entries": [...],
  "project": {
    "clips": [...],
    "textOverlays": [...],
    "filterOverlays": [...]
  },
  "files": {
    "clips": ["clip-001.mp4", "clip-002.mp4"],
    "export": "vlog-2026-03-22.mp4"
  }
}
```

---

## Dependencies to Install

```bash
# Core
npx create-expo-app loopd --template expo-template-blank-typescript
cd loopd

# Navigation
npx expo install expo-router expo-linking expo-constants

# Video
npm install react-native-video
npm install ffmpeg-kit-react-native

# Storage
npx expo install expo-sqlite expo-file-system

# Media picker
npx expo install expo-image-picker

# Gestures and animations
npx expo install react-native-gesture-handler react-native-reanimated

# UI
npx expo install expo-haptics expo-sharing expo-font

# Prebuild for native modules
npx expo prebuild
```

---

## Design Tokens (from prototype)

```typescript
// src/constants/theme.ts
export const colors = {
  bg: '#000000',
  teal: '#00d9a3',
  tealDark: '#00b88a',
  purple: '#a78bfa',
  coral: '#fb7185',
  amber: '#fbbf24',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textDim: '#64748b',
  textDimmer: '#475569',
  cardBg: 'rgba(255,255,255,0.03)',
  cardBorder: 'rgba(255,255,255,0.06)',
};

export const fonts = {
  heading: 'Syne',       // 500-800
  mono: 'JetBrainsMono', // 400-700
  body: 'Inter',         // 400-600
};
```

---

## What NOT to build yet

- Notion integration (Phase 2 of the product, not the app build)
- AI caption generation / reflection engine
- Social features / sharing profiles
- Auto vlog builder (AI-suggested clip selection)
- Cloud sync (manual backup/restore is enough for now)

---

## Reference

The interactive prototype is available in the conversation history. It demonstrates:
- Home screen with past vlogs feed
- Journal timeline with 4 capture types (Clip, Journal, Habit, Moment)
- Full video editor with NLE timeline (clip track, text track, filter track)
- Proportional clip blocks, playhead, timecode ruler
- Text overlay editor (size, weight, color, timing)
- Filter overlay editor (presets, brightness/contrast/saturation, timing)
- 9:16 vertical preview
- Export progress modal
- Habit streak in header

Use the prototype as the source of truth for UI layout, interaction patterns, and feature scope. Match its design language (black background, teal/purple/coral/amber accents, Syne/JetBrains Mono/Inter fonts).