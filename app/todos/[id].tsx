import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet,
  ActivityIndicator, Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';
import { TYPE_META } from '../../src/services/todos/typeMeta';
import { TypeChangePicker } from '../../src/components/todos/TypeChangePicker';
import {
  expandTodo, isExpanding, EXPAND_PROGRESS_EVENT,
} from '../../src/services/todos/expand';
import {
  getTodoMeta, getAllEntries, updateTodoMeta,
} from '../../src/services/database';
import { on } from '../../src/utils/events';
import type { TodoMeta, TodoType } from '../../src/types/todoMeta';

// Full-page expansion view. Replaces the previous bottom-sheet modal so the
// content can scroll freely without fighting the Android system gesture bar.
// Route: /todos/<todoId> with optional `text` search param so the page can
// render the quote without a DB walk on the common entry path.
export default function TodoDetailScreen() {
  const { id: rawId, text: paramText } = useLocalSearchParams<{ id: string; text?: string }>();
  const id = typeof rawId === 'string' ? rawId : '';
  const router = useRouter();

  const [meta, setMeta] = useState<TodoMeta | null>(null);
  const [todoText, setTodoText] = useState<string>(typeof paramText === 'string' ? paramText : '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const m = await getTodoMeta(id);
      setMeta(m);
      // Fallback for when the page was deep-linked or the text param was lost
      // — walk entries.todos_json to recover the original text.
      if (!todoText) {
        const entries = await getAllEntries();
        for (const e of entries) {
          const t = (e.todos ?? []).find(x => x.id === id);
          if (t) { setTodoText(t.text); break; }
        }
      }
    } catch (err) {
      console.warn('[todo detail] load failed:', err);
    }
  }, [id, todoText]);

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  const runExpand = useCallback(async () => {
    if (!id || !todoText) return;
    setLoading(true);
    setError(null);
    const result = await expandTodo(id, todoText);
    setLoading(false);
    if (!result.ok) {
      const msg = result.reason === 'no-ai'
        ? 'Configure AI in settings to expand.'
        : result.reason === 'in-flight-cap'
        ? 'Too many expansions in flight. Try again in a moment.'
        : result.reason === 'malformed'
        ? 'AI returned an invalid response. Try again.'
        : result.reason === 'network'
        ? 'Network error. Check your connection.'
        : 'Could not expand.';
      setError(msg);
      return;
    }
    await refresh();
  }, [id, todoText, refresh]);

  // Auto-trigger expansion on first arrival when there's nothing yet.
  useEffect(() => {
    if (!meta) return;
    if (meta.expandedMd) return;
    if (meta.type === 'todo') return;
    if (loading) return;
    if (isExpanding(id)) return;
    runExpand();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.todoId, meta?.expandedMd, meta?.type]);

  // Watch for cross-screen expansion completions (e.g. user kicked off
  // expand from /todos and then navigated here while it's still in flight).
  useEffect(() => {
    return on(EXPAND_PROGRESS_EVENT, () => {
      if (!isExpanding(id)) refresh();
    });
  }, [id, refresh]);

  const handleReexpand = useCallback(() => {
    Alert.alert(
      'Replace expansion?',
      'This overwrites the current expansion.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Replace', style: 'destructive', onPress: runExpand },
      ],
    );
  }, [runExpand]);

  const handlePickType = useCallback(async (newType: TodoType) => {
    setPickerOpen(false);
    if (!meta || newType === meta.type) return;
    try {
      await updateTodoMeta(id, { type: newType, userOverriddenType: true });
      await refresh();
    } catch (err) {
      console.warn('[todo detail] type change failed:', err);
    }
  }, [meta, id, refresh]);

  const typeMeta = meta ? TYPE_META[meta.type] : null;
  const showExpansion = meta && meta.type !== 'todo';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
        <View style={styles.headerCenter}>
          {typeMeta ? (
            <View style={styles.typeRow}>
              <Icon name={typeMeta.icon} size={14} color={typeMeta.color} />
              <Text style={[styles.typeLabel, { color: typeMeta.color }]}>{typeMeta.label}</Text>
            </View>
          ) : (
            <Text style={styles.typeLabel}>todo</Text>
          )}
        </View>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {todoText ? (
          <Text style={styles.quote}>"{todoText}"</Text>
        ) : null}

        {!showExpansion ? (
          <Text style={styles.emptyText}>
            Plain todos don't expand. Change the type from the action below to view a structured expansion.
          </Text>
        ) : loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.accent} size="small" />
            <Text style={styles.loadingText}>thinking…</Text>
          </View>
        ) : error ? (
          <View style={styles.errorWrap}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable onPress={runExpand} style={styles.retryBtn}>
              <Text style={styles.retryText}>try again</Text>
            </Pressable>
          </View>
        ) : meta?.expandedMd ? (
          <RenderedMarkdown md={meta.expandedMd} />
        ) : (
          <Text style={styles.emptyText}>No expansion yet.</Text>
        )}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable onPress={() => setPickerOpen(true)} style={styles.footerBtn}>
          <Text style={styles.footerText}>change type</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        {showExpansion && meta?.expandedMd && !loading && (
          <Pressable onPress={handleReexpand} style={styles.footerBtn}>
            <Text style={styles.footerText}>re-expand</Text>
          </Pressable>
        )}
      </View>

      <TypeChangePicker
        visible={pickerOpen}
        todoText={todoText}
        currentType={meta?.type ?? 'todo'}
        onCancel={() => setPickerOpen(false)}
        onPick={handlePickType}
      />
    </View>
  );
}

