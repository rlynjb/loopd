# buffr — Backlog

Things that aren't urgent but are worth tracking. Each entry has the rough cost + the trigger that would make it become priority.

---

## OTA updates (EAS Update)

**Status:** configured but unused.

`app.json` has `updates.url` pointing at the EAS Update endpoint and `runtimeVersion: "appVersion"`. The Settings → App Updates page works mechanically — but no bundles have ever been published to the EAS server, so it always reports "you are on the latest version."

**Current dev workflow:** edit JS → `gradlew assembleRelease` → `adb install -r`. The APK bundles its own JS at build time. OTA is never involved.

**Setup if/when needed:**
1. `npx eas-cli login`
2. `npx eas-cli update --branch production --message "<change>"`
3. Installed APK picks up the bundle on next cold start.

**Trigger:** when the gradle build + adb install round-trip becomes annoying for JS-only changes (or you want to ship without USB-tethering the phone).

**Cost:** ~30 min for the first publish; ~10 sec per subsequent update.

---

## Cloud sync — vacuum job

**Status:** deferred from M4 fast-path.

Soft-deleted rows (`deleted_at IS NOT NULL`) accumulate forever. The plan was a periodic hard-delete of rows where `deleted_at < NOW() - 30 days`, run on app open if 24h+ since the last vacuum.

**Trigger:** when local DB or Postgres free-tier storage starts feeling heavy. Postgres free tier is 500 MB — plenty of headroom for solo use.

**Cost:** ~1h. New `sync/vacuum.ts` + wire into boot. Local SQLite has no FK CASCADE so children must be hard-deleted before parents.

---

## Cloud sync — drop dead schema columns

**Status:** stale columns + tables left behind by feature deletions.

- `sync_deletions` table — Notion-era outbox; empty, never written to anymore.
- `notion_page_id` / `notion_last_synced` columns — present on `entries`, `nutrition`, `habits`, `threads`. Always NULL going forward.
- `todo_meta.stage` — once drove the IN PROGRESS / BACKLOG status filters; replaced by the binary `done` flag (2026-05-05). NOT NULL DEFAULT 'todo' so new rows still write the default; nothing reads it.
- `todo_meta.position` — drove the manual reorder feature; replaced by `pinned` (2026-05-05).
- The cloud mirror keeps these columns too (they round-trip through sync) but no read path consults them on either side.

**Trigger:** purely cosmetic. Storage is negligible.

**Cost:** ~30 min. SQLite supports `ALTER TABLE … DROP COLUMN` in 3.35+ which expo-sqlite has. Drops on Postgres need a paired Supabase migration. Gate the local SQLite migration with a SecureStore flag so it runs once.

---

## Cloud sync — Phase B (multi-user, paid tier)

**Status:** out of scope for current single-developer use; sketched in [`docs/buffr-cloud-sync-spec.md`](./buffr-cloud-sync-spec.md) §14.

What it adds:
- **Auth** — Supabase Auth with email magic link or OAuth (Apple/Google).
- **RLS** — flip `ENABLE ROW LEVEL SECURITY` on every table; policies already authored in `supabase/migrations/0002_rls_policies.sql`.
- **Onboarding** — settings page entry → signup → payment (RevenueCat or Stripe) → "uploading your data..."
- **Payment** — TBD; likely $3–5/mo. Supabase free tier covers ~100 paid users.
- **Free-tier UX** — "Cloud Sync (paid). Your data lives only on this device. Tap to subscribe." Single guard at the top of `pushAll()` and `pullAll()` does it.

**Trigger:** when you decide to open buffr to other users.

**Cost:** ~80% UX work (auth screens, payment, onboarding), ~20% data-layer work. Multiple weeks.

---

## Editor — todo prose-rewrite on delete

**Status:** known limitation, low priority.

When a todo is deleted from the dashboard SmartTodoList or `/todos` page, the source `[]` line stays in the journal entry's prose. The todo disappears from the typed lists but still shows as text in the journal.

The existing `rewriteTodoLine` helper handles done/text changes; would need an analogous "delete the line" path that reconciles `entry.text` after a `deleteTodo`.

**Trigger:** when the leftover prose lines start feeling like noise.

**Cost:** ~30 min. New helper in `scanTodos.ts`, wire into `deleteTodo` in `todos/crud.ts`.

---

## Cloud sync — clip file backup

**Status:** known gap, no plan yet.

`entries.clips_json` round-trips through cloud sync, but the actual MP4 files in `Documents/buffr/clips/<date>/*.mp4` do NOT. If local FS is wiped, the videos are unrecoverable from the cloud.

**Options:**
- Push clips to Supabase Storage on every import. Costs egress + storage; users care about MB-scale per clip.
- Rely on phone's native photo backup (Google Photos / iCloud); accept clips-not-in-buffr-cloud as a known trade-off.
- Optional toggle: "Also back up video files" — opt-in for users who want it.

**Trigger:** if device-loss recovery actually happens (or anticipating Phase B users wanting full backup).

**Cost:** ~6–10h. Supabase Storage upload pipeline + local→cloud reconcile + bandwidth-aware deferral.
