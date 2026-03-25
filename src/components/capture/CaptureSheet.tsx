import { useState, useEffect } from 'react';
import { View, Text, Pressable, TextInput, Modal, ScrollView, Image, StyleSheet } from 'react-native';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { File as FSFile } from 'expo-file-system';
import { colors, fonts } from '../../constants/theme';
import { CAPTURE_TYPES } from '../../constants/captureTypes';
import { Icon } from '../ui/Icon';
import type { Habit, Entry, ClipRef } from '../../types/entry';
import { generateId } from '../../utils/id';
import { pickAndCopyClip } from '../../services/fileManager';

type PickedClip = {
  uri: string;
  durationMs: number;
  thumbnail: string | null;
  missing?: boolean;
};

type Props = {
  visible: boolean;
  initialType?: string | null;
  editEntry?: Entry | null;
  habits: Habit[];
  date: string;
  onClose: () => void;
  onSave: (entry: Entry) => void;
  onDelete?: (id: string) => void;
};

export function CaptureSheet({ visible, initialType, editEntry, habits, date, onClose, onSave, onDelete }: Props) {
  const isEdit = !!editEntry;
  const [step, setStep] = useState<'type' | 'details'>('type');
  const [captureType, setCaptureType] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [selectedHabits, setSelectedHabits] = useState<string[]>([]);
  const [habitNote, setHabitNote] = useState('');
  const [clips, setClips] = useState<PickedClip[]>([]);
  const [pickError, setPickError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  // Sync state when sheet opens
  useEffect(() => {
    if (!visible) return;

    setPickError(null);
    setPicking(false);

    if (editEntry) {
      // Edit mode — pre-populate from entry
      setCaptureType(editEntry.type);
      setStep('details');
      setText(editEntry.text ?? '');
      setSelectedHabits(editEntry.habits);
      setHabitNote(editEntry.type === 'habit' ? (editEntry.text ?? '') : '');

      // Load clip thumbnails
      if (editEntry.type === 'video') {
        const entryClips = editEntry.clips.length > 0
          ? editEntry.clips
          : editEntry.clipUri ? [{ uri: editEntry.clipUri, durationMs: editEntry.clipDurationMs ?? 0 }] : [];
        loadThumbnails(entryClips);
      } else {
        setClips([]);
      }
    } else if (initialType) {
      // Add mode with pre-selected type
      setCaptureType(initialType);
      setStep('details');
      setText('');
      setSelectedHabits([]);
      setHabitNote('');
      setClips([]);
    } else {
      // Add mode — show type picker
      setCaptureType(null);
      setStep('type');
      setText('');
      setSelectedHabits([]);
      setHabitNote('');
      setClips([]);
    }
  }, [visible, editEntry, initialType]);

  const loadThumbnails = async (refs: ClipRef[]) => {
    const result: PickedClip[] = [];
    for (const c of refs) {
      let thumbnail: string | null = null;
      let missing = false;
      try {
        const file = new FSFile(c.uri);
        if (!file.exists) {
          missing = true;
        } else {
          const t = await VideoThumbnails.getThumbnailAsync(c.uri, { time: 500, quality: 0.5 });
          thumbnail = t.uri;
        }
      } catch {
        missing = true;
      }
      result.push({ uri: c.uri, durationMs: c.durationMs, thumbnail, missing });
    }
    setClips(result);
  };

  const handleClose = () => {
    onClose();
  };

  const toggleHabit = (id: string) => {
    setSelectedHabits(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handlePickClip = async () => {
    setPicking(true);
    setPickError(null);
    try {
      const result = await pickAndCopyClip(date);
      if (result) {
        let thumbnail: string | null = null;
        try {
          const t = await VideoThumbnails.getThumbnailAsync(result.uri, { time: 500, quality: 0.5 });
          thumbnail = t.uri;
        } catch { /* ignore */ }
        setClips(prev => [...prev, { uri: result.uri, durationMs: result.durationMs, thumbnail }]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setPickError(msg);
    } finally {
      setPicking(false);
    }
  };

  const removeClip = (index: number) => {
    setClips(prev => prev.filter((_, i) => i !== index));
  };

  const reimportClip = async (index: number) => {
    setPicking(true);
    try {
      const result = await pickAndCopyClip(date);
      if (result) {
        let thumbnail: string | null = null;
        try {
          const t = await VideoThumbnails.getThumbnailAsync(result.uri, { time: 500, quality: 0.5 });
          thumbnail = t.uri;
        } catch { /* ignore */ }
        setClips(prev => prev.map((c, i) => i === index
          ? { uri: result.uri, durationMs: result.durationMs, thumbnail, missing: false }
          : c
        ));
      }
    } catch { /* ignore */ } finally {
      setPicking(false);
    }
  };

  const canSave = () => {
    if (captureType === 'habit') return selectedHabits.length > 0;
    if (captureType === 'video') return clips.length > 0;
    return text.trim().length > 0;
  };

  const handleSave = () => {
    if (!canSave()) return;

    if (captureType === 'video') {
      const clipRefs: ClipRef[] = clips.map(c => ({ uri: c.uri, durationMs: c.durationMs }));
      const entry: Entry = {
        ...(editEntry ?? {
          id: generateId('entry'),
          date,
          mood: null,
          category: null,
          createdAt: new Date().toISOString(),
        }),
        type: 'video',
        text: text.trim() || null,
        habits: [],
        clipUri: clipRefs[0]?.uri ?? null,
        clipDurationMs: clipRefs[0]?.durationMs ?? null,
        clips: clipRefs,
      } as Entry;
      onSave(entry);
    } else if (captureType === 'habit') {
      const entry: Entry = {
        ...(editEntry ?? {
          id: generateId('entry'),
          date,
          mood: null,
          category: null,
          clipUri: null,
          clipDurationMs: null,
          clips: [],
          createdAt: new Date().toISOString(),
        }),
        type: 'habit',
        text: habitNote.trim() || null,
        habits: selectedHabits,
      } as Entry;
      onSave(entry);
    } else {
      const entry: Entry = {
        ...(editEntry ?? {
          id: generateId('entry'),
          date,
          mood: null,
          category: null,
          habits: [],
          clipUri: null,
          clipDurationMs: null,
          clips: [],
          createdAt: new Date().toISOString(),
        }),
        type: (captureType ?? 'journal') as Entry['type'],
        text: text.trim() || null,
      } as Entry;
      onSave(entry);
    }
  };

  const title = isEdit
    ? captureType === 'video' ? 'Edit Clips' : captureType === 'habit' ? 'Edit Habits' : 'Edit Journal'
    : captureType === 'video' ? 'Add Clips' : captureType === 'habit' ? 'Log Habits' : 'Journal entry';

  return (
    <Modal visible={visible} transparent={false} animationType="fade" onRequestClose={handleClose}>
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <Pressable onPress={handleClose} hitSlop={12} style={styles.backBtn}>
            <Icon name="chevronLeft" size={22} color={colors.textMuted} />
          </Pressable>
        </View>
        <ScrollView
          style={styles.modalScroll}
          contentContainerStyle={styles.modalContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >

          {/* Type picker — only in add mode with no pre-selected type */}
          {step === 'type' && (
            <View>
              <Text style={styles.title}>Quick Capture</Text>
              <View style={styles.typeGrid}>
                {CAPTURE_TYPES.map(ct => (
                  <Pressable
                    key={ct.id}
                    onPress={() => { setCaptureType(ct.id); setStep('details'); }}
                    style={[styles.typeBtn, { backgroundColor: `${ct.color}10`, borderColor: `${ct.color}30` }]}
                  >
                    <Icon name={ct.icon} size={28} color={ct.color} />
                    <Text style={[styles.typeLabel, { color: ct.color }]}>{ct.label.toUpperCase()}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          {/* Video / Clip */}
          {step === 'details' && captureType === 'video' && (
            <View>
              <Text style={styles.subtitle}>{title}</Text>
              <Text style={styles.hint}>
                {clips.length > 0 ? `${clips.length} clip${clips.length > 1 ? 's' : ''}` : 'Import clips from your camera roll'}
              </Text>

              {/* Clip thumbnails grid */}
              {clips.length > 0 && (
                <View style={styles.clipGrid}>
                  {clips.map((clip, i) => (
                    <View key={i} style={[styles.clipCard, clip.missing && styles.clipCardMissing]}>
                      {clip.missing ? (
                        <Pressable onPress={() => reimportClip(i)} style={[styles.clipThumb, styles.clipThumbMissing]}>
                          <Icon name="video" size={18} color={colors.coral} />
                          <Text style={styles.reimportText}>Re-import</Text>
                        </Pressable>
                      ) : clip.thumbnail ? (
                        <Image source={{ uri: clip.thumbnail }} style={styles.clipThumb} />
                      ) : (
                        <View style={[styles.clipThumb, styles.clipThumbPlaceholder]}>
                          <Icon name="video" size={20} color={colors.textDim} />
                        </View>
                      )}
                      <View style={styles.clipDurationBadge}>
                        <Text style={styles.clipDurationText}>{Math.round(clip.durationMs / 1000)}s</Text>
                      </View>
                      <Pressable onPress={() => removeClip(i)} style={styles.clipRemoveBtn}>
                        <Icon name="x" size={14} color="#fff" />
                      </Pressable>
                      <View style={styles.clipNameBar}>
                        <Text style={[styles.clipNameText, clip.missing && { color: colors.coral }]} numberOfLines={1}>
                          {clip.missing ? 'File missing' : clip.uri.split('/').pop()}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}

              {/* Add more */}
              <Pressable
                onPress={!picking ? handlePickClip : undefined}
                style={styles.addClipBtn}
              >
                {picking ? (
                  <Text style={styles.addClipBtnText}>Opening gallery...</Text>
                ) : (
                  <View style={styles.addClipBtnContent}>
                    <Icon name="plus" size={16} color={colors.textMuted} />
                    <Text style={styles.addClipBtnText}>
                      {clips.length === 0 ? 'Choose from camera roll' : 'Add another clip'}
                    </Text>
                  </View>
                )}
              </Pressable>

              {pickError && <Text style={styles.pickErrorText}>{pickError}</Text>}

              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="What's in these clips? (optional)"
                placeholderTextColor={colors.textDimmer}
                multiline
                style={styles.textArea}
              />

              <Pressable
                onPress={canSave() ? handleSave : undefined}
                style={[styles.saveBtn, { backgroundColor: canSave() ? colors.accent : 'rgba(255,255,255,0.05)' }]}
              >
                <Text style={[styles.saveBtnText, { color: canSave() ? colors.bg : colors.textDimmer }]}>
                  {isEdit ? 'SAVE CHANGES' : clips.length <= 1 ? 'SAVE' : `SAVE ${clips.length} CLIPS`}
                </Text>
              </Pressable>
            </View>
          )}

          {/* Journal */}
          {step === 'details' && captureType === 'journal' && (
            <View>
              <Text style={styles.subtitle}>{title}</Text>
              <Text style={styles.hint}>Write freely — this is your space</Text>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="What's on your mind?"
                placeholderTextColor={colors.textDimmer}
                multiline
                autoFocus={!isEdit}
                style={styles.textArea}
              />
              <Pressable
                onPress={canSave() ? handleSave : undefined}
                style={[styles.saveBtn, { backgroundColor: canSave() ? colors.accent : 'rgba(255,255,255,0.05)' }]}
              >
                <Text style={[styles.saveBtnText, { color: canSave() ? colors.bg : colors.textDimmer }]}>
                  {isEdit ? 'SAVE CHANGES' : 'SAVE'}
                </Text>
              </Pressable>
            </View>
          )}

          {/* Habit */}
          {step === 'details' && captureType === 'habit' && (
            <View>
              <Text style={styles.subtitle}>{title}</Text>
              <Text style={styles.hint}>Check off what you did today</Text>
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
                          backgroundColor: checked ? `${colors.purple}18` : colors.bg,
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
              <Text style={styles.fieldLabel}>NOTE (optional)</Text>
              <TextInput
                value={habitNote}
                onChangeText={setHabitNote}
                placeholder="How did it feel? Any details..."
                placeholderTextColor={colors.textDimmer}
                multiline
                style={[styles.textArea, { height: 60 }]}
              />
              <Pressable
                onPress={canSave() ? handleSave : undefined}
                style={[styles.saveBtn, { backgroundColor: canSave() ? colors.accent : 'rgba(255,255,255,0.05)' }]}
              >
                <Text style={[styles.saveBtnText, { color: canSave() ? colors.bg : colors.textDimmer }]}>
                  {isEdit ? 'SAVE CHANGES' : 'SAVE HABITS'}
                </Text>
              </Pressable>
            </View>
          )}

          {/* Delete — only in edit mode */}
          {isEdit && (
            <Pressable onPress={() => onDelete?.(editEntry!.id)} style={styles.deleteBtn}>
              <Icon name="trash" size={14} color={colors.coral} />
              <Text style={styles.deleteBtnText}>Delete entry</Text>
            </Pressable>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  modalHeader: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  backBtn: {
    padding: 8,
  },
  modalScroll: {
    flex: 1,
  },
  modalContent: {
    padding: 24,
    paddingBottom: 48,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.text,
    textAlign: 'center',
    marginBottom: 20,
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
  typeGrid: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
  },
  typeBtn: {
    width: 80,
    height: 80,
    borderRadius: 20,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  typeLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.8,
  },
  // Clip grid
  clipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 10,
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
  clipCardMissing: {
    borderWidth: 1,
    borderColor: `${colors.coral}40`,
  },
  clipThumbMissing: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${colors.coral}08`,
    gap: 4,
  },
  reimportText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.coral,
    letterSpacing: 0.3,
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
  clipRemoveBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
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
  addClipBtn: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.cardBorder,
    borderRadius: colors.radius,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 16,
  },
  addClipBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  addClipBtnText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textMuted,
  },
  pickErrorText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.coral,
    paddingHorizontal: 4,
    marginBottom: 10,
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
    height: 100,
    textAlignVertical: 'top',
    marginBottom: 14,
  },
  saveBtn: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: colors.radius,
    alignItems: 'center',
  },
  saveBtnText: {
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: '600',
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
    marginBottom: 14,
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
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 24,
    paddingVertical: 14,
    borderRadius: colors.radius,
    borderWidth: 1,
    borderColor: `${colors.coral}30`,
    backgroundColor: `${colors.coral}08`,
  },
  deleteBtnText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.coral,
  },
});
