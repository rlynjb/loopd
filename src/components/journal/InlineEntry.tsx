import { useEffect, useRef, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { File as FSFile } from 'expo-file-system';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { CATEGORIES } from '../../constants/categories';
import { formatDuration } from '../../utils/time';
import type { Entry, Habit } from '../../types/entry';

type Props = {
  entry: Entry;
  habits: Habit[];
  onTapToEdit: (entry: Entry) => void;
};

export function InlineEntry({ entry, habits, onTapToEdit }: Props) {
  const hasClips = entry.clips.length > 0 || !!entry.clipUri;
  const hasHabits = entry.habits.length > 0;

  const time = new Date(entry.createdAt);
  const timeStr = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  // Thumbnail for video entries
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const clipRefs = entry.clips?.length > 0
    ? entry.clips
    : entry.clipUri ? [{ uri: entry.clipUri, durationMs: entry.clipDurationMs ?? 0 }] : [];
  const totalClipDuration = clipRefs.reduce((sum, c) => sum + c.durationMs, 0);

  useEffect(() => {
    if (!hasClips || clipRefs.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const uri = clipRefs[0].uri;
        if (!uri.includes('/')) return;
        const file = new FSFile(uri);
        if (!file.exists) return;
        const t = await VideoThumbnails.getThumbnailAsync(uri, { time: 500, quality: 0.5 });
        if (!cancelled) setThumbnail(t.uri);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [entry.id, clipRefs.length]);

  return (
    <View style={styles.container}>
      {/* Header: time */}
      <View style={styles.header}>
        <Text style={styles.time}>{timeStr}</Text>
      </View>

      <Pressable
        onPress={() => onTapToEdit(entry)}
        style={({ pressed }) => [styles.content, pressed && { opacity: 0.6 }]}
      >
        {/* Text */}
        {entry.text && (
          <Text style={styles.journalText}>{entry.text}</Text>
        )}

        {/* Clip thumbnail */}
        {hasClips && (
          <View style={styles.clipCard}>
            {thumbnail ? (
              <Image source={{ uri: thumbnail }} style={styles.clipThumb} />
            ) : (
              <View style={[styles.clipThumb, { backgroundColor: colors.bg3 }]}>
                <Icon name="video" size={24} color={colors.textDim} />
              </View>
            )}
            <View style={styles.clipOverlay}>
              <View style={styles.clipBadgeRow}>
                <View style={styles.clipDurationBadge}>
                  <Text style={styles.clipDurationText}>
                    {formatDuration(totalClipDuration / 1000)}
                  </Text>
                </View>
                {clipRefs.length > 1 && (
                  <Text style={styles.clipCount}>{clipRefs.length} clips</Text>
                )}
              </View>
            </View>
          </View>
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
                  </View>
                ) : null;
              })}
            </View>
          </View>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
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
    color: colors.textDim,
  },
  content: {},
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
  clipCard: {
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: colors.bg3,
    width: 140,
  },
  clipThumb: {
    width: 140,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clipOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 8,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  clipBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  clipDurationBadge: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 0,
  },
  clipDurationText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: '700',
    color: '#fff',
  },
  clipCount: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: 'rgba(255,255,255,0.7)',
  },
  clipCaption: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textMuted,
    padding: 8,
  },
});
