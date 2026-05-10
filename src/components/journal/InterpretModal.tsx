import { useCallback, useEffect, useState } from 'react';
import {
  Modal, View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { interpretEntry, MIN_TEXT_LENGTH, MAX_INPUT_CHARS } from '../../services/ai/interpret';
import { getAISummary, upsertAISummary } from '../../services/database';
import type { AISummary, Interpretation } from '../../types/ai';

type Props = {
  visible: boolean;
  date: string;
  dayText: string;
  onClose: () => void;
};

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'result'; interpretation: Interpretation }
  | { kind: 'error'; message: string };

// Last 2000 chars (matching the service's truncate) — used as the staleness
// fingerprint, so reopening with the same trailing text shows the cached
// interpretation as fresh rather than stale.
function tail(s: string, max = MAX_INPUT_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(s.length - max);
}

export function InterpretModal({ visible, date, dayText, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const trimmed = dayText.trim();
  const tooShort = trimmed.length < MIN_TEXT_LENGTH;

  // On open, look for a cached interpretation in ai_summaries for this date.
  // If present, show it; staleness is computed inline against the current
  // dayText so the user gets a "Entry changed since last interpretation"
  // banner whenever they've typed since the last generate.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      setStatus({ kind: 'idle' });
      try {
        const cached = await getAISummary(date);
        if (cancelled) return;
        if (!cached) return;
        const parsed = JSON.parse(cached.summaryJson);
        const interp = parsed?.interpret as Interpretation | undefined;
        if (interp && interp.mainInterpretation) {
          setStatus({ kind: 'result', interpretation: interp });
        }
      } catch { /* ignore parse errors — fresh state */ }
    })();
    return () => { cancelled = true; };
  }, [visible, date]);

  const persist = useCallback(async (interp: Interpretation) => {
    try {
      const cached = await getAISummary(date);
      let next: Partial<AISummary> = {};
      if (cached) {
        try { next = JSON.parse(cached.summaryJson) as Partial<AISummary>; }
        catch { next = {}; }
      }
      next.interpret = interp;
      const model = interp.model || cached?.model || 'unknown';
      await upsertAISummary(date, JSON.stringify(next), model);
    } catch (e) {
      console.warn('[interpret] persist failed:', e);
    }
  }, [date]);

  const run = useCallback(async () => {
    if (tooShort) return;
    setStatus({ kind: 'loading' });
    const r = await interpretEntry(trimmed);
    if (r.ok) {
      setStatus({ kind: 'result', interpretation: r.interpretation });
      await persist(r.interpretation);
    } else {
      const msg = r.reason === 'no-ai'
        ? 'Configure an AI provider in Settings → AI to use Interpret.'
        : r.reason === 'malformed'
        ? "Couldn't parse the response. Try again."
        : r.reason === 'network'
        ? 'No connection — interpretation needs internet.'
        : 'Write a little more first.';
      setStatus({ kind: 'error', message: msg });
    }
  }, [trimmed, tooShort, persist]);

  const isStale =
    status.kind === 'result' &&
    tail(trimmed) !== status.interpretation.sourceText;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={onClose} hitSlop={12} style={styles.headerBtn}>
            <Icon name="x" size={20} color={colors.textMuted} />
          </Pressable>
          <Text style={styles.headerTitle}>Interpret</Text>
          <View style={styles.headerBtn} />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {tooShort ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>Write a little more first.</Text>
              <Text style={styles.emptyHint}>
                {`At least ${MIN_TEXT_LENGTH} characters of journal text are needed.`}
              </Text>
            </View>
          ) : status.kind === 'idle' ? (
            <View style={styles.idleBlock}>
              <Text style={styles.idleText}>
                Tap interpret to analyze your day's journal entry. The AI will
                surface themes, emotional patterns, and a healthy reframe.
              </Text>
            </View>
          ) : status.kind === 'loading' ? (
            <View style={styles.loadingBlock}>
              <ActivityIndicator color={colors.accent} size="small" />
              <Text style={styles.loadingText}>Interpreting…</Text>
            </View>
          ) : status.kind === 'error' ? (
            <View style={styles.errorBlock}>
              <Text style={styles.errorText}>{status.message}</Text>
            </View>
          ) : (
            <Sections interpretation={status.interpretation} stale={isStale} />
          )}
        </ScrollView>

        {/* Footer button — Interpret / Regenerate */}
        {!tooShort && (
          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
            <Pressable
              onPress={run}
              disabled={status.kind === 'loading'}
              style={[styles.cta, status.kind === 'loading' && styles.ctaDisabled]}
            >
              <Icon name="sparkles" size={16} color={colors.bg} />
              <Text style={styles.ctaText}>
                {status.kind === 'loading'
                  ? 'Interpreting…'
                  : status.kind === 'result'
                  ? 'Regenerate'
                  : 'Interpret'}
              </Text>
            </Pressable>
            {status.kind === 'result' && status.interpretation.generatedAt && (
              <Text style={styles.timestamp}>
                Interpreted {formatRelative(status.interpretation.generatedAt)}
              </Text>
            )}
          </View>
        )}
      </View>
    </Modal>
  );
}

