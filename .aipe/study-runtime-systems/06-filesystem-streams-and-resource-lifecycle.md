# Filesystem, streams, and resource lifecycle — buffr's I/O surface
## Industry name(s): file descriptor, stream, resource cleanup · Type: Foundational

> Buffr's only persistent files are the SQLite DB and uploaded vlog blobs. SQLite manages its own file lifecycle. Vlog uploads are streamed to Supabase Storage. Other than that, there's no filesystem API surface buffr exposes.

## Zoom out, then zoom in

```
  THE FILES BUFFR TOUCHES

  buffr.db (and its WAL)              ─ managed by expo-sqlite-next
  vlog files (mp4 in app sandbox)     ─ created by camera; uploaded then deleted
  cache directory                      ─ Expo cache; managed by the OS
```

Zoom in: there's no `fs.open` / `fs.close` discipline buffr's code has to follow. The SQLite handle is opened once per session and held for the app's lifetime. Vlog uploads use a streaming API.

## Structure pass

```
  layers   ─ buffr code ─ Expo modules ─ filesystem
  axes     ─ ownership (who closes the resource)
             ─ visibility (in-sandbox vs cloud)
```

## How it works

### Move 1 — SQLite handle is process-lifetime

```
  one open() per session. close on app suspend.
  the WAL file is owned by SQLite.
```

### Move 2 — vlog uploads stream

```
  recorded file → read stream → HTTPS upload to Supabase Storage
  delete local copy on upload success
  retry on failure (cleanup the bytes already sent? Storage handles it)
```

### Move 3 — the principle

```
   ┌──────────────────────────────────────────────────┐
   │ buffr leaves filesystem lifecycle to Expo/RN.    │
   │ the only resource buffr manages is "delete local │
   │ vlog after successful upload." this is in the    │
   │ vlog upload flow.                                │
   └──────────────────────────────────────────────────┘
```

## Implementation in codebase

```ts
// pattern; src/services/vlogs/upload.ts
async function uploadVlog(localUri: string, userId: string) {
  const blob = await fetch(localUri).then(r => r.blob());
  const { error } = await supabase.storage.from('vlogs').upload(path, blob);
  if (!error) await FileSystem.deleteAsync(localUri);
}
```

## Elaborate

The "Expo manages the OS surface" pattern is what makes RN apps small. The cost is loss of control — buffr can't tune SQLite's page cache size or pre-fetch behavior. For its scale, the defaults are fine.

## Interview defense

**Q [mid]:** What file does buffr manage?

**A:** The SQLite DB file (opened once, never explicitly closed by app code) and vlog upload temp files (deleted on successful upload).

**Q [senior]:** What's the worst lifecycle bug you can imagine?

**A:** A vlog upload that succeeds but the local-delete fails — orphan file in the sandbox. Mitigation: a cleanup pass on app start that finds orphans.

## Validate

### Level 1 — list the files buffr touches.

### Level 2 — explain why SQLite handle is process-lifetime.

### Level 3 — apply: a feature wants "export all entries as a markdown file." How? Write to a temp file in cache dir; share via OS share-sheet.

### Level 4 — defend: "Buffer vlogs entirely in memory before uploading." Wrong; memory pressure on phones with 4G+ uploads.

## See also

- `01-runtime-map.md`
- `05-memory-stack-heap-gc-and-lifetimes.md`
- `../study-database-systems/07-wal-durability-and-recovery.md`
