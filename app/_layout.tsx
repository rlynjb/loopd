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
import { syncAll } from '../src/services/notion/sync';
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
        syncAll().catch(err => console.warn('[loopd] Auto-sync failed:', err));
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
