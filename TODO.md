# TODO

Open work, grouped by urgency. Checkpointed 2026-04-19 after the
robustness-polish pass.

---

## Robustness Polish

- [ ] **Relative path storage for clip URIs.** Currently the DB stores
  absolute `file:///data/user/0/com.anonymous.loopd/files/loopd/media/…`
  paths. A sandbox-path change (reinstall, different Android user
  profile) invalidates them — the only recovery is per-clip re-import.
  Fix: store paths relative to `{DocumentsDir}/loopd/` and resolve at
  load time. Future-work entry in
  [docs/media-pipeline.md](docs/media-pipeline.md).

---

## Speculative / Later

- [ ] **Adaptive proxy quality** — drop to 720p on lower-end devices for
  faster transcode.
- [ ] **Original-backed re-export** — opt-in "render from master" that
  pulls the untouched DCIM original for the highest-quality final vlog.
- [ ] **Timeline marks past N min** — the auto-interval formula
  (`niceSteps`) tops out at 60s; a 10-minute vlog would be readable but
  cramped. Extend for longer timelines.
