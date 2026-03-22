import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { colors, fonts } from '../src/constants/theme';
import { GlowOrb } from '../src/components/ui/GlowOrb';
import { HomeHeader } from '../src/components/home/HomeHeader';
import { PastVlogCard } from '../src/components/home/PastVlogCard';
import { getVlogs } from '../src/services/database';
import { getTodayString } from '../src/utils/time';
import type { Vlog } from '../src/types/entry';

export default function HomeScreen() {
  const router = useRouter();
  const [vlogs, setVlogs] = useState<Vlog[]>([]);

  useEffect(() => {
    getVlogs().then(setVlogs);
  }, []);

  const handleStart = () => {
    const today = getTodayString();
    router.push(`/journal/${today}`);
  };

  return (
    <View style={styles.container}>
      <GlowOrb color={colors.teal} size={300} top={50} left={-80} opacity={0.07} />
      <GlowOrb color={colors.purple} size={250} top={300} left={250} opacity={0.06} />
      <GlowOrb color={colors.coral} size={200} top={550} left={-40} opacity={0.05} />

      <HomeHeader
        dayStarted={false}
        dateLabel=""
        entries={[]}
        habits={[]}
      />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.cta}>
          <Text style={styles.slogan}>Plan. Capture. Reflect. Think.</Text>
          <Pressable onPress={handleStart} style={styles.startBtn}>
            <Text style={styles.startBtnText}>Start Today's Vlog</Text>
          </Pressable>
        </View>

        {vlogs.length > 0 && (
          <View style={styles.historySection}>
            <Text style={styles.sectionLabel}>PREVIOUS VLOGS</Text>
            {vlogs.map(vlog => (
              <PastVlogCard key={vlog.id} vlog={vlog} />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingBottom: 100,
  },
  cta: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  slogan: {
    fontFamily: fonts.heading,
    fontSize: 18,
    fontWeight: '600',
    color: colors.textMuted,
    lineHeight: 27,
    marginBottom: 24,
    textAlign: 'center',
  },
  startBtn: {
    backgroundColor: colors.teal,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 40,
  },
  startBtnText: {
    fontFamily: fonts.heading,
    fontSize: 15,
    fontWeight: '700',
    color: colors.bg,
  },
  historySection: {
    marginTop: 8,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
    marginBottom: 14,
  },
});
