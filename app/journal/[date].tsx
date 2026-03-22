import { useState } from 'react';
import { View, Pressable, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { colors, fonts } from '../../src/constants/theme';
import { HomeHeader } from '../../src/components/home/HomeHeader';
import { TimelineList } from '../../src/components/timeline/TimelineList';
import { CaptureSheet } from '../../src/components/capture/CaptureSheet';
import { GlowOrb } from '../../src/components/ui/GlowOrb';
import { useEntries } from '../../src/hooks/useEntries';
import { useHabits } from '../../src/hooks/useHabits';
import { formatDate } from '../../src/utils/time';

export default function JournalScreen() {
  const { date } = useLocalSearchParams<{ date: string }>();
  const router = useRouter();
  const { entries, addEntry } = useEntries(date);
  const habits = useHabits();
  const [showCapture, setShowCapture] = useState(false);
  const [captureType, setCaptureType] = useState<string | null>(null);

  const handleCapture = (type: string) => {
    setCaptureType(type);
    setShowCapture(true);
  };

  const handleCloseDay = () => {
    router.push(`/editor/${date}`);
  };

  return (
    <View style={styles.container}>
      <GlowOrb color={colors.teal} size={300} top={50} left={-80} opacity={0.07} />
      <GlowOrb color={colors.purple} size={250} top={300} left={250} opacity={0.06} />

      <HomeHeader
        dayStarted
        dateLabel={formatDate(new Date(date + 'T12:00:00'))}
        entries={entries}
        habits={habits}
        onBack={() => router.back()}
      />

      <TimelineList
        entries={entries}
        habits={habits}
        onCapture={handleCapture}
      />

      <View style={styles.bottomBar}>
        <Pressable onPress={handleCloseDay} style={styles.closeDayBtn}>
          <Text style={styles.closeDayText}>CLOSE DAY →</Text>
        </Pressable>
      </View>

      <CaptureSheet
        visible={showCapture}
        initialType={captureType}
        habits={habits}
        date={date}
        onClose={() => { setShowCapture(false); setCaptureType(null); }}
        onSave={entry => {
          addEntry(entry);
          setShowCapture(false);
          setCaptureType(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingBottom: 36,
    paddingTop: 12,
  },
  closeDayBtn: {
    backgroundColor: 'rgba(251,113,133,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(251,113,133,0.25)',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  closeDayText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.coral,
    letterSpacing: 0.6,
  },
});
