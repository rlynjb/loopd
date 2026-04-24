import { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, Keyboard, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { getNutritionSuggestions } from '../../services/database';
import type { NutritionSuggestion } from '../../types/nutrition';

type Props = {
  // When non-null, the bar is active; the string is what the user has typed
  // after "** " on the current line. Empty string = just typed "** ".
  query: string | null;
  onSelect: (pick: NutritionSuggestion) => void;
};

// Floating chip bar that surfaces existing foods from the nutrition table
// while the user is typing after a "** " prefix on a journal line.
//
// Renders just above the KeyboardToolbar (which sits at keyboardTop - 44),
// so the stack from top to bottom is:
//   [ autocomplete (44px) ]
//   [ keyboard toolbar (44px) ]
//   [ keyboard ]
//
// Hidden when query is null (prefix not active) or when there are no
// suggestions for the current query.
export function NutritionAutocomplete({ query, onSelect }: Props) {
  const [keyboardTop, setKeyboardTop] = useState(0);
  const [items, setItems] = useState<NutritionSuggestion[]>([]);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', (e) => {
      setKeyboardTop(e.endCoordinates.screenY);
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardTop(0);
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (query === null) { setItems([]); return; }
    (async () => {
      try {
        const results = await getNutritionSuggestions(query, 8);
        if (!cancelled) setItems(results);
      } catch (err) {
        console.warn('[nutrition autocomplete] query failed:', err);
        if (!cancelled) setItems([]);
      }
    })();
    return () => { cancelled = true; };
  }, [query]);

  if (query === null || keyboardTop === 0 || items.length === 0) return null;

  return (
    <View style={[styles.container, { top: keyboardTop - 88 }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.row}
      >
        {items.map(item => (
          <Pressable
            key={item.name + item.lastLoggedAt}
            onPress={() => onSelect(item)}
            style={styles.chip}
          >
            <Text style={styles.chipName} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.chipKcal}>{item.kcal} kcal</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 44,
    backgroundColor: colors.bg2,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    zIndex: 99,
  },
  row: {
    alignItems: 'center',
    paddingHorizontal: 10,
    gap: 6,
    height: '100%',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  chipName: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.text,
    maxWidth: 160,
  },
  chipKcal: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
  },
});
