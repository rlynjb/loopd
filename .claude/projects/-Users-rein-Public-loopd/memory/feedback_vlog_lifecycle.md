---
name: Vlog lifecycle rules
description: Today's vlog stays open until midnight. Previous vlogs show all past days regardless of export status. Previous vlogs can be reopened for export.
type: feedback
---

Do not move today's vlog to "Previous Vlogs" on export. Today's vlog stays active/continuable until 12:00 AM midnight.

At midnight (or on next app open when the date has changed), the previous day automatically becomes a "Previous Vlog" entry — even if no video was exported.

Previous vlogs should be openable so users can revisit and export.

**Why:** User wants the daily vlog to remain open for the full day. Export is not "closing" the day — it's just rendering a video. The day closes at midnight naturally.
**How to apply:** Don't create a vlog history entry on export. Create it when the date rolls over (detected on app open). Always show past days in history, regardless of export status.
