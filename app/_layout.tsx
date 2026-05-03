import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { View, Text, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import * as Updates from 'expo-updates';
import { useDatabase } from '../src/hooks/useDatabase';
import { colors } from '../src/constants/theme';
import { NotionSyncProvider } from '../src/hooks/NotionSyncContext';
import { isNotionConfigured, isAutoSyncEnabled } from '../src/services/notion/config';
import { syncAll, syncAllTodos, syncAllHabits, syncAllThreads } from '../src/services/notion/sync';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { GlobalBottomNav } from '../src/components/nav/GlobalBottomNav';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { addDays, toLocalDateString } from '../src/utils/time';

function AppContent() {
  const { ready, error } = useDatabase();
  const [fontsLoaded] = useFonts({
    DMSerifDisplay: require('../assets/fonts/DMSerifDisplay.ttf'),
    DMMono: require('../assets/fonts/DMMono-Regular.ttf'),
    DMMonoMedium: require('../assets/fonts/DMMono-Medium.ttf'),
    InstrumentSans: require('../assets/fonts/InstrumentSans-Variable.ttf'),
  });

  // Load overlay fonts separately so they don't block app startup
  const [overlayFontsLoaded] = useFonts({
    Poppins: require('../assets/fonts/Poppins-Regular.ttf'),
    PoppinsBold: require('../assets/fonts/Poppins-Bold.ttf'),
    TikTokSans: require('../assets/fonts/TikTokSans-Regular.ttf'),
    TikTokSansBold: require('../assets/fonts/TikTokSans-Bold.ttf'),
    VarelaRound: require('../assets/fonts/VarelaRound-Regular.ttf'),
    Nunito200: require('../assets/fonts/Nunito-ExtraLight.ttf'),
    Nunito300: require('../assets/fonts/Nunito-Light.ttf'),
    Nunito400: require('../assets/fonts/Nunito-Regular.ttf'),
    Nunito500: require('../assets/fonts/Nunito-Medium.ttf'),
    Nunito600: require('../assets/fonts/Nunito-SemiBold.ttf'),
    Nunito700: require('../assets/fonts/Nunito-Bold.ttf'),
    Nunito800: require('../assets/fonts/Nunito-ExtraBold.ttf'),
    Nunito900: require('../assets/fonts/Nunito-Black.ttf'),
    NunitoItalic200: require('../assets/fonts/NunitoItalic-ExtraLight.ttf'),
    NunitoItalic300: require('../assets/fonts/NunitoItalic-Light.ttf'),
    NunitoItalic400: require('../assets/fonts/NunitoItalic-Regular.ttf'),
    NunitoItalic500: require('../assets/fonts/NunitoItalic-Medium.ttf'),
    NunitoItalic600: require('../assets/fonts/NunitoItalic-SemiBold.ttf'),
    NunitoItalic700: require('../assets/fonts/NunitoItalic-Bold.ttf'),
    NunitoItalic800: require('../assets/fonts/NunitoItalic-ExtraBold.ttf'),
    NunitoItalic900: require('../assets/fonts/NunitoItalic-Black.ttf'),
  });

  // Check for OTA updates on app open
  useEffect(() => {
    if (__DEV__) return;
    (async () => {
      try {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          Alert.alert(
            'Update Available',
            'A new version has been downloaded. Restart to apply?',
            [
              { text: 'Later', style: 'cancel' },
              { text: 'Restart', onPress: () => Updates.reloadAsync() },
            ]
          );
        }
      } catch (err) {
        console.warn('[loopd] Update check failed:', err);
      }
    })();
  }, []);

  // Auto-sync on app open
  useEffect(() => {
    if (!ready) return;
    (async () => {
      const configured = await isNotionConfigured();
      const autoSync = await isAutoSyncEnabled();
      if (configured && autoSync) {
        syncAll()
          .then(() => syncAllTodos())
          .then(() => syncAllHabits())
          .then(() => syncAllThreads())
          .catch(err => console.warn('[loopd] Auto-sync failed:', err));
      }
    })();
  }, [ready]);

  // Cloud sync (Supabase) — runs alongside Notion sync during the dual-run
  // window (M4–M6). Bootstrap detects initial-push vs first-pull on the first
  // cold start after the feature ships; subsequent boots run pullAll → pushAll.
  // Edits push automatically via schedulePush() debounced 5s — see
  // src/services/sync/schedulePush.ts.
  useEffect(() => {
    if (!ready) return;
    (async () => {
      try {
        const { bootstrapCloudSync, isBootstrapDone } = await import('../src/services/sync/bootstrap');
        const { pullAll, pushAll } = await import('../src/services/sync/orchestrator');
        if (await isBootstrapDone()) {
          await pullAll();
          await pushAll();
        } else {
          const decision = await bootstrapCloudSync();
          console.log('[loopd sync] bootstrap decision:', decision);
        }
      } catch (err) {
        console.warn('[loopd] Cloud sync boot failed:', err instanceof Error ? err.message : err);
      }
    })();
  }, [ready]);

  // Auto-generate AI summary for yesterday on app open
  useEffect(() => {
    if (!ready) return;
    (async () => {
      try {
        const { isAIConfigured } = await import('../src/services/ai/config');
        if (!(await isAIConfigured())) return;
        const { getAISummary } = await import('../src/services/database');
        const yStr = toLocalDateString(addDays(new Date(), -1));
        const existing = await getAISummary(yStr);
        if (existing) return;
        const { summarize } = await import('../src/services/ai/summarize');
        await summarize(yStr);
        console.log('[loopd] Auto-generated AI summary for', yStr);
      } catch (err) {
        console.warn('[loopd] AI auto-generate failed:', err);
      }
    })();
  }, [ready]);

  // One-time backfill: scan existing entries' text for "[]" drop markers so
  // any lines authored before the checkbox-drop scanner shipped are picked
  // up as todos. Gated by a SecureStore flag — runs once per install.
  useEffect(() => {
    if (!ready) return;
    (async () => {
      try {
        const { backfillTodosFromText } = await import('../src/services/todos/migrate');
        const result = await backfillTodosFromText();
        if (!result.skipped) {
          console.log(`[loopd] drops backfill scanned ${result.scanned} entries, updated ${result.updated}`);
        }
      } catch (err) {
        console.warn('[loopd] drops backfill failed:', err);
      }
    })();
  }, [ready]);

  // One-time backfill for "** <food> <n> kcal" nutrition drops in existing
  // entries. Mirrors the todos backfill — SecureStore-gated, runs once.
  useEffect(() => {
    if (!ready) return;
    (async () => {
      try {
        const { backfillNutritionFromText } = await import('../src/services/nutrition/migrate');
        const result = await backfillNutritionFromText();
        if (!result.skipped) {
          console.log(`[loopd] nutrition backfill scanned ${result.scanned} entries`);
        }
      } catch (err) {
        console.warn('[loopd] nutrition backfill failed:', err);
      }
    })();
  }, [ready]);

  // One-time backfill for todo_meta rows. Walks every entry, inserts a
  // paired meta row for each TodoItem in todos_json, runs the heuristic
  // classifier inline. SecureStore-gated; Phase A (no LLM in backfill).
  // Phase B's classifier catch-up runs right after — picks up any
  // heuristic-null rows and runs the LLM classifier (skips done items).
  useEffect(() => {
    if (!ready) return;
    (async () => {
      try {
        const { backfillTodoMeta, classifyAmbiguousMeta } = await import('../src/services/todos/migrateMeta');
        const result = await backfillTodoMeta();
        if (!result.skipped) {
          console.log(`[loopd] todo_meta backfill scanned ${result.scannedEntries} entries`);
        }
        // Phase B catch-up — fire-and-forget, doesn't block other init.
        classifyAmbiguousMeta()
          .then(r => {
            if (!r.skipped && r.classified > 0) {
              console.log(`[loopd] classified ${r.classified} ambiguous todos`);
            }
          })
          .catch(err => console.warn('[loopd] classify catch-up failed:', err));
      } catch (err) {
        console.warn('[loopd] todo_meta backfill failed:', err);
      }
    })();
  }, [ready]);

  // Lazy backfill for thread #tag mentions. Short-circuits when no threads
  // exist yet (so a fresh install doesn't burn cycles scanning prose with
  // no slugs to match against). Once the user creates their first thread,
  // the next boot picks it up and scans.
  useEffect(() => {
    if (!ready) return;
    (async () => {
      try {
        const { backfillThreadMentions } = await import('../src/services/threads/migrate');
        const result = await backfillThreadMentions();
        if (!result.skipped) {
          console.log(`[loopd] threads backfill scanned ${result.scanned} entries`);
        }
      } catch (err) {
        console.warn('[loopd] threads backfill failed:', err);
      }
    })();
  }, [ready]);

  // One-time backfill for habits cadence + slug. Adds default cadence_type
  // ('daily') is handled by the ALTER TABLE default; this fills in the slug
  // derived from each habit's label. SecureStore-gated, runs once.
  useEffect(() => {
    if (!ready) return;
    (async () => {
      try {
        const { backfillHabitsCadence } = await import('../src/services/habits/migrate');
        const result = await backfillHabitsCadence();
        if (!result.skipped) {
          console.log(`[loopd] habits cadence backfill scanned ${result.scanned}, slugged ${result.slugged}`);
        }
      } catch (err) {
        console.warn('[loopd] habits cadence backfill failed:', err);
      }
    })();
  }, [ready]);

  // Back-fill 1080p proxies for clips captured before the transcode-on-import
  // change. Runs once per launch if any old-layout clips are still referenced.
  // Safe to re-run (already-migrated URIs are skipped).
  useEffect(() => {
    if (!ready) return;
    (async () => {
      try {
        const { countPendingMigrations, migrateOldClips } = await import('../src/services/clipMigration');
        const pending = await countPendingMigrations();
        if (pending === 0) return;
        console.log(`[loopd] starting clip migration for ${pending} clip(s)`);
        await migrateOldClips();
      } catch (err) {
        console.warn('[loopd] clip migration failed:', err);
      }
    })();
  }, [ready]);

  useEffect(() => {
    if (!error) return;
    Alert.alert(
      'Database Error',
      `loopd could not open its local database.\n\n${error}`
    );
  }, [error]);

  if (!ready || !fontsLoaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} size="large" />
        {error ? <Text style={styles.errorText}>Database startup failed. See alert for details.</Text> : null}
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'fade',
        }}
      />
      <GlobalBottomNav />
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <NotionSyncProvider>
          <AppContent />
        </NotionSyncProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    marginTop: 12,
    color: colors.textMuted,
    fontSize: 13,
  },
});
