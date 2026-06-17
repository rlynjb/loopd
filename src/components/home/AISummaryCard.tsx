import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { getAISummary } from '../../services/database';
import { summarize } from '../../services/ai/summarize';
import { isAIConfigured } from '../../services/ai/config';
import { useLlmProgressTracker } from '../../services/ai/useLlmProgressTracker';
import type { AISummary } from '../../types/ai';

type Props = {
  date: string;              // YYYY-MM-DD, usually today
  hasEntries: boolean;        // hide the generate affordance if there's nothing to summarise
};

type CardState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'generating' }
  | { kind: 'ready'; summary: AISummary }
  | { kind: 'no-key' }
  | { kind: 'error'; message: string };

function parseSummary(json: string): AISummary | null {
  try { return JSON.parse(json) as AISummary; } catch { return null; }
}

export function AISummaryCard({ date, hasEntries }: Props) {
  const router = useRouter();
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const tracker = useLlmProgressTracker();

  const load = useCallback(async () => {
    const row = await getAISummary(date);
    if (row) {
      const parsed = parseSummary(row.summaryJson);
      if (parsed) { setState({ kind: 'ready', summary: parsed }); return; }
    }
    // No summary stored — decide between empty and no-key states.
    const configured = await isAIConfigured();
    setState({ kind: configured ? 'empty' : 'no-key' });
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const handleGenerate = useCallback(async () => {
    setState({ kind: 'generating' });
    try {
      const { summary, error } = await tracker.track('Summarize', (onProgress) =>
        summarize(date, onProgress),
      );
      if (summary) setState({ kind: 'ready', summary });
      else setState({ kind: 'error', message: error ?? 'Failed to generate summary' });
    } finally {
      tracker.clear();
    }
  }, [date, tracker]);

  const openVlog = useCallback(() => {
    router.push(`/journal/${date}`);
  }, [date, router]);

  if (state.kind === 'loading') {
    return (
      <View style={[styles.card, styles.cardMuted]}>
        <ActivityIndicator size="small" color={colors.textDim} />
      </View>
    );
  }

  if (state.kind === 'no-key') {
    return (
      <Pressable onPress={() => router.push('/settings')} style={[styles.card, styles.cardMuted]}>
        <View style={styles.headerRow}>
          <Text style={styles.label}>✦ Today's vlog</Text>
        </View>
        <Text style={styles.helper}>Add an AI key in Settings to generate daily summaries.</Text>
      </Pressable>
    );
  }

  if (state.kind === 'empty') {
    return (
      <Pressable
        onPress={hasEntries ? handleGenerate : undefined}
        style={[styles.card, styles.cardMuted, !hasEntries && styles.cardDisabled]}
      >
        <View style={styles.headerRow}>
          <Text style={styles.label}>✦ Today's vlog</Text>
        </View>
        <Text style={styles.helper}>
          {hasEntries ? 'Tap to generate today\u2019s summary' : 'Write or capture something first.'}
        </Text>
      </Pressable>
    );
  }

  if (state.kind === 'generating') {
    return (
      <View style={[styles.card, styles.cardMuted]}>
        <View style={styles.headerRow}>
          <Text style={styles.label}>✦ Generating summary…</Text>
          <ActivityIndicator size="small" color={colors.teal} />
        </View>
        {tracker.state && (
          <Text style={styles.progressDetail}>
            {tracker.state.outputTokens > 0 ? `${tracker.state.outputTokens} tokens · ` : ''}
            {(tracker.state.elapsedMs / 1000).toFixed(1)}s
          </Text>
        )}
      </View>
    );
  }

  if (state.kind === 'error') {
    return (
      <Pressable onPress={handleGenerate} style={[styles.card, styles.cardMuted]}>
        <View style={styles.headerRow}>
          <Text style={[styles.label, { color: colors.coral }]}>✦ Couldn\u2019t generate</Text>
        </View>
        <Text style={styles.errorText} numberOfLines={3}>{state.message}</Text>
        <Text style={styles.helper}>Tap to retry.</Text>
      </Pressable>
    );
  }

  const { summary } = state;
  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>✦ Today's vlog</Text>
      </View>
      {summary.headline ? (
        <Text style={styles.headline}>{summary.headline}</Text>
      ) : null}
      {summary.summary ? (
        <Text style={styles.summary} numberOfLines={5}>{summary.summary}</Text>
      ) : null}
      <Pressable onPress={openVlog} style={styles.openBtn}>
        <Icon name="clapperboard" size={14} color={colors.bg} />
        <Text style={styles.openBtnText}>Open vlog</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: `${colors.accent}25`,
    padding: 16,
    gap: 10,
  },
  cardMuted: {
    borderColor: colors.cardBorder,
  },
  cardDisabled: {
    opacity: 0.55,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
  },
  helper: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 18,
  },
  progressDetail: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 0.3,
    opacity: 0.7,
  },
  errorText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.coral,
  },
  headline: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: colors.text,
    letterSpacing: -0.3,
  },
  summary: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.textMuted,
    lineHeight: 21,
  },
  openBtn: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.accent,
    marginTop: 4,
  },
  openBtnText: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.bg,
    fontWeight: '600',
  },
});
