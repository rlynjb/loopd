# Media Pipeline

Technical specification for how loopd handles video clips — from capture
through preview, editing, and export — and how they're stored for backup
and cross-device migration.

## Principles

- **Originals stay untouched.** The user's master footage lives in the
  system gallery (DCIM on Android, Photos on iOS). loopd never moves,
  overwrites, or deletes it.
- **One working copy per clip.** On capture, loopd transcodes to a
  standardized 1080p H.264 MP4 "proxy" that becomes the sole reference
  for every in-app operation (preview, trim, filters, text overlays,
  export).
- **Flat, portable storage.** All proxies live in a single folder keyed
  by stable clip IDs, so backup is "copy one folder" and restore is
  "drop it in and re-index".
- **Social-optimized, not archival.** 1080p matches what TikTok /
  Instagram / Reels export at. If a user wants the 4K master they open
  it from their camera roll; loopd is deliberately lossy on import.

## Storage Layout

```
{DocumentsDir}/loopd/
├─ media/                         # flat, all proxies, shared across dates
│  ├─ m-{ts}-{rand}.mp4           # one file per captured clip
│  └─ m-{ts}-{rand}.mp4
├─ exports/
│  └─ {YYYY-MM-DD}/
│     └─ vlog-{YYYY-MM-DD}.mp4    # final rendered vlogs
└─ temp/                          # FFmpeg scratch (cleared between exports)
```

- `media/` is **flat** — no date subdirs. Filenames use `generateId('m')`
  which produces `m-{base36-timestamp}-{base36-rand6}`. This is the
  durable clip ID; the DB references clips by full file URI
  (`file://…/loopd/media/m-xxx.mp4`).
- `exports/` remains date-keyed for user discoverability.
- `temp/` is disposable; wiped at the start/end of each export.

## Capture Flow

```
ImagePicker.launchCameraAsync / launchImageLibraryAsync
        │
        ▼
ImagePickerAsset { uri, duration }
        │
        ├─ recordClip only: MediaLibrary.createAssetAsync → DCIM/loopd
        │  (preserves untouched master — original stays at camera quality)
        │
        ▼
transcodeToProxy(assetUri)                       ← src/services/fileManager.ts
        │
        │   FFmpeg command:
        │   -i <source>
        │   -vf "scale=…(fit within 1080x1920, keep aspect, never upscale)"
        │   -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p
        │   -c:a aac -b:a 128k -ar 44100 -ac 2
        │   -movflags +faststart
        │
        ▼
file://{docs}/loopd/media/{clipId}.mp4
        │
        ▼
Entry.clips[].uri = <proxy uri>                  ← stored in SQLite
Entry.clips[].durationMs = <from picker>
```

## Proxy Encoding Parameters

| Parameter           | Value                                    | Rationale                                          |
| ------------------- | ---------------------------------------- | -------------------------------------------------- |
| Container           | MP4 + faststart                          | Universal; streamable                              |
| Video codec         | H.264 High                               | Hardware-decoded everywhere; ExoPlayer-friendly    |
| Pixel format        | yuv420p                                  | Required for broad compatibility (incl. web)       |
| Max long edge       | 1920 px                                  | Matches TikTok/IG export targets                   |
| Max short edge      | 1080 px                                  | Keeps 9:16 portrait intact                         |
| Upscaling           | Disabled (`force_original_aspect_ratio=decrease`) | Never expand small sources                 |
| Even dimensions     | `pad=ceil(iw/2)*2:ceil(ih/2)*2`          | H.264 requires even width/height                   |
| Bitrate mode        | CRF 23 (libx264 preset `fast`)           | ~3-5 MB for a typical short vlog clip              |
| Audio codec         | AAC-LC 128 kbps stereo 44.1 kHz          | Mobile standard                                    |

Values are centralized as constants (`PROXY_MAX_LONG_EDGE`,
`PROXY_MAX_SHORT_EDGE`, `PROXY_CRF`) at the top of
`src/services/fileManager.ts` for easy tuning.

## Why 1080p (and not 4K)

The editor's preview layer uses **two simultaneous `<Video>` instances**
(ping-pong double-buffer — see `src/components/editor/PreviewPlayer.tsx`)
to deliver cut-on-the-frame clip transitions without a source-change
reload flicker. Android's MediaCodec can sustain two concurrent 1080p
decoders comfortably on modern flagships, but struggles with two
concurrent 4K HDR10 streams (Samsung S22 Ultra example: transitions
stalled up to ~1s per clip change with 4K sources).

Transcoding at import trades ~2-5s of one-time CPU against perfectly
smooth subsequent edit sessions. It also makes the exported vlog ~10×
smaller, closer to what users expect from TikTok-class apps.

