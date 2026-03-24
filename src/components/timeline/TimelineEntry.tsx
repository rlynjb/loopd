import { useState, useEffect } from 'react';
import { View, Text, Pressable, Image, StyleSheet } from 'react-native';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { colors, fonts } from '../../constants/theme';
import { MOODS } from '../../constants/moods';
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
  const mood = MOODS.find(m => m.id === entry.mood);
  const cat = CATEGORIES.find(c => c.id === entry.category);
  const captureType = CAPTURE_TYPES.find(c => c.id === entry.type);
  const isHabit = entry.type === 'habit';
  const isVideo = entry.type === 'video';

  const clipRefs = entry.clips?.length > 0
    ? entry.clips
    : entry.clipUri ? [{ uri: entry.clipUri, durationMs: entry.clipDurationMs ?? 0 }] : [];

  const [thumbnails, setThumbnails] = useState<(string | null)[]>([]);

  useEffect(() => {
    if (!isVideo || clipRefs.length === 0) return;
    let cancelled = false;
    (async () => {
      const thumbs: (string | null)[] = [];
      for (const c of clipRefs) {
        try {
          const t = await VideoThumbnails.getThumbnailAsync(c.uri, { time: 500, quality: 0.3 });
          if (!cancelled) thumbs.push(t.uri);
        } catch {
          if (!cancelled) thumbs.push(null);
        }
      }
      if (!cancelled) setThumbnails(thumbs);
    })();
    return () => { cancelled = true; };
  }, [entry.id]);

  const time = new Date(entry.createdAt);
  const timeStr = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  return (
    <View style={styles.container}>
      <Text style={styles.timeLabel}>{timeStr}</Text>

      <Pressable
        onPress={() => onEdit?.(entry)}
        style={({ pressed }) => [
          styles.card,
          pressed && styles.cardPressed,
        ]}
      >
        <View style={styles.badges}>
          <View style={[styles.typeBadge, { backgroundColor: `${captureType?.color}18`, borderColor: `${captureType?.color}30` }]}>
            <View style={styles.typeBadgeContent}>
              {captureType && <Icon name={captureType.icon} size={12} color={captureType.color} />}
              <Text style={[styles.typeText, { color: captureType?.color }]}>
                {captureType?.label}
              </Text>
            </View>
          </View>
          {mood && (
            <View style={styles.moodBadge}>
              <Icon name={mood.icon} size={10} color={mood.color} />
              <Text style={[styles.moodText, { color: mood.color }]}>{mood.label}</Text>
            </View>
          )}
          {cat && (
            <View style={styles.catBadge}>
              <Icon name={cat.icon} size={10} color={colors.textDim} />
              <Text style={styles.catText}>{cat.label}</Text>
            </View>
          )}
          <Text style={styles.editHint}>tap to edit</Text>
        </View>

        {/* Clip thumbnails */}
        {isVideo && clipRefs.length > 0 && (
          <View style={styles.thumbRow}>
            {clipRefs.map((c, i) => (
              <View key={i} style={styles.thumbCard}>
                {thumbnails[i] ? (
                  <Image source={{ uri: thumbnails[i]! }} style={styles.thumbImage} />
                ) : (
                  <View style={[styles.thumbImage, styles.thumbPlaceholder]}>
                    <Icon name="video" size={14} color={colors.textDim} />
                  </View>
                )}
                <View style={styles.thumbDuration}>
                  <Text style={styles.thumbDurationText}>{Math.round(c.durationMs / 1000)}s</Text>
                </View>
              </View>
            ))}
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
    marginBottom: 10,
  },
  timeLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
    marginBottom: 6,
    paddingLeft: 2,
  },
  card: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: colors.radiusLg,
    padding: 14,
  },
  cardPressed: {
    borderColor: colors.border2,
    backgroundColor: colors.bg3,
  },
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
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
  moodBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  moodText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    opacity: 0.8,
  },
  catBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  catText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
  },
  editHint: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDimmer,
    marginLeft: 'auto',
  },
  // Thumbnails
  thumbRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 8,
  },
  thumbCard: {
    position: 'relative',
    width: 72,
    height: 54,
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