function Sections({ interpretation, stale }: { interpretation: Interpretation; stale: boolean }) {
  return (
    <View style={styles.sections}>
      {stale && (
        <View style={styles.staleBanner}>
          <Text style={styles.staleText}>
            Entry changed since last interpretation. Tap regenerate for an updated read.
          </Text>
        </View>
      )}

      <Section label="Main interpretation" body={interpretation.mainInterpretation} />

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Core themes</Text>
        <View style={styles.themes}>
          {interpretation.coreThemes.map((t, i) => (
            <View key={`${t.label}-${i}`} style={styles.theme}>
              <Text style={styles.themeLabel}>{t.label}</Text>
              <Text style={styles.themeExplanation}>{t.explanation}</Text>
            </View>
          ))}
        </View>
      </View>

      <Section label="Emotional pattern" body={interpretation.emotionalPattern} />
      <Section label="Healthy reframe" body={interpretation.healthyReframe} />
      <Section label="Key takeaway" body={interpretation.keyTakeaway} highlighted />
    </View>
  );
}

function Section({ label, body, highlighted }: { label: string; body: string; highlighted?: boolean }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <Text style={[styles.sectionBody, highlighted && styles.sectionBodyHighlight]}>{body}</Text>
    </View>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 30) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  headerBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.text,
    letterSpacing: -0.2,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 32,
  },
  idleBlock: {
    paddingVertical: 32,
  },
  idleText: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textMuted,
  },
  loadingBlock: {
    paddingVertical: 64,
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
    letterSpacing: 0.5,
  },
  empty: {
    paddingVertical: 48,
    alignItems: 'center',
    gap: 8,
  },
  emptyText: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.text,
  },
  emptyHint: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
  },
  errorBlock: {
    paddingVertical: 32,
  },
  errorText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.coral,
    lineHeight: 20,
  },
  sections: {
    gap: 24,
  },
  staleBanner: {
    backgroundColor: 'rgba(212, 146, 42, 0.12)',
    borderLeftWidth: 2,
    borderLeftColor: colors.amber,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  staleText: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.amber,
    lineHeight: 16,
  },
  section: {
    gap: 8,
  },
  sectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  sectionBody: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 21,
    color: colors.text,
  },
  sectionBodyHighlight: {
    fontFamily: fonts.heading,
    fontSize: 16,
    lineHeight: 24,
    letterSpacing: -0.2,
    color: colors.accent,
  },
  themes: {
    gap: 10,
  },
  theme: {
    paddingVertical: 6,
  },
  themeLabel: {
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 2,
  },
  themeExplanation: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textMuted,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    gap: 8,
    alignItems: 'center',
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.accent,
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 4,
  },
  ctaDisabled: {
    opacity: 0.5,
  },
  ctaText: {
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: '600',
    color: colors.bg,
  },
  timestamp: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 0.5,
  },
});