## Backup & Restore

Because `media/` is flat and self-contained:

**Backup**
- User copies `{DocumentsDir}/loopd/media/` off the device (cloud, USB,
  adb pull, whatever). It's just a folder of MP4 files.
- SQLite DB backup (existing feature: Settings → Export Database)
  carries the clip URIs that reference those files.

**Restore on a new install / new phone**
1. User installs loopd on the target device.
2. User imports the DB backup via Settings.
3. User drops the `media/` folder into `{DocumentsDir}/loopd/media/`
   (same path on the new device).
4. App launches — URIs resolve, clips load.

**Path portability note.** `{DocumentsDir}` resolves to a different
absolute path on each install, but loopd stores clip URIs as full
`file://…` strings. If the app's sandbox path changes (e.g.
reinstalled, different Android user profile), clips will appear
"missing". The current mitigation is the in-UI "re-import" option per
clip. A follow-up would be to store a path relative to `{docs}/loopd/`
and resolve at load time — see **Future Work** below.

## What's Captured vs. Discarded

| Property                       | Kept?  | Notes                                   |
| ------------------------------ | ------ | --------------------------------------- |
| Original resolution (up to 4K) | No     | Downscaled to 1080p bounding box        |
| HDR10 / Dolby Vision metadata  | No     | Stripped by re-encode                   |
| High frame rate (60/120 fps)   | No     | Normalized by H.264 re-encode           |
| Audio track                    | Yes    | Re-encoded AAC 128 kbps                 |
| Aspect ratio / orientation     | Yes    | Preserved via `force_original_aspect_ratio=decrease` |
| Original at DCIM               | Yes    | For camera captures; untouched          |

Anyone wanting a pristine original opens it from the camera roll —
that's the "archival" path and it's outside loopd's concern.

## Failure Modes

`transcodeToProxy` falls back to returning the source URI if FFmpeg
fails. The editor still works but loses the double-buffer benefit (and
on slow sources, transitions stutter). Failures log with `[loopd]
Transcode failed` and the last FFmpeg log lines for diagnosis.

## Migration From Old Layout

Pre-proxy clips (captured before this change) live at
`{docs}/loopd/clips/{YYYY-MM-DD}/{filename}.mp4`. Their URIs are still
stored in the DB and still work — `PreviewPlayer` and `exportPipeline`
treat them identically. No forced migration is performed. A later
"re-encode older clips" pass could walk the DB and transcode any clip
whose URI is outside `/loopd/media/`, but this is not currently
implemented.

## Export Pipeline (Reference)

Implemented in `src/services/exportPipeline.ts`. Uses the proxies as
input, so each pass works against the already-1080p material:

1. **Trim + scale/pad** each clip to 1080×1920 canvas
2. **Concat** via FFmpeg concat demuxer (no re-encode unless needed)
3. **Filter** (brightness / contrast / saturate + color tint) if any
   filter overlays exist
4. **Text** overlays — one PNG overlay per text, composited in
   sequential passes

Output: `{docs}/loopd/exports/{date}/vlog-{date}.mp4`, then optionally
saved into DCIM via `MediaLibrary.createAssetAsync` and handed to the
system share sheet.

## Future Work

- **Relative path storage.** Replace absolute `file://` URIs in the DB
  with paths relative to `{docs}/loopd/` so restores survive sandbox
  path changes without re-import.
- **Background transcode queue.** For bulk imports, queue multiple
  transcodes so the UI doesn't block for each one sequentially.
- **Adaptive proxy quality.** Detect device capability and output 720p
  on lower-end phones for faster transcoding.
- **Original-backed re-export.** Keep a link to the DCIM original so
  the user can choose "export from master" on request (opt-in,
  significantly slower).
- **Old-layout migration.** One-time pass to re-encode
  `clips/{date}/...` clips into `media/` and update DB references.

## File Reference

| File                                       | Purpose                                          |
| ------------------------------------------ | ------------------------------------------------ |
| `src/services/fileManager.ts`              | Capture, transcode, path helpers                 |
| `src/services/ffmpeg.ts`                   | Lazy FFmpeg loader + path quoting                |
| `src/services/exportPipeline.ts`           | Final vlog render                                |
| `src/components/capture/CaptureSheet.tsx`  | UI during pick/record + processing state         |
| `src/components/editor/PreviewPlayer.tsx`  | Double-buffered preview playback                 |
| `src/types/entry.ts`                       | `ClipRef` — the stored clip reference            |
| `src/types/project.ts`                     | `ClipItem` — editor-time clip with trim/overlays |
