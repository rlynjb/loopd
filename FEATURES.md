# loopd — Features & Use Cases

## Daily Vlogging

Capture your day through video clips, journal entries, and habit tracking — all in one timeline.

- **Video clips** — Import clips from your camera roll. Add multiple clips per entry. Thumbnails preview in the timeline.
- **Journal entries** — Write freely about your day. Edit entries anytime by tapping them.
- **Habit tracking** — Check off daily habits. See your streak count in the header.
- **Timeline view** — All entries for the day in chronological order with type badges and timestamps.

## Video Editor

A lightweight NLE-style editor built for vertical (9:16) vlogs.

- **Multi-track timeline** — Clip track, text overlay track, and color adjustment track.
- **Trim clips** — Drag left/right handles on clips in the timeline to trim.
- **Split clips** — Position the playhead and tap Split to cut a clip in two.
- **Reorder clips** — Move clips left/right in the timeline.
- **Color adjustments** — Add brightness, contrast, and saturation overlays with timing control.
- **Text overlays** — Add styled text with size, weight, and color options.
- **Video preview** — 9:16 preview player shows your clip at the playhead position.
- **Draggable playhead** — Scrub through your timeline by dragging the playhead.
- **Real export** — FFmpeg-powered export renders a real MP4 video file (1080x1920, H.264/AAC).
- **Auto-save to device** — Exported videos save to DCIM/loopd_vlogs on your phone.
- **Share anywhere** — Share sheet opens after export for TikTok, Instagram, WhatsApp, Google Drive, etc.
- **Save drafts** — Save your editor state and come back to it later.

## Notion Sync

Bidirectional sync between loopd and Notion. Your phone captures, your laptop reviews.

### What syncs

| From loopd to Notion | From Notion to loopd |
|---|---|
| Journal entries with full text | Journal entries created on desktop |
| Habit check-ins | Habit checkboxes toggled in Notion |
| Video clip metadata (filenames) | Entries edited or added in Notion |
| Daily summary (auto-generated) | — |

### Two-table setup

**Entries Database** — One row per capture. Syncs bidirectionally with the app's timeline entries.

**Daily Log Database** (optional) — One row per day with habit checkboxes. Auto-populated from your entries. Works as your habit tracker dashboard in Notion.

### Use cases

**Journal from your laptop**
Type longer journal entries in Notion's editor. They sync to loopd's timeline on your phone. Great for morning planning or evening reflection when you're at your desk.

**Check habits from desktop**
Working at your computer all day? Check off habits directly in your Notion daily log. They'll appear in loopd next time you open the app.

**Capture on the go, review on desktop**
Record video clips and quick thoughts from your phone throughout the day. Later, sit down at your laptop and review everything in Notion's full-width table view.

**Auto-generated daily summaries**
Each day gets a row in your Daily Log showing how many clips you recorded, journals you wrote, and habits you checked. No manual entry needed.

**Bulk edit entries**
Made a bunch of entries with typos? Open your Notion Entries table and edit them all at once. Changes sync back to the app.

**Search across everything**
Notion's search finds any journal text across all days instantly. Filter by entry type, date range, or habit.

**Share with an accountability partner**
Share your Notion Daily Log page with a friend or coach. They see your habits and journal without touching your phone.

**Calendar and board views**
Use Notion's built-in views to see your entries by week, month, or filtered by type. Create a board view grouped by entry type.

**Connect to your existing Notion workspace**
Link entries to project pages, meeting notes, or goal trackers already in your Notion. Your daily captures become part of your bigger system.

**Automatic cloud backup**
Everything you capture in loopd is backed up to Notion automatically. Searchable, filterable, exportable to CSV or PDF anytime.

**Build and share templates**
Your Notion database setup becomes a distributable template. Other loopd users can duplicate it and start syncing immediately.

### Sync details

- **Bidirectional** — Changes flow both ways. Edit in either place.
- **Conflict resolution** — Last edit wins. If you edit the same entry in both places, the most recent change takes priority.
- **Auto-sync** — Optionally sync every time you open the app.
- **Manual sync** — Tap "Sync Now" in Settings anytime.
- **Offline-safe** — If you're offline, entries save locally and sync when you're back online.
- **Deletion sync** — Delete an entry in loopd, it archives in Notion. Delete in Notion, it removes from loopd.

## Home Screen

- **Today's vlog card** — Shows entry count, clip/journal/habit breakdown, and category icons for the current day.
- **Continue Today's Vlog** — One tap to jump back into your day's timeline.
- **Previous Vlogs** — Browse past days. Tap any to revisit and re-export.
- **Auto-archive** — Past days automatically appear in Previous Vlogs at midnight.

## Design

- **Dark theme** — Near-black background (#0c0c0e) with warm gold accents.
- **Lucide icons** — Consistent outline icons throughout, no emojis.
- **Editorial typography** — DM Serif Display (headings), DM Mono (labels), Instrument Sans (body).
- **Solid backgrounds** — Clean, distraction-free interface.
