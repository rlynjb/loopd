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

### 5. Development workflow

After the first build, you can just start Metro:

```bash
npm start
```

Then press `a` to open on a running Android emulator/device. Native rebuilds are only needed when you change native dependencies.

## Install on Android Phone (APK)

### Option A: Local APK build

```bash
cd android
./gradlew assembleRelease
```

Output APK:

```
android/app/build/outputs/apk/release/app-release.apk
```

Transfer to your phone and install. Enable **Install from unknown sources** if prompted.

### Option B: EAS Build (cloud)

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build --platform android --profile preview
```

This gives you a download link. Open it on your phone to install.

## Project Structure

```
loopd/
├── app/                        # Expo Router screens
│   ├── _layout.tsx             # Root layout (fonts, DB, navigation)
│   ├── index.tsx               # Home screen
│   ├── journal/[date].tsx      # Journal timeline
│   └── editor/[date].tsx       # Video editor
├── src/
│   ├── components/
│   │   ├── ui/                 # GlowOrb, Chip, PrimaryButton, Slider
│   │   ├── timeline/           # TimelineEntry, TimelineList, CaptureCard
│   │   ├── capture/            # CaptureSheet
│   │   ├── editor/             # EditorTimeline, ClipEditor, TextEditor,
│   │   │                         FilterEditor, PreviewPlayer, ExportModal
│   │   └── home/               # HomeHeader, PastVlogCard
│   ├── hooks/                  # useDatabase, useEntries, useHabits, useProject
│   ├── services/               # database (SQLite), fileManager
│   ├── types/                  # entry, project, common
│   ├── constants/              # theme, moods, categories, filters
│   └── utils/                  # time, id
└── assets/fonts/               # Syne, JetBrains Mono, Inter
```

## Tech Stack

| Layer       | Technology                          |
| ----------- | ----------------------------------- |
| Framework   | React Native + Expo (SDK 55)        |
| Language    | TypeScript (strict)                 |
| Navigation  | Expo Router (file-based)            |
| Video       | react-native-video                  |
| Storage     | expo-sqlite                         |
| Files       | expo-file-system                    |
| Gestures    | react-native-gesture-handler        |
| Animations  | react-native-reanimated             |

## Troubleshooting

**"Unable to resolve module react-native-web"** — You're running on web. This app is native-only. Use `npm run android` instead.

**"Expo Go is not supported"** — This app uses native modules. You need a development build via `npx expo run:android`.

**"Unable to locate a Java Runtime"** — Java 17 is not installed or not on your PATH. See the [Install Java 17](#install-java-17-macos) section above.

**Build fails after adding a package** — Run `npx expo prebuild --clean --platform android` to regenerate native files.
