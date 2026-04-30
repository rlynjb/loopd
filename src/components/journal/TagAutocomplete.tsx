import { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, Keyboard, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { getThreadSuggestions } from '../../services/threads/crud';
import type { Thread } from '../../types/thread';
import { slugify } from '../../services/habits/migrate';

type Props = {
  // When non-null, the bar is active; the string is what the user has typed
  // after "#" on the current line. Empty string = just typed "#" alone.
  query: string | null;
  onSelectExisting: (thread: Thread) => void;
  onCreateNew: (slug: string) => void;
};

// Floating chip bar, sibling to NutritionAutocomplete. Triggered when the
// cursor follows a "#xyz" partial tag on a journal line. Shows existing
// threads matching the prefix, plus a "+ create #xyz" affordance when the
// query is non-empty and doesn't already match an existing slug exactly.
//
// Lays out at top: keyboardTop - 88 — 44px above the KeyboardToolbar so
// the stack is autocomplete / toolbar / keyboard.
export function TagAutocomplete({ query, onSelectExisting, onCreateNew }: Props) {
  const [keyboardTop, setKeyboardTop] = useState(0);
  const [items, setItems] = useState<Thread[]>([]);

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
        const results = await getThreadSuggestions(query, 8);
        if (!cancelled) setItems(results);
      } catch (err) {
        console.warn('[tag autocomplete] query failed:', err);
        if (!cancelled) setItems([]);
      }
    })();
    return () => { cancelled = true; };
  }, [query]);

  if (query === null || keyboardTop === 0) return null;

  const trimmed = query.trim();
  const candidateSlug = slugify(trimmed);
  const exactMatch = items.find(t => t.slug.toLowerCase() === candidateSlug);
  const showCreate = candidateSlug.length > 0 && !exactMatch;
  const showHint = items.length === 0 && !showCreate;

  return (
    <View style={[styles.container, { top: keyboardTop - 88 }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.row}
      >
        {items.map(t => (
          <Pressable
            key={t.id}
            onPress={() => onSelectExisting(t)}
            style={styles.chip}
          >
            <Text style={styles.chipHash}>#</Text>
            <Text style={styles.chipName} numberOfLines={1}>{t.slug}</Text>
          </Pressable>
        ))}
        {showCreate && (
          <Pressable
            onPress={() => onCreateNew(candidateSlug)}
            style={[styles.chip, styles.chipCreate]}
          >
            <Text style={styles.chipCreatePlus}>+</Text>
            <Text style={styles.chipCreateText} numberOfLines={1}>
              create #{candidateSlug}
            </Text>
          </Pressable>
        )}
        {showHint && (
          <View style={styles.hintBox}>
            <Text style={styles.hintText}>
              Type a name to start a new thread (or auto-creates on save).
            </Text>
          </View>
        )}
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
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  chipHash: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textDim,
  },
  chipName: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.text,
    maxWidth: 160,
  },
  chipCreate: {
    borderColor: colors.accent2,
    backgroundColor: 'rgba(232,213,176,0.08)',
  },
  chipCreatePlus: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.accent,
  },
  chipCreateText: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.accent,
  },
  hintBox: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  hintText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
    fontStyle: 'italic',
  },
});
