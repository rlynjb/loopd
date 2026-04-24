import { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../src/constants/theme';
import { Icon } from '../src/components/ui/Icon';
import { getAllNutrition } from '../src/services/database';
import type { NutritionEntry } from '../src/types/nutrition';

export default function NutritionScreen() {
  const router = useRouter();
  const [items, setItems] = useState<NutritionEntry[]>([]);

  const load = useCallback(async () => {
    const all = await getAllNutrition();
    setItems(all);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
        <Text style={styles.title}>Nutrition</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {items.length === 0 && (
          <Text style={styles.emptyText}>
            No nutrition entries yet. Write "** food 320 kcal" in a journal entry to log one.
          </Text>
        )}

        {items.map(row => (
          <Pressable
            key={row.id}
            onPress={() => router.push(`/journal/${row.entryDate}`)}
            style={styles.row}
            hitSlop={4}
          >
            <View style={styles.rowBody}>
              <Text style={styles.rowName} numberOfLines={1}>{row.name}</Text>
              <Text style={styles.rowDate}>{row.entryDate}</Text>
            </View>
            <Text style={styles.rowKcal}>{row.kcal.toLocaleString()} kcal</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: colors.text,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: GLOBAL_NAV_HEIGHT + 40,
  },
  emptyText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textDim,
    paddingVertical: 40,
    paddingHorizontal: 20,
    textAlign: 'center',
    lineHeight: 20,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  rowBody: {
    flex: 1,
    gap: 2,
    marginRight: 12,
  },
  rowName: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.text,
  },
  rowDate: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
  },
  rowKcal: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
  },
});
