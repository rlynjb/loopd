# loopd

A daily vlogging app that combines a story journal, habit tracking, and a lightweight video editor. Built with React Native + Expo.

> **This is a native-only app.** It uses SQLite, video playback, and filesystem APIs that require a development build. It will not run in Expo Go or on web.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- Java 17
- [Android Studio](https://developer.android.com/studio) with an emulator or a physical device
- `ANDROID_HOME` environment variable pointing to your Android SDK

### Install Java 17 (macOS)

The Android build requires Java 17. Install via Homebrew:

```bash
brew install --cask zulu@17
```

This will prompt for your macOS password. After it completes, add to `~/.zshrc`:

```bash
export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home
```

Reload your shell:

```bash
source ~/.zshrc
```

Verify:

```bash
java -version
# openjdk version "17.0.x" ...
```

### Set up Android Studio

If you haven't set up Android Studio yet:

1. Install Android Studio
2. Open it, go to **SDK Manager** and install **Android SDK** (API 34+)
3. Add to your shell profile (`~/.zshrc` or `~/.bashrc`):
   ```bash
   export ANDROID_HOME=$HOME/Library/Android/sdk
   export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools
   ```
4. Create an emulator via **Virtual Device Manager** or connect a physical phone

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Prebuild native project

```bash
npx expo prebuild --platform android
```

This generates the `android/` directory. You only need to run this once (or again after adding new native modules).

### 3. Run on emulator

Start an Android emulator from Android Studio, then:

```bash
npm run android
```

This compiles the native code, installs the app, and starts Metro bundler with hot reload.

### 4. Run on physical phone (USB)

1. On your phone: **Settings > About Phone > tap Build Number 7 times** to enable Developer Options
2. **Settings > Developer Options > enable USB Debugging**
3. Plug in via USB, accept the debugging prompt on your phone
4. Run:

```bash
npx expo run:android --device
```

Pick your device from the list. The app installs and connects to Metro for live reload.

## Development Workflow

### Emulator (local testing)

```bash
npm run android
```

Use this for testing changes before pushing to your phone. Requires Android Studio emulator running.

### Phone (production testing via EAS)

The recommended workflow for testing on a real phone:

| Task | Command |
|---|---|
| Push code changes to phone | `eas update --branch preview --platform android --message "what changed"` |
| New native module added | `eas build --platform android --profile preview` |
| Check build status | Visit expo.dev → your project → Builds |

The app checks for updates on open and prompts to install. You can also manually check in **Settings → App Updates**.

> **Important:** Don't mix local debug builds and EAS builds on the same device — different signing keys will conflict. Use emulator for local builds, phone for EAS builds.

### EAS Setup (one time)

1. Create an account at [expo.dev/signup](https://expo.dev/signup)
2. If you signed up with Google, go to **Settings → Password** and set a password
3. Install and login:

```bash
npm install -g eas-cli
eas login
```

4. Build the base app:

```bash
eas build --platform android --profile preview
```

This builds in the cloud (~10-15 min). When done, install on your phone (one time only):

**Option A:** From terminal — shows a QR code, scan with your phone:
```bash
eas build:run --platform android
```

**Option B:** From browser — open on your phone:
Go to **expo.dev** → sign in → your project **loopd** → **Builds** → latest build → **Install**

> If you get `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, uninstall the old debug build first:
> ```bash
> ~/Library/Android/sdk/platform-tools/adb uninstall com.anonymous.loopd
> ```

5. From now on, push JS changes with (no reinstall needed):

```bash
eas update --branch preview --platform android --message "description of changes"
```

No APK transfer, no reinstall, no data loss. The app picks up the update next time it opens.

### When you need a full rebuild

Only run `eas build` again when you add a **new native module** (e.g. `npm install` a package with native Android/iOS code). All JS-only changes go through `eas update`.

### Local APK build (alternative)

If you prefer not to use EAS:

```bash
cd android
./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

Transfer to your phone and install over the existing app (no uninstall needed, data is preserved).

## Project Structure

```
loopd/
├── app/                        # Expo Router screens
│   ├── _layout.tsx             # Root layout (fonts, DB, auto-sync)
│   ├── index.tsx               # Home screen
│   ├── journal/[date].tsx      # Journal timeline
│   ├── editor/[date].tsx       # Video editor
│   └── settings.tsx            # Notion sync settings
├── src/
│   ├── components/
│   │   ├── ui/                 # Icon, SpinningIcon, Chip, Slider, GlowOrb
│   │   ├── timeline/           # TimelineEntry, TimelineList
│   │   ├── capture/            # CaptureSheet (add + edit)
│   │   ├── editor/             # EditorTimeline, ClipEditor, TextEditor,
│   │   │                         FilterEditor, PreviewPlayer, ExportModal
│   │   └── home/               # HomeHeader, PastVlogCard
│   ├── hooks/                  # useDatabase, useEntries, useHabits,
│   │                             useProject, useDayTitle, useNotionSync
│   ├── services/
│   │   ├── database.ts         # SQLite schema, CRUD, sync queries
│   │   ├── fileManager.ts      # File operations, clip import
│   │   ├── clipMatcher.ts      # Auto-reimport missing clips from camera roll
│   │   ├── exportPipeline.ts   # FFmpeg video export
│   │   ├── ffmpegCommand.ts    # FFmpeg command builder
│   │   └── notion/             # Notion sync
│   │       ├── api.ts          # REST client with rate limiting
│   │       ├── config.ts       # SecureStore config
│   │       ├── mapper.ts       # Bidirectional property mapping
│   │       └── sync.ts         # Sync orchestrator
│   ├── types/                  # entry, project, notion, common
│   ├── constants/              # theme, moods, categories, filters, captureTypes
│   └── utils/                  # time, id
└── assets/fonts/               # DM Serif Display, DM Mono, Instrument Sans
```

## Tech Stack

| Layer       | Technology                          |
| ----------- | ----------------------------------- |
| Framework   | React Native + Expo (SDK 55)        |
| Language    | TypeScript (strict)                 |
| Navigation  | Expo Router (file-based)            |
| Video       | react-native-video                  |
| Video Export| @wokcito/ffmpeg-kit-react-native    |
| Storage     | expo-sqlite                         |
| Files       | expo-file-system                    |
| Sync        | Notion REST API (bidirectional)     |
| Secrets     | expo-secure-store                   |
| Icons       | lucide-react-native                 |
| Updates     | expo-updates + EAS Update           |

## Troubleshooting

**"Unable to resolve module react-native-web"** — You're running on web. This app is native-only. Use `npm run android` instead.

**"Expo Go is not supported"** — This app uses native modules. You need a development build via `npx expo run:android`.

**"Unable to locate a Java Runtime"** — Java 17 is not installed or not on your PATH. See the [Install Java 17](#install-java-17-macos) section above.

**Build fails after adding a package** — Run `npx expo prebuild --clean --platform android` to regenerate native files.
