import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useDatabase } from '../src/hooks/useDatabase';
import { colors } from '../src/constants/theme';
import { isNotionConfigured, isAutoSyncEnabled } from '../src/services/notion/config';
import { syncAll } from '../src/services/notion/sync';

export default function RootLayout() {
  const { ready } = useDatabase();
  const [fontsLoaded] = useFonts({
    DMSerifDisplay: require('../assets/fonts/DMSerifDisplay.ttf'),
    DMMono: require('../assets/fonts/DMMono-Regular.ttf'),
    DMMonoMedium: require('../assets/fonts/DMMono-Medium.ttf'),
    InstrumentSans: require('../assets/fonts/InstrumentSans-Variable.ttf'),
  });

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

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
