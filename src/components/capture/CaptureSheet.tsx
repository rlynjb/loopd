import { useState } from 'react';
import { View, Text, Pressable, TextInput, Modal, ScrollView, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { MOODS } from '../../constants/moods';
import { CATEGORIES } from '../../constants/categories';
import type { Habit, Entry } from '../../types/entry';
import { generateId } from '../../utils/id';
import { getTodayString } from '../../utils/time';
import { pickAndCopyClip } from '../../services/fileManager';

const CAPTURE_TYPES = [
  { id: 'video', label: 'Clip', icon: '🎥', color: '#fb7185' },
  { id: 'journal', label: 'Journal', icon: '✍️', color: '#00d9a3' },
  { id: 'habit', label: 'Habit', icon: '💪', color: '#a78bfa' },
  { id: 'moment', label: 'Moment', icon: '📍', color: '#fbbf24' },
] as const;

type Props = {
  visible: boolean;
  initialType?: string | null;
  habits: Habit[];
  date: string;
  onClose: () => void;
  onSave: (entry: Entry) => void;
};

export function CaptureSheet({ visible, initialType, habits, date, onClose, onSave }: Props) {
  const [step, setStep] = useState<'type' | 'details'>(initialType ? 'details' : 'type');
  const [captureType, setCaptureType] = useState<string | null>(initialType ?? null);
  const [text, setText] = useState('');
  const [mood, setMood] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [selectedHabits, setSelectedHabits] = useState<string[]>([]);
  const [habitNote, setHabitNote] = useState('');
  const [clipUri, setClipUri] = useState<string | null>(null);
  const [clipDurationMs, setClipDurationMs] = useState<number | null>(null);

  const reset = () => {
    setStep(initialType ? 'details' : 'type');
    setCaptureType(initialType ?? null);
    setText('');
    setMood(null);
    setCategory(null);
    setSelectedHabits([]);
    setHabitNote('');
    setClipUri(null);
    setClipDurationMs(null);
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
    const result = await pickAndCopyClip(date);
    if (result) {
      setClipUri(result.uri);
      setClipDurationMs(result.durationMs);
    }
  };

  const canSave = () => {
    if (captureType === 'habit') return selectedHabits.length > 0;
    if (captureType === 'moment') return !!mood || !!category;
    if (captureType === 'video') return !!clipUri || text.trim().length > 0;
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

    onSave(entry);
    reset();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <Pressable style={styles.overlay} onPress={handleClose}>
        <Pressable style={styles.sheet} onPress={e => e.stopPropagation()}>
          <View style={styles.handle} />
          <ScrollView showsVerticalScrollIndicator={false}>

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
                      <Text style={styles.typeIcon}>{ct.icon}</Text>
                      <Text style={[styles.typeLabel, { color: ct.color }]}>{ct.label.toUpperCase()}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}

            {step === 'details' && (captureType === 'video' || captureType === 'journal') && (
              <View>
                <Text style={styles.subtitle}>
                  {captureType === 'video' ? '🎥 Add Clip' : '✍️ Journal entry'}
                </Text>
                <Text style={styles.hint}>
                  {captureType === 'video' ? 'Import a clip from your camera roll' : 'Write freely — this is your space'}
                </Text>
                {captureType === 'video' && (
                  <Pressable onPress={handlePickClip} style={styles.pickBtn}>
                    <Text style={styles.pickBtnText}>
                      {clipUri ? '✓ Clip selected' : 'Choose from camera roll'}
                    </Text>
                  </Pressable>
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
                  style={[styles.saveBtn, { backgroundColor: canSave() ? colors.teal : 'rgba(255,255,255,0.05)' }]}
                >
                  <Text style={[styles.saveBtnText, { color: canSave() ? colors.bg : colors.textDimmer }]}>SAVE ✓</Text>
                </Pressable>
              </View>
            )}

            {step === 'details' && captureType === 'habit' && (
              <View>
                <Text style={styles.subtitle}>💪 Log Habits</Text>
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
                        {checked && <Text style={styles.checkMark}>✓</Text>}
                        <Text style={styles.habitEmoji}>{h.emoji}</Text>
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
                  style={[styles.saveBtn, { backgroundColor: canSave() ? colors.teal : 'rgba(255,255,255,0.05)' }]}
                >
                  <Text style={[styles.saveBtnText, { color: canSave() ? colors.bg : colors.textDimmer }]}>SAVE HABITS ✓</Text>
                </Pressable>
              </View>
            )}

            {step === 'details' && captureType === 'moment' && (
              <View>
                <Text style={styles.subtitle}>📍 Log a Moment</Text>
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
                      <Text style={[styles.chipText, { color: mood === m.id ? m.color : colors.textMuted }]}>
                        {m.emoji} {m.label}
                      </Text>
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
                          backgroundColor: category === c.id ? `${colors.teal}15` : 'rgba(255,255,255,0.03)',
                          borderColor: category === c.id ? colors.teal : 'rgba(255,255,255,0.06)',
                        },
                      ]}
                    >
                      <Text style={[styles.chipText, { color: category === c.id ? colors.teal : colors.textMuted }]}>
                        {c.emoji} {c.label}
                      </Text>
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
                  style={[styles.saveBtn, { backgroundColor: canSave() ? colors.teal : 'rgba(255,255,255,0.05)' }]}
                >
                  <Text style={[styles.saveBtnText, { color: canSave() ? colors.bg : colors.textDimmer }]}>SAVE MOMENT ✓</Text>
                </Pressable>
              </View>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#111111',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 24,
    paddingBottom: 36,
    maxHeight: '85%',
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 20,
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
