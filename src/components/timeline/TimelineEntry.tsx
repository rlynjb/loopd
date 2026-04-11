import { useState, useEffect } from 'react';
import { View, Text, Pressable, Image, StyleSheet } from 'react-native';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { File as FSFile } from 'expo-file-system';
import { colors, fonts } from '../../constants/theme';
import { CATEGORIES } from '../../constants/categories';
import { CAPTURE_TYPES } from '../../constants/captureTypes';
import { Icon } from '../ui/Icon';
import type { Entry, Habit } from '../../types/entry';

type Props = {
  entry: Entry;
  habits: Habit[];
  onEdit?: (entry: Entry) => void;
};

export function TimelineEntry({ entry, habits, onEdit }: Props) {
  const cat = CATEGORIES.find(c => c.id === entry.category);
  const captureType = CAPTURE_TYPES.find(c => c.id === entry.type);
  const isHabit = entry.type === 'habit';
  const isVideo = entry.type === 'video';

  const clipRefs = entry.clips?.length > 0
    ? entry.clips
    : entry.clipUri ? [{ uri: entry.clipUri, durationMs: entry.clipDurationMs ?? 0 }] : [];

  const [thumbnails, setThumbnails] = useState<({ uri: string | null; missing: boolean })[]>([]);

  useEffect(() => {
    if (!isVideo || clipRefs.length === 0) return;
    let cancelled = false;
    (async () => {
      const thumbs: ({ uri: string | null; missing: boolean })[] = [];
      for (const c of clipRefs) {
        try {
          const file = new FSFile(c.uri);
          if (!file.exists) {
            if (!cancelled) thumbs.push({ uri: null, missing: true });
          } else {
            const t = await VideoThumbnails.getThumbnailAsync(c.uri, { time: 500, quality: 0.3 });
            if (!cancelled) thumbs.push({ uri: t.uri, missing: false });
          }
        } catch {
          if (!cancelled) thumbs.push({ uri: null, missing: true });
        }
      }
      if (!cancelled) setThumbnails(thumbs);
    })();
    return () => { cancelled = true; };
  }, [entry.id, clipRefs.length]);

  const time = new Date(entry.createdAt);
  const timeStr = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <Text style={styles.timeLabel}>{timeStr}</Text>
        <View style={[styles.typeBadge, { backgroundColor: `${captureType?.color}18`, borderColor: `${captureType?.color}30` }]}>
          <View style={styles.typeBadgeContent}>
            {captureType && <Icon name={captureType.icon} size={12} color={captureType.color} />}
            <Text style={[styles.typeText, { color: captureType?.color }]}>
              {captureType?.label}
            </Text>
          </View>
        </View>
      </View>

      <Pressable
        onPress={() => onEdit?.(entry)}
        style={({ pressed }) => [
          styles.card,
          pressed && styles.cardPressed,
        ]}
      >

        {/* Clip thumbnails */}
        {isVideo && clipRefs.length > 0 && (
          <View style={styles.thumbRow}>
            {clipRefs.map((c, i) => {
              const thumb = thumbnails[i];
              const isMissing = thumb?.missing ?? false;
              return (
                <View key={i} style={[styles.thumbCard, isMissing && styles.thumbCardMissing]}>
                  {isMissing ? (
                    <View style={[styles.thumbImage, styles.thumbMissing]}>
                      <Icon name="video" size={12} color={colors.coral} />
                      <Text style={styles.thumbMissingText}>missing</Text>
                    </View>
                  ) : thumb?.uri ? (
                    <Image source={{ uri: thumb.uri }} style={styles.thumbImage} />
                  ) : (
                    <View style={[styles.thumbImage, styles.thumbPlaceholder]}>
                      <Icon name="video" size={14} color={colors.textDim} />
                    </View>
                  )}
                  <View style={styles.thumbDuration}>
                    <Text style={styles.thumbDurationText}>{Math.round(c.durationMs / 1000)}s</Text>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {isHabit && entry.habits.length > 0 ? (
          <View style={styles.habitList}>
            {entry.habits.map(hId => {
              const h = habits.find(x => x.id === hId);
              if (!h) return null;
              return (
                <View key={hId} style={styles.habitRow}>
                  <View style={styles.checkBox}>
                    <Icon name="checkSquare" size={12} color={colors.green} />
                  </View>
                  <Text style={styles.habitLabel}>{h.label}</Text>
                </View>
              );
            })}
            {entry.text ? (
              <Text style={styles.habitNote}>{entry.text}</Text>
            ) : null}
          </View>
        ) : entry.text ? (
          <Text style={styles.entryText}>{entry.text}</Text>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    marginBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  timeLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
  },
  card: {
    padding: 14,
    paddingTop: 0,
  },
  cardPressed: {
    opacity: 0.7,
  },
  typeBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
  },
  typeBadgeContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  typeText: {
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  // Thumbnails
  thumbRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  thumbCard: {
    position: 'relative',
    width: '31%',
    aspectRatio: 4 / 3,
    backgroundColor: colors.bg3,
    overflow: 'hidden',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  thumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbCardMissing: {
    borderWidth: 1,
    borderColor: `${colors.coral}30`,
  },
  thumbMissing: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${colors.coral}08`,
    gap: 2,
  },
  thumbMissingText: {
    fontFamily: fonts.mono,
    fontSize: 7,
    color: colors.coral,
  },
  thumbDuration: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  thumbDurationText: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: '#fff',
  },
  entryText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.text,
    lineHeight: 22,
  },
  habitList: {
    gap: 6,
  },
  habitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  checkBox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    backgroundColor: `${colors.green}25`,
    borderWidth: 1.5,
    borderColor: colors.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  habitLabel: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.text,
  },
  habitNote: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.textMuted,
    fontStyle: 'italic',
    marginTop: 4,
  },
});
