import { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../src/constants/theme';
import { PastVlogCard } from '../src/components/home/PastVlogCard';
import { getVlogs, getEntriesByDate, getDayTitle } from '../src/services/database';
import type { Vlog } from '../src/types/entry';

export default function VlogsScreen() {
  const router = useRouter();
  const [vlogs, setVlogs] = useState<Vlog[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const v = await getVlogs();
    setVlogs(v);
    const nextTitles: Record<string, string> = {};
    const nextPreviews: Record<string, string> = {};
    for (const vlog of v) {
      nextTitles[vlog.date] = await getDayTitle(vlog.date);
      const dayEntries = await getEntriesByDate(vlog.date);
      const firstText = dayEntries.find(e => e.text)?.text;
      if (firstText) {
        const sentences = firstText.split(/[.!?]+/).filter(Boolean).slice(0, 2).join('. ').trim();
        nextPreviews[vlog.date] = sentences.length > 100
          ? sentences.slice(0, 100) + '...'
          : sentences + (firstText.includes('.') ? '.' : '');
      }
    }
    setTitles(nextTitles);
    setPreviews(nextPreviews);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>Vlogs</Text>
          <Text style={styles.subtitle}>{vlogs.length} {vlogs.length === 1 ? 'entry' : 'entries'}</Text>
        </View>

        {vlogs.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No vlogs yet.</Text>
          </View>
        ) : (
          vlogs.map(vlog => (
            <PastVlogCard
              key={vlog.id}
              vlog={vlog}
              title={titles[vlog.date]}
              preview={previews[vlog.date]}
              onPress={() => router.push(`/journal/${vlog.date}`)}
            />
          ))
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
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: GLOBAL_NAV_HEIGHT + 32,
  },
  titleBlock: {
    paddingTop: 16,
    paddingBottom: 16,
    marginBottom: 8,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.text,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
    marginTop: 4,
  },
  empty: {
    paddingVertical: 48,
    alignItems: 'center',
  },
  emptyText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.textDim,
  },
});
