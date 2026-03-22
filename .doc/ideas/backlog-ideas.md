---
title: backlog-ideas
category: ideas
scope: project
---
# Loopd — Backlog Ideas

> Future features and explorations. Not scoped, not committed — just captured.

---

## Rich Journal Inputs

**Handwriting recognition**
Let users write journal entries by hand (stylus or finger) and convert to text. Could use on-device ML (Apple Scribe, Google Handwriting) or a recognition API. The raw handwriting could be stored alongside the transcribed text — some people think differently when they write by hand.

**Video journal / vlog entries**
Short-form video entries (TikTok-style, 15–60s) attached to a day's journal. Record a quick video reflection instead of typing. Could auto-transcribe to text so the improve engine still has something to analyze. Storage implications — Notion Rich Text won't hold video, would need blob storage (Netlify Blobs, S3, Cloudflare R2) with a URL reference in the entry.

**1-minute video vlog summarizer**
At the end of the day (or on demand), Loopd auto-generates a 1-minute video summary of your day — stitching together your journal text (as animated text overlays or voiceover via TTS), habit completion visuals, mood shifts, and improvement cards into a short-form vertical video. Publishable directly to YouTube Shorts and TikTok. Think "daily recap reel" — your loop as content. Could also pull in any video vlog entries recorded during the day as clips in the summary. Export options: save to camera roll, share link, or one-tap publish to connected YouTube/TikTok accounts via their APIs.

**Drawing / sketching canvas**
A freeform canvas layer inside the journal for quick sketches, diagrams, mind maps, or visual thinking. Saved as an image attached to the entry. Useful for people who think spatially — sketch out tomorrow's plan, map a problem, draw a mood.

---

## Digital Stationery

**Stickers**
A sticker picker (emoji-style drawer) where users can drop digital stickers into their journal — mood stickers, achievement badges, decorative elements. Could be a reward mechanism: "7-day streak" sticker auto-unlocks. Mix of built-in stickers and user-uploaded.

**Digital stationery / themes**
Custom backgrounds, paper textures, borders, and decorative elements for the journal screen. Think Hobonichi or bullet journal aesthetics — dot grid, kraft paper, lined, graph. Could be seasonal or unlockable. The journal should feel personal, not just functional.

**Washi tape / dividers**
Decorative dividers between journal sections. User drags a washi tape strip to visually separate morning plans from afternoon thoughts from evening reflection. Purely aesthetic but makes the journal feel crafted.

---

## Notes

- These features all push the journal from "productivity tool" toward "personal artifact" — something you'd want to revisit, not just process.
- Video and handwriting both need transcription pipelines to feed the improve engine. Without text, the engine can't analyze.
- The video summarizer needs a rendering pipeline (ffmpeg or Remotion) to compose text overlays, habit visuals, and clips into a vertical video. YouTube Data API and TikTok Content Posting API handle publishing. OAuth flow required for each platform.
- Stationery and stickers are low-cost, high-delight features that could drive retention without any backend complexity.
- All of these are post-v1. The current unified journal (text + mood + prompts) ships first.