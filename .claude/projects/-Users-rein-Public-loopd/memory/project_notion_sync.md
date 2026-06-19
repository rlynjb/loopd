---
name: Notion sync requirements
description: Bidirectional Notion sync — two-table approach (Daily Log + Entries), habit checkboxes on daily log, entries table for captures
type: project
---

Notion sync is bidirectional (Notion ↔ loopd) using **two related Notion tables**:

**Table 1: Daily Log** — one row per day, habit checkbox columns, daily summary. User's existing habit tracker format.
**Table 2: Entries** — multiple rows per day, maps to loopd captures (clip/journal/habit).

Daily Log is auto-populated from Entries data on sync. Entries table is the primary sync target.

User plans to create a Notion template from this — use standard Notion template patterns (relational tables, checkbox habits on daily log).

**Why:** User already has a Notion habit tracker with checkbox columns per habit. Two-table approach preserves that workflow while adding detailed entry tracking.
**How to apply:** Sync entries bidirectionally with Table 2. Aggregate habit completions and summaries into Table 1 on push. Pull from both tables.
