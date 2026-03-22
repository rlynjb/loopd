import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useDatabase } from '../src/hooks/useDatabase';

export default function RootLayout() {
  const { ready } = useDatabase();
  const [fontsLoaded] = useFonts({
    Syne: require('../assets/fonts/Syne-Variable.ttf'),
    JetBrainsMono: require('../assets/fonts/JetBrainsMono-Variable.ttf'),
    Inter: require('../assets/fonts/Inter-Variable.ttf'),
  });

  if (!ready || !fontsLoaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#00d9a3" size="large" />
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
          contentStyle: { backgroundColor: '#000000' },
          animation: 'fade',
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
