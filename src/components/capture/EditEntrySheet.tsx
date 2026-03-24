import { useState, useEffect } from 'react';
import { View, Text, Pressable, TextInput, Modal, ScrollView, Image, StyleSheet } from 'react-native';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import type { Entry, Habit, ClipRef } from '../../types/entry';

type ClipWithThumb = ClipRef & { thumbnail: string | null };

type Props = {
  entry: Entry | null;
  habits: Habit[];
  onClose: () => void;
  onSave: (entry: Entry) => void;
  onDelete: (id: string) => void;
};

export function EditEntrySheet({ entry, habits, onClose, onSave, onDelete }: Props) {
  const [text, setText] = useState('');
  const [selectedHabits, setSelectedHabits] = useState<string[]>([]);
  const [clipThumbs, setClipThumbs] = useState<ClipWithThumb[]>([]);

  useEffect(() => {
    if (entry) {
      setText(entry.text ?? '');
      setSelectedHabits(entry.habits);
      // Generate thumbnails for clips
      if (entry.type === 'video' && entry.clips.length > 0) {
        (async () => {
          const thumbs: ClipWithThumb[] = [];
          for (const c of entry.clips) {
            let thumbnail: string | null = null;
            try {
              const t = await VideoThumbnails.getThumbnailAsync(c.uri, { time: 500, quality: 0.5 });
              thumbnail = t.uri;
            } catch { /* ignore */ }
            thumbs.push({ ...c, thumbnail });
          }
          setClipThumbs(thumbs);
        })();
      } else if (entry.type === 'video' && entry.clipUri) {
        (async () => {
          let thumbnail: string | null = null;
          try {
            const t = await VideoThumbnails.getThumbnailAsync(entry.clipUri!, { time: 500, quality: 0.5 });
            thumbnail = t.uri;
          } catch { /* ignore */ }
          setClipThumbs([{ uri: entry.clipUri!, durationMs: entry.clipDurationMs ?? 0, thumbnail }]);
        })();
      } else {
        setClipThumbs([]);
      }
    }
  }, [entry]);

  if (!entry) return null;

  const isHabit = entry.type === 'habit';
  const isVideo = entry.type === 'video';

  const toggleHabit = (id: string) => {
    setSelectedHabits(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleSave = () => {
    onSave({
      ...entry,
      text: text.trim() || null,
      habits: isHabit ? selectedHabits : entry.habits,
    });
  };

  const time = new Date(entry.createdAt);
  const timeStr = time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  return (
    <Modal visible={!!entry} transparent={false} animationType="fade" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onClose}>
            <Text style={styles.backText}>← Back</Text>
          </Pressable>
          <Text style={styles.timeText}>{timeStr}</Text>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.subtitle}>
            {isVideo ? 'Edit Clips' : isHabit ? 'Edit Habits' : 'Edit Journal'}
          </Text>
          <Text style={styles.hint}>
            {isVideo ? `${clipThumbs.length} clip${clipThumbs.length !== 1 ? 's' : ''}` : timeStr}
          </Text>

          {/* Clip thumbnails — same layout as CaptureSheet */}
          {isVideo && clipThumbs.length > 0 && (
            <View style={styles.clipGrid}>
              {clipThumbs.map((clip, i) => (
                <View key={i} style={styles.clipCard}>
                  {clip.thumbnail ? (
                    <Image source={{ uri: clip.thumbnail }} style={styles.clipThumb} />
                  ) : (
                    <View style={[styles.clipThumb, styles.clipThumbPlaceholder]}>
                      <Icon name="video" size={20} color={colors.textDim} />
                    </View>
                  )}
                  <View style={styles.clipDurationBadge}>
                    <Text style={styles.clipDurationText}>{Math.round(clip.durationMs / 1000)}s</Text>
                  </View>
                  <View style={styles.clipNameBar}>
                    <Text style={styles.clipNameText} numberOfLines={1}>{clip.uri.split('/').pop()}</Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Text / caption */}
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={isHabit ? 'Optional note...' : isVideo ? "What's in these clips? (optional)" : "What's on your mind?"}
            placeholderTextColor={colors.textDimmer}
            multiline
            style={styles.textArea}
          />

          {/* Habit checkboxes */}
          {isHabit && (
            <>
              <Text style={styles.fieldLabel}>HABITS</Text>
              <View style={styles.chipRow}>
                {habits.map(h => {
                  const checked = selectedHabits.includes(h.id);
                  return (
                    <Pressable
                      key={h.id}
                      onPress={() => toggleHabit(h.id)}
                      style={[
                        styles.habitChip,
                        {
                          backgroundColor: checked ? `${colors.purple}18` : colors.bg3,
                          borderColor: checked ? colors.purple : colors.cardBorder,
                        },
                      ]}
                    >
                      {checked && <Icon name="checkSquare" size={12} color={colors.purple} />}
                      <Text style={[styles.habitLabel, { color: checked ? colors.purple : colors.textMuted }]}>
                        {h.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable onPress={() => onDelete(entry.id)} style={styles.deleteBtn}>
            <Icon name="trash" size={16} color={colors.coral} />
          </Pressable>
          <Pressable onPress={handleSave} style={styles.saveBtn}>
            <Text style={styles.saveBtnText}>Save changes</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
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
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  backText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textMuted,
  },
  timeText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 24,
    paddingBottom: 48,
  },
  subtitle: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: colors.text,
    textAlign: 'center',
    marginBottom: 4,
  },
  hint: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    textAlign: 'center',
    letterSpacing: 0.6,
    marginBottom: 16,
  },
  // Clip grid — matches CaptureSheet
  clipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  clipCard: {
    position: 'relative',
    width: '48%',
    aspectRatio: 4 / 3,
    backgroundColor: colors.bg3,
    overflow: 'hidden',
  },
  clipThumb: {
    width: '100%',
    height: '100%',
  },
  clipThumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  clipDurationBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  clipDurationText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: '#fff',
  },
  clipNameBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  clipNameText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: '#fff',
  },
  textArea: {
    backgroundColor: colors.bg3,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: colors.radius,
    padding: 14,
    color: colors.text,
    fontSize: 14,
    fontFamily: fonts.body,
    minHeight: 80,
    textAlignVertical: 'top',
    marginBottom: 14,
  },
  fieldLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
    marginBottom: 8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  habitChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  habitLabel: {
    fontFamily: fonts.body,
    fontSize: 13,
  },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 36,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    flexDirection: 'row',
    gap: 10,
  },
  deleteBtn: {
    width: 48,
    paddingVertical: 14,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: `${colors.coral}30`,
    backgroundColor: `${colors.coral}08`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: colors.radius,
    backgroundColor: colors.accent,
    alignItems: 'center',
  },
  saveBtnText: {
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: '600',
    color: colors.bg,
  },
});
