# TODO

Open work, grouped by urgency. Checkpointed 2026-04-19 after the vlog
editor / media-pipeline sprint.

---

## Editor & Media Pipeline

- [ ] **Migrate older clips to 1080p proxies.** Clips captured before the
  transcode-on-import change live at `{docs}/loopd/clips/{date}/…` at
  original (usually 4K) resolution. They still play, but the editor's
  double-buffer preview stutters on them. One-time pass: walk the DB,
  transcode any clip URI outside `loopd/media/`, rewrite references.
  Tracked as "Old-layout migration" in
  [docs/media-pipeline.md](docs/media-pipeline.md).

- [ ] **Residual transition jitter on fast scrubs.** Stuck-state bugs
  (Reanimated worklet ref, `userScrollingSV` drift, stale
  `pendingTransitionRef`) are fixed. What's left is inherent to two
  concurrent Android `MediaCodec` decoders during rapid clip swaps. The
  1080p proxy helps a lot for *new* clips. Further mitigation would
  require either dropping the double-buffer (lose smooth cuts) or
  sequencing source swaps more conservatively.

- [ ] **End-to-end export sanity check** with the new proxy clips.
  Everything should work (URIs are still `file://…`), but neither of us
  has run a full export → DCIM → share-sheet since the transcode landed.
  One test from a fresh entry covers it.

---

## Pre-existing TypeScript Errors

These predate this sprint — runtime is fine, but `tsc --noEmit` is
noisy. Clean them up when touching those files.

- [ ] **`Entry.type` missing on type.** Referenced in:
  - `src/components/capture/CaptureSheet.tsx` (lines 55, 59, 62, 247, 265, 281)
  - `src/components/capture/EditEntrySheet.tsx` (lines 28, 41, 58, 59)
  - `src/components/timeline/TimelineEntry.tsx` (lines 18-20)

  Looks like the `Entry` schema was simplified and these call-sites were
  left referencing the old `.type` discriminator.

- [ ] **`TimelineEntry.tsx` references undefined `CATEGORIES`** (line 17)
  and `entry.category` (line 17). Dead code from a ripped-out feature.

- [ ] **`app/settings/index.tsx` line 51** — `copyToCacheDir` option was
  removed from `DocumentPickerOptions` in a newer `expo-document-picker`
  version. Drop the option or replace with the current equivalent.

---

## Robustness Polish

Not urgent; revisit when a user hits one.

- [ ] **Relative path storage for clip URIs.** Currently the DB stores
  absolute `file:///data/user/0/com.anonymous.loopd/files/loopd/media/…`
  paths. A sandbox-path change (reinstall, different Android user
  profile) invalidates them — the only recovery is per-clip re-import.
  Fix: store paths relative to `{DocumentsDir}/loopd/` and resolve at
  load time. Future-work entry in
  [docs/media-pipeline.md](docs/media-pipeline.md).

- [ ] **Transcode cancellation.** If a user picks the wrong clip they
  have to wait for FFmpeg to finish before they can recover. Add a
  cancel affordance on the placeholder card (abort the FFmpeg session,
  clean up the partial output file, decrement pending count).

- [ ] **Disk-full handling.** If `{docs}/loopd/media/` hits the storage
  cap mid-transcode, FFmpeg fails silently (logged, but no user-visible
  error). Surface a toast/error state on the placeholder.

- [ ] **Background transcode queue.** Multiple rapid imports each spawn
  their own FFmpegKit session. Fine for 2-3 concurrent, risky under
  heavier load. Queue them if > N are already in flight.

---

## Speculative / Later

- [ ] **Adaptive proxy quality** — drop to 720p on lower-end devices for
  faster transcode.
- [ ] **Original-backed re-export** — opt-in "render from master" that
  pulls the untouched DCIM original for the highest-quality final vlog.
- [ ] **Timeline marks past N min** — the auto-interval formula
  (`niceSteps`) tops out at 60s; a 10-minute vlog would be readable but
  cramped. Extend for longer timelines.
