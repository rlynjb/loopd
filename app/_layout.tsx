import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { View, ActivityIndicator, Alert, StyleSheet } from 'react-native';
import * as Updates from 'expo-updates';
import { useDatabase } from '../src/hooks/useDatabase';
import { colors } from '../src/constants/theme';
import { NotionSyncProvider } from '../src/hooks/NotionSyncContext';
import { isNotionConfigured, isAutoSyncEnabled } from '../src/services/notion/config';
import { syncAll } from '../src/services/notion/sync';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

function AppContent() {
  const { ready } = useDatabase();
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

  if (!ready || !fontsLoaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.accent} size="large" />
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'fade',
        }}
      />
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <NotionSyncProvider>
        <AppContent />
      </NotionSyncProvider>
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
});
