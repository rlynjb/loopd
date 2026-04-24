# Loopd Drops — Feature Summary

## What it is

**Drops are inline markers in journal prose that silently extract structured data into typed rows.**

The journal stays prose-first — the user writes naturally, the way they already do. Drop markers are just punctuation-like symbols embedded in that prose. When the entry saves, Loopd scans each line for configured markers, extracts typed fields, and files them as rows in dedicated tables (local SQLite, optionally synced to Notion).

It's conceptually adjacent to markdown — the syntax *feels* like formatting — but it isn't formatting. Markdown decides how text looks. Drops decide what text *means* for downstream storage.

## How the markers work

Three trigger styles, usable independently or combined on the same line.

### Prefix

Line starts with a user-defined marker. The marker can be anything short and non-whitespace (`**`, `--`, `>>`, `#learned`, `::`, `@note`, etc.). Extracts:

- `text` — the content after the marker
- `tags` — trailing `#word` tokens at the end of the line
- `source_entry`, `created_at` — auto

Example: `>> default page size is the hidden Notion perf trap #notion #perf`

### Suffix

A number immediately followed by a unit token (`450 kcal`, `12 reps`, `30 min`). Extracts:

- `value` — the number
- `unit` — the matched suffix
- `context` — the rest of the line
- `source_entry`, `created_at` — auto

Example: `had oatmeal, 320 kcal, plus coffee`

### Checkbox

Line starts with `[ ]` (open) or `[x]` (done) — the standard markdown checkbox with or without a leading `-`. Extracts:

- `text` — the content after the checkbox
- `done` — boolean, true if `[x]`
- `source_entry`, `created_at` — auto

Example: `[ ] email the accountant` → todo, not done
Example: `[x] push the deploy fix` → todo, done

Unlike prefix and suffix, the checkbox trigger is structural rather than a custom marker — its shape is fixed (`[ ]` / `[x]`) because it has a well-established meaning across markdown ecosystems. A user-defined checkbox drop picks only the destination and field mapping, not the marker itself.

### Combining triggers on one line

A single line can carry a prefix trigger and contain a suffix match (or vice versa). They don't conflict; they're scanned independently. The same line can file into two destinations.

Example: `** lunch was light, 420 kcal and felt sluggish after #meal`

- The `**` prefix files a row into the user's Knowledge/Notes destination
- The `420 kcal` suffix files a row into the user's Nutrition destination

Checkbox triggers are line-exclusive — a line that starts with `[ ]` is treated as a todo and not scanned for other triggers, since mixing a todo with a knowledge drop on the same line is almost always a user mistake.

## Hardcoded vs user-defined

Two tiers of drop types live side-by-side in the same pipeline.

**System drops (hardcoded)** — shipped with Loopd, visible in the drops list but not editable. These are the calorie tracker (suffix: `kcal`) and todo detector (checkbox: `[ ]`). They keep working exactly as they do today.

**Custom drops (user-defined)** — the user creates these. For each custom drop type the user:

1. Picks trigger style (prefix, suffix, or checkbox)
2. Defines the marker (`>>`, `**`, `kcal`, etc. — skipped for checkbox since its shape is fixed)
3. Pastes a Notion database ID (the destination they created themselves in Notion)
4. Maps extracted fields (`text`, `tags`, `value`, `done`, etc.) to properties on that destination DB

The destination DB is *user-owned*, not Loopd-managed. Loopd writes into it; the user controls its schema, location, and long-term storage.

## How it flows

```
user writes prose in daily journal
    ↓
on save: scan each line for configured markers
    ↓
match → extract typed fields
    ↓
write row to the destination (SQLite, then sync to Notion DB)
    ↓
unified Drops page queries across all destinations, filterable by type
```

The journal entry itself is unchanged — drops are additive, never destructive. The marker stays in the prose, and the row exists in the destination table. Edit the line, the row updates. Delete the line, the row is archived.

## Why it matters

Three things drops do that a markdown editor can't.

**Typed destinations.** `>> X` is a row in a schema you designed. Not a tag, not a formatted string — a structured record you can sort, filter, and aggregate.

**Capture is filing.** The act of writing the line is the act of storing the knowledge. No separate "file this later" step. No reviewing journal entries to extract learnings into a second system.

**Destinations are user-owned.** Data lives in the user's own Notion databases, not Loopd's proprietary graph. Uninstall Loopd and every drop ever written is still there, structured, in Notion.

## One-line framing

**Markdown formats prose. Drops file prose.** Same surface, opposite purpose — drops use formatting-looking syntax to mark lines as typed data for extraction, not as styling instructions for rendering.
