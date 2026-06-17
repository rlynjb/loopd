import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { View, Text, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { useDatabase } from '../src/hooks/useDatabase';
import { colors } from '../src/constants/theme';
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

  // Cloud sync (Supabase). Bootstrap detects initial-push vs first-pull on
  // the first cold start after the feature ships; subsequent boots run
  // pullAll → pushAll. Edits push automatically via schedulePush() debounced
  // 5s — see src/services/sync/schedulePush.ts.
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
          console.log('[buffr sync] bootstrap decision:', decision);
        }
      } catch (err) {
        console.warn('[buffr] Cloud sync boot failed:', err instanceof Error ? err.message : err);
      }
    })();
  }, [ready]);

  // Warm the llama context as soon as the database is ready. shouldUseGemmaLocal
  // gates internally — if no model is downloaded or the device class is
  // 'disabled', this is a fast no-op. Otherwise initLlama loads the GGUF
  // (~2.5 GB) into memory off the UI thread so the first chain call is fast.
  // Fire-and-forget; never blocks UI render.
  useEffect(() => {
    if (!ready) return;
    (async () => {
      try {
        const { warmLlamaContext } = await import('../src/services/ai/providers/gemma');
        await warmLlamaContext();
      } catch (err) {
        console.warn('[buffr] llama warm failed:', err);
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
        console.log('[buffr] Auto-generated AI summary for', yStr);
      } catch (err) {
        console.warn('[buffr] AI auto-generate failed:', err);
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
          console.log(`[buffr] drops backfill scanned ${result.scanned} entries, updated ${result.updated}`);
        }
      } catch (err) {
        console.warn('[buffr] drops backfill failed:', err);
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
          console.log(`[buffr] nutrition backfill scanned ${result.scanned} entries`);
        }
      } catch (err) {
        console.warn('[buffr] nutrition backfill failed:', err);
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
          console.log(`[buffr] todo_meta backfill scanned ${result.scannedEntries} entries`);
        }
        // Phase B catch-up — fire-and-forget, doesn't block other init.
        classifyAmbiguousMeta()
          .then(r => {
            if (!r.skipped && r.classified > 0) {
              console.log(`[buffr] classified ${r.classified} ambiguous todos`);
            }
          })
          .catch(err => console.warn('[buffr] classify catch-up failed:', err));
      } catch (err) {
        console.warn('[buffr] todo_meta backfill failed:', err);
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
          console.log(`[buffr] habits cadence backfill scanned ${result.scanned}, slugged ${result.slugged}`);
        }
      } catch (err) {
        console.warn('[buffr] habits cadence backfill failed:', err);
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
        console.log(`[buffr] starting clip migration for ${pending} clip(s)`);
        await migrateOldClips();
      } catch (err) {
        console.warn('[buffr] clip migration failed:', err);
      }
    })();
  }, [ready]);

  useEffect(() => {
    if (!error) return;
    Alert.alert(
      'Database Error',
      `buffr could not open its local database.\n\n${error}`
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
        <AppContent />
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
