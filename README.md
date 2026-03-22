# loopd

A daily vlogging app that combines a story journal, habit tracking, and a lightweight video editor. Built with React Native + Expo.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Android Studio](https://developer.android.com/studio) (for emulator or building APK)
- A physical Android phone with USB debugging enabled (for on-device development)
- Java 17 (included with Android Studio)

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Generate native project files

Since the app uses native modules (`react-native-video`, `expo-sqlite`, etc.), it requires a **development build** — Expo Go won't work.

```bash
npx expo prebuild --platform android
```

This creates the `android/` directory with native project files.

### 3. Start the dev server

```bash
npm start
```

### 4. Run on Android emulator

Make sure you have an Android emulator running in Android Studio, then:

```bash
npm run android
```

Or press `a` in the terminal after `npm start`.

### 5. Run on a physical Android phone (USB)

1. Enable **Developer Options** on your phone (tap Build Number 7 times in Settings > About Phone)
2. Enable **USB Debugging** in Developer Options
3. Connect your phone via USB and accept the debugging prompt
4. Run:

```bash
npx expo run:android --device
```

This builds and installs the dev client directly on your phone.

## Install on Android Phone (APK)

To build a standalone APK you can share and install on any Android device:

### Option A: Local APK build

```bash
npx expo prebuild --platform android
cd android
./gradlew assembleRelease
```

The APK will be at:

```
android/app/build/outputs/apk/release/app-release.apk
```

Transfer it to your phone (USB, email, cloud drive) and install. You may need to allow "Install from unknown sources" in your phone settings.

### Option B: EAS Build (cloud)

Install the EAS CLI and log in:

```bash
npm install -g eas-cli
eas login
```

Configure and build:

```bash
eas build:configure
eas build --platform android --profile preview
```

This produces a downloadable APK link. Open the link on your phone to install.

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