// Tiny markdown renderer matching what expandSerialize.ts emits:
//   ## Header
//   **Strong:** value
//   - bullet point
//   plain paragraph
function RenderedMarkdown({ md }: { md: string }) {
  const lines = md.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (line.startsWith('## ')) {
      out.push(<Text key={i} style={mdStyles.h}>{line.slice(3).trim()}</Text>);
      i++;
      continue;
    }
    const boldMatch = line.match(/^\*\*([^*]+)\*\*\s*(.*)$/);
    if (boldMatch) {
      out.push(
        <Text key={i} style={mdStyles.kv}>
          <Text style={mdStyles.kvKey}>{boldMatch[1]}</Text>
          {boldMatch[2] ? <Text style={mdStyles.kvVal}>{' ' + boldMatch[2]}</Text> : null}
        </Text>,
      );
      i++;
      continue;
    }
    if (line.startsWith('- ')) {
      const bullets: string[] = [];
      while (i < lines.length && lines[i].startsWith('- ')) {
        bullets.push(lines[i].slice(2).trim());
        i++;
      }
      out.push(
        <View key={`b-${i}`} style={mdStyles.bulletList}>
          {bullets.map((b, idx) => (
            <View key={idx} style={mdStyles.bulletRow}>
              <Text style={mdStyles.bulletDot}>•</Text>
              <Text style={mdStyles.bulletText}>{b}</Text>
            </View>
          ))}
        </View>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('## ') && !lines[i].startsWith('- ') && !/^\*\*[^*]+\*\*/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(<Text key={`p-${i}`} style={mdStyles.p}>{para.join(' ')}</Text>);
  }
  return <>{out}</>;
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
  headerCenter: {
    alignItems: 'center',
  },
  typeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  typeLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: GLOBAL_NAV_HEIGHT + 80,
  },
  quote: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.textMuted,
    fontStyle: 'italic',
    backgroundColor: colors.bg3,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 6,
    marginBottom: 16,
    lineHeight: 22,
  },
  loading: {
    paddingVertical: 36,
    alignItems: 'center',
    gap: 10,
  },
  loadingText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
  },
  errorWrap: {
    paddingVertical: 24,
    alignItems: 'center',
    gap: 12,
  },
  errorText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.coral,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: 6,
  },
  retryText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
  },
  emptyText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textDim,
    paddingVertical: 24,
    lineHeight: 20,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: GLOBAL_NAV_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    backgroundColor: colors.bg,
  },
  footerBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  footerText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
    letterSpacing: 0.5,
  },
});

const mdStyles = StyleSheet.create({
  h: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 16,
    marginBottom: 8,
  },
  p: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.text,
    lineHeight: 22,
  },
  kv: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.text,
    marginVertical: 4,
  },
  kvKey: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
  },
  kvVal: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.text,
  },
  bulletList: {
    gap: 4,
    marginVertical: 4,
  },
  bulletRow: {
    flexDirection: 'row',
    gap: 8,
  },
  bulletDot: {
    color: colors.textDim,
    fontSize: 14,
    lineHeight: 22,
    width: 10,
  },
  bulletText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.text,
    lineHeight: 22,
  },
});
