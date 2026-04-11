import { useEffect, useRef, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { File as FSFile } from 'expo-file-system';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { formatDuration } from '../../utils/time';
import { InlineTodoList } from './InlineTodoList';
import type { Entry, Habit, TodoItem } from '../../types/entry';

type Props = {
  entry: Entry;
  habits: Habit[];
  onTapToEdit: (entry: Entry) => void;
  onAddClip?: (entry: Entry) => void;
  onRemoveClip?: (entry: Entry, clipIndex: number) => void;
  onRemoveHabit?: (entry: Entry, habitId: string) => void;
  onUpdateTodos?: (entry: Entry, todos: TodoItem[]) => void;
  compact?: boolean;
};

export function InlineEntry({ entry, habits, onTapToEdit, onAddClip, onRemoveClip, onRemoveHabit, onUpdateTodos, compact }: Props) {
  const hasClips = entry.clips.length > 0 || !!entry.clipUri;
  const hasHabits = entry.habits.length > 0;
  const hasTodos = (entry.todos?.length ?? 0) > 0;

  const time = new Date(entry.createdAt);
  const timeStr = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  // Thumbnails for all clips
  const [thumbnails, setThumbnails] = useState<(string | null)[]>([]);
  const clipRefs = entry.clips?.length > 0
    ? entry.clips
    : entry.clipUri ? [{ uri: entry.clipUri, durationMs: entry.clipDurationMs ?? 0 }] : [];

  useEffect(() => {
    if (!hasClips || clipRefs.length === 0) return;
    let cancelled = false;
    (async () => {
      const thumbs: (string | null)[] = [];
      for (const c of clipRefs) {
        try {
          if (!c.uri.includes('/')) { thumbs.push(null); continue; }
          const file = new FSFile(c.uri);
          if (!file.exists) { thumbs.push(null); continue; }
          const t = await VideoThumbnails.getThumbnailAsync(c.uri, { time: 500, quality: 0.3 });
          thumbs.push(t.uri);
        } catch { thumbs.push(null); }
      }
      if (!cancelled) setThumbnails(thumbs);
    })();
    return () => { cancelled = true; };
  }, [entry.id, clipRefs.length]);

  return (
    <View style={[styles.container, compact && { marginBottom: 0, paddingBottom: 0, borderBottomWidth: 0 }]}>
      {/* Header: time — hidden in compact/edit mode */}
      {!compact && (
        <View style={styles.header}>
          <Text style={styles.time}>{timeStr}</Text>
        </View>
      )}

      <Pressable
        onPress={() => onTapToEdit(entry)}
        style={({ pressed }) => [styles.content, pressed && { opacity: 0.6 }]}
      >
        {/* Text or tappable empty space */}
        {entry.text ? (
          <Text style={[styles.journalText, (hasTodos || hasHabits || hasClips) && { marginBottom: 10 }]}>{entry.text}</Text>
        ) : (hasTodos || hasHabits || hasClips) ? (
          <View style={styles.emptyTextTap} />
        ) : null}

        {/* Todos */}
        {hasTodos && (
          <InlineTodoList
            todos={entry.todos}
            onUpdate={(todos) => onUpdateTodos?.(entry, todos)}
            editable={!!onUpdateTodos}
          />
        )}

        {/* Habit chips */}
        {hasHabits && (
          <View>
            <View style={styles.chipRow}>
              {entry.habits.map(hId => {
                const habit = habits.find(h => h.id === hId);
                return habit ? (
                  <View key={hId} style={[styles.chip, { borderColor: `${colors.green}40`, backgroundColor: `${colors.green}12` }]}>
                    <Icon name="checkSquare" size={11} color={colors.green} />
                    <Text style={[styles.chipText, { color: colors.green }]}>{habit.label}</Text>
                    {onRemoveHabit && (
                      <Pressable onPress={() => onRemoveHabit(entry, hId)} hitSlop={4}>
                        <Icon name="x" size={10} color={colors.green} />
                      </Pressable>
                    )}
                  </View>
                ) : null;
              })}
            </View>
          </View>
        )}

        {/* Clip thumbnails */}
        {hasClips && (
          <View style={styles.clipRow}>
            {clipRefs.map((c, i) => (
              <View key={i} style={styles.clipCard}>
                {thumbnails[i] ? (
                  <Image source={{ uri: thumbnails[i]! }} style={styles.clipThumb} />
                ) : (
                  <View style={[styles.clipThumb, { backgroundColor: colors.bg3 }]}>
                    <Icon name="video" size={16} color={colors.textDim} />
                  </View>
                )}
                <View style={styles.clipDurationBadge}>
                  <Text style={styles.clipDurationText}>
                    {formatDuration(c.durationMs / 1000)}
                  </Text>
                </View>
                {onRemoveClip && (
                  <Pressable
                    onPress={() => onRemoveClip(entry, i)}
                    style={styles.clipDeleteBtn}
                    hitSlop={4}
                  >
                    <Icon name="x" size={10} color="#fff" />
                  </Pressable>
                )}
              </View>
            ))}
            {onAddClip && (
              <Pressable
                onPress={() => onAddClip(entry)}
                style={styles.addClipBtn}
              >
                <View style={styles.addClipInner}>
                  <Icon name="plus" size={16} color={colors.textDim} />
                </View>
              </Pressable>
            )}
          </View>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 24,
    paddingBottom: 24,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  time: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.accent,
  },
  content: {},
  emptyTextTap: {
    height: 24,
  },
  journalText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.text,
    lineHeight: 22,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderRadius: 0,
  },
  chipText: {
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  clipRow: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
    marginBottom: 10,
  },
  clipCard: {
    overflow: 'hidden',
    backgroundColor: colors.bg3,
    width: '31%',
    position: 'relative',
  },
  clipThumb: {
    width: '100%',
    aspectRatio: 4 / 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clipDurationBadge: {
    position: 'absolute',
    bottom: 2,
    left: 2,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  clipDurationText: {
    fontFamily: fonts.mono,
    fontSize: 8,
    fontWeight: '700',
    color: '#fff',
  },
  clipDeleteBtn: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 16,
    height: 16,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addClipBtn: {
    width: '31%',
  },
  addClipInner: {
    aspectRatio: 4 / 3,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
