import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useDatabase } from '../src/hooks/useDatabase';
import { colors } from '../src/constants/theme';

export default function RootLayout() {
  const { ready } = useDatabase();
  const [fontsLoaded] = useFonts({
    DMSerifDisplay: require('../assets/fonts/DMSerifDisplay.ttf'),
    DMMono: require('../assets/fonts/DMMono-Regular.ttf'),
    DMMonoMedium: require('../assets/fonts/DMMono-Medium.ttf'),
    InstrumentSans: require('../assets/fonts/InstrumentSans-Variable.ttf'),
  });

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
