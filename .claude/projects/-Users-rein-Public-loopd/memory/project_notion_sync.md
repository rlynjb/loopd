---
name: Notion sync requirements
description: Bidirectional Notion sync spec — no mood/category in Notion, no emoji in habits DB, video entries include clip filename
type: project
---

Notion sync is bidirectional (Notion ↔ loopd).

**Journal Entries DB** — exclude Mood and Category properties. Include video entries with just the clip filename (no actual file sync).

**Habits DB** — exclude Emoji property. Keep it simple: Title, Sort Order, loopd ID.

**Why:** User wants Notion as a full sync partner, not just an import source. Mood/category are app-only concerns. Habits don't need emoji in Notion.
**How to apply:** When implementing Notion sync, map mood/category locally only. Push entries to Notion without mood/category. Pull habits without expecting emoji (use a default). Include video entry type with clip filename in text.
