import { useState, useEffect } from 'react';
import { View, Text, Pressable, TextInput, Modal, ScrollView, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { MOODS } from '../../constants/moods';
import { CATEGORIES } from '../../constants/categories';
import { CAPTURE_TYPES } from '../../constants/captureTypes';
import { Icon } from '../ui/Icon';
import type { Habit, Entry } from '../../types/entry';
import { generateId } from '../../utils/id';
import { getTodayString } from '../../utils/time';
import { pickAndCopyClip } from '../../services/fileManager';

type Props = {
  visible: boolean;
  initialType?: string | null;
  habits: Habit[];
  date: string;
  onClose: () => void;
  onSave: (entry: Entry) => void;
};

export function CaptureSheet({ visible, initialType, habits, date, onClose, onSave }: Props) {
  const [step, setStep] = useState<'type' | 'details'>('type');
  const [captureType, setCaptureType] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [mood, setMood] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [selectedHabits, setSelectedHabits] = useState<string[]>([]);
  const [habitNote, setHabitNote] = useState('');
  const [clipUri, setClipUri] = useState<string | null>(null);
  const [clipDurationMs, setClipDurationMs] = useState<number | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  // Sync state when sheet opens or initialType changes
  useEffect(() => {
    if (visible) {
      setText('');
      setMood(null);
      setCategory(null);
      setSelectedHabits([]);
      setHabitNote('');
      setClipUri(null);
      setClipDurationMs(null);
      setPickError(null);
      setPicking(false);
      if (initialType) {
        setCaptureType(initialType);
        setStep('details');
      } else {
        setCaptureType(null);
        setStep('type');
      }
    }
  }, [visible, initialType]);

  const reset = () => {
    setStep('type');
    setCaptureType(null);
    setText('');
    setMood(null);
    setCategory(null);
    setSelectedHabits([]);
    setHabitNote('');
    setClipUri(null);
    setClipDurationMs(null);
    setPickError(null);
    setPicking(false);
  };

  const handleClose = () => {
    reset();
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
        console.log('[loopd] Clip picked:', result.uri, 'duration:', result.durationMs);
        setClipUri(result.uri);
        setClipDurationMs(result.durationMs);
      } else {
        console.log('[loopd] Clip pick cancelled');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[loopd] Clip pick error:', msg);
      setPickError(msg);
    } finally {
      setPicking(false);
    }
  };

  const canSave = () => {
    if (captureType === 'habit') return selectedHabits.length > 0;
    if (captureType === 'moment') return !!mood || !!category;
    if (captureType === 'video') return !!clipUri;
    return text.trim().length > 0;
  };

  const handleSave = () => {
    if (!canSave()) return;

    const entry: Entry = {
      id: generateId('entry'),
      date,
      type: captureType as Entry['type'],
      text: captureType === 'habit' ? habitNote.trim() || null : text.trim() || null,
      mood: captureType === 'moment' ? mood : null,
      category: captureType === 'moment' ? category : null,
      habits: captureType === 'habit' ? selectedHabits : [],
      clipUri: captureType === 'video' ? clipUri : null,
      clipDurationMs: captureType === 'video' ? clipDurationMs : null,
      createdAt: new Date().toISOString(),
    };

    console.log('[loopd] Saving entry:', entry.type, 'clipUri:', entry.clipUri, 'duration:', entry.clipDurationMs);
    onSave(entry);
    reset();
  };

  return (
    <Modal visible={visible} transparent={false} animationType="fade" onRequestClose={handleClose}>
      <View style={styles.modalContainer}>
        <View style={styles.modalHeader}>
          <Pressable onPress={handleClose} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>← Back</Text>
          </Pressable>
        </View>
        <ScrollView
          style={styles.modalScroll}
          contentContainerStyle={styles.modalContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >

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

            {step === 'details' && (captureType === 'video' || captureType === 'journal') && (
              <View>
                <Text style={styles.subtitle}>
                  {captureType === 'video' ? 'Add Clip' : 'Journal entry'}
                </Text>
                <Text style={styles.hint}>
                  {captureType === 'video' ? 'Import a clip from your camera roll' : 'Write freely — this is your space'}
                </Text>
                {captureType === 'video' && (
                  <View>
                    <Pressable
                      onPress={!picking ? handlePickClip : undefined}
                      style={[styles.pickBtn, clipUri ? styles.pickBtnDone : null]}
                    >
                      <Text style={[styles.pickBtnText, clipUri ? styles.pickBtnTextDone : null]}>
                        {picking ? 'Opening gallery...' : clipUri ? '✓ Clip loaded — tap to change' : 'Choose from camera roll'}
                      </Text>
                    </Pressable>
                    {clipUri && (
                      <View style={styles.clipInfo}>
                        <Text style={styles.clipInfoText} numberOfLines={1}>
                          {clipUri.split('/').pop()}
                        </Text>
                        {clipDurationMs ? (
                          <Text style={styles.clipInfoDuration}>
                            {Math.round(clipDurationMs / 1000)}s
                          </Text>
                        ) : null}
                      </View>
                    )}
                    {pickError && (
                      <Text style={styles.pickErrorText}>{pickError}</Text>
                    )}
                  </View>
                )}
                <TextInput
                  value={text}
                  onChangeText={setText}
                  placeholder={captureType === 'video' ? 'What happened in this clip?' : "What's on your mind?"}
                  placeholderTextColor={colors.textDimmer}
                  multiline
                  autoFocus={captureType === 'journal'}
                  style={styles.textArea}
                />
                <Pressable
                  onPress={canSave() ? handleSave : undefined}
                  style={[styles.saveBtn, { backgroundColor: canSave() ? colors.accent : 'rgba(255,255,255,0.05)' }]}
                >
                  <Text style={[styles.saveBtnText, { color: canSave() ? '#0c0c0e' : colors.textDimmer }]}>SAVE</Text>
                </Pressable>
              </View>
            )}

            {step === 'details' && captureType === 'habit' && (
              <View>
                <Text style={styles.subtitle}>Log Habits</Text>
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
                            backgroundColor: checked ? 'rgba(167,139,250,0.12)' : colors.cardBg,
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
                  <Text style={[styles.saveBtnText, { color: canSave() ? '#0c0c0e' : colors.textDimmer }]}>SAVE HABITS</Text>
                </Pressable>
              </View>
            )}

            {step === 'details' && captureType === 'moment' && (
              <View>
                <Text style={styles.subtitle}>Log a Moment</Text>
                <Text style={styles.hint}>Tag what's happening right now</Text>

                <Text style={styles.fieldLabel}>MOOD</Text>
                <View style={styles.chipRow}>
                  {MOODS.map(m => (
                    <Pressable
                      key={m.id}
                      onPress={() => setMood(m.id)}
                      style={[
                        styles.moodChip,
                        {
                          backgroundColor: mood === m.id ? `${m.color}15` : 'rgba(255,255,255,0.03)',
                          borderColor: mood === m.id ? m.color : 'rgba(255,255,255,0.06)',
                        },
                      ]}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                        <Icon name={m.icon} size={14} color={mood === m.id ? m.color : colors.textMuted} />
                        <Text style={[styles.chipText, { color: mood === m.id ? m.color : colors.textMuted }]}>{m.label}</Text>
                      </View>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.fieldLabel}>CATEGORY</Text>
                <View style={styles.chipRow}>
                  {CATEGORIES.map(c => (
                    <Pressable
                      key={c.id}
                      onPress={() => setCategory(c.id)}
                      style={[
                        styles.moodChip,
                        {
                          backgroundColor: category === c.id ? `${colors.accent2}15` : 'rgba(255,255,255,0.03)',
                          borderColor: category === c.id ? colors.accent2 : 'rgba(255,255,255,0.06)',
                        },
                      ]}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                        <Icon name={c.icon} size={14} color={category === c.id ? colors.accent2 : colors.textMuted} />
                        <Text style={[styles.chipText, { color: category === c.id ? colors.accent2 : colors.textMuted }]}>{c.label}</Text>
                      </View>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.fieldLabel}>NOTE (optional)</Text>
                <TextInput
                  value={text}
                  onChangeText={setText}
                  placeholder="What are you up to?"
                  placeholderTextColor={colors.textDimmer}
                  multiline
                  style={[styles.textArea, { height: 50 }]}
                />
                <Pressable
                  onPress={canSave() ? handleSave : undefined}
                  style={[styles.saveBtn, { backgroundColor: canSave() ? colors.accent : 'rgba(255,255,255,0.05)' }]}
                >
                  <Text style={[styles.saveBtnText, { color: canSave() ? '#0c0c0e' : colors.textDimmer }]}>SAVE MOMENT</Text>
                </Pressable>
              </View>
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
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  closeBtn: {
    padding: 4,
  },
  closeBtnText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textMuted,
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
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    marginBottom: 20,
  },
  subtitle: {
    fontFamily: fonts.heading,
    fontSize: 18,
    fontWeight: '700',
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
  typeIcon: {
    fontSize: 32,
  },
  typeLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.8,
  },
  textArea: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 14,
    padding: 16,
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
    borderRadius: 12,
    alignItems: 'center',
  },
  saveBtnText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  pickBtn: {
    backgroundColor: 'rgba(251,113,133,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(251,113,133,0.25)',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 14,
  },
  pickBtnText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.coral,
    letterSpacing: 0.5,
  },
  pickBtnDone: {
    backgroundColor: colors.greenBg,
    borderColor: `${colors.green}40`,
    marginBottom: 6,
  },
  pickBtnTextDone: {
    color: colors.green,
  },
  clipInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 4,
    marginBottom: 14,
  },
  clipInfoText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
    flex: 1,
  },
  clipInfoDuration: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.amber,
    marginLeft: 8,
  },
  pickErrorText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.coral,
    paddingHorizontal: 4,
    marginBottom: 10,
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
  checkMark: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.purple,
  },
  habitEmoji: {
    fontSize: 14,
  },
  habitLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  moodChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  chipText: {
    fontFamily: fonts.mono,
    fontSize: 11,
  },
});
