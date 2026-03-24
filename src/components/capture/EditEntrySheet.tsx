import { useState, useEffect } from 'react';
import { View, Text, Pressable, TextInput, Modal, ScrollView, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';
import { MOODS } from '../../constants/moods';
import { CATEGORIES } from '../../constants/categories';
import { Icon } from '../ui/Icon';
import type { Entry, Habit } from '../../types/entry';

type Props = {
  entry: Entry | null;
  habits: Habit[];
  onClose: () => void;
  onSave: (entry: Entry) => void;
  onDelete: (id: string) => void;
};

export function EditEntrySheet({ entry, habits, onClose, onSave, onDelete }: Props) {
  const [text, setText] = useState('');
  const [mood, setMood] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [selectedHabits, setSelectedHabits] = useState<string[]>([]);

  useEffect(() => {
    if (entry) {
      setText(entry.text ?? '');
      setMood(entry.mood);
      setCategory(entry.category);
      setSelectedHabits(entry.habits);
    }
  }, [entry]);

  if (!entry) return null;

  const isHabit = entry.type === 'habit';
  const isMoment = entry.type === 'moment';

  const toggleHabit = (id: string) => {
    setSelectedHabits(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleSave = () => {
    onSave({
      ...entry,
      text: text.trim() || null,
      mood: isMoment ? mood : entry.mood,
      category: isMoment ? category : entry.category,
      habits: isHabit ? selectedHabits : entry.habits,
    });
  };

  const handleDelete = () => {
    onDelete(entry.id);
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
          <Text style={styles.typeLabel}>
            {entry.type === 'video' ? 'Clip' : entry.type === 'journal' ? 'Journal' : isHabit ? 'Habit' : 'Moment'}
          </Text>

          {/* Text field — for all types */}
          <Text style={styles.fieldLabel}>
            {isHabit ? 'NOTE' : entry.type === 'video' ? 'CAPTION' : 'TEXT'}
          </Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={isHabit ? 'Optional note...' : 'Write something...'}
            placeholderTextColor={colors.textDimmer}
            multiline
            autoFocus
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

          {/* Mood — for moment type */}
          {isMoment && (
            <>
              <Text style={styles.fieldLabel}>MOOD</Text>
              <View style={styles.chipRow}>
                {MOODS.map(m => (
                  <Pressable
                    key={m.id}
                    onPress={() => setMood(m.id)}
                    style={[
                      styles.moodChip,
                      {
                        backgroundColor: mood === m.id ? `${m.color}15` : colors.bg3,
                        borderColor: mood === m.id ? m.color : colors.cardBorder,
                      },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: mood === m.id ? m.color : colors.textMuted }]}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Icon name={m.icon} size={14} color={mood === m.id ? m.color : colors.textMuted} /><Text style={[styles.chipText, { color: mood === m.id ? m.color : colors.textMuted }]}>{m.label}</Text></View>
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          {/* Category — for moment type */}
          {isMoment && (
            <>
              <Text style={styles.fieldLabel}>CATEGORY</Text>
              <View style={styles.chipRow}>
                {CATEGORIES.map(c => (
                  <Pressable
                    key={c.id}
                    onPress={() => setCategory(c.id)}
                    style={[
                      styles.moodChip,
                      {
                        backgroundColor: category === c.id ? `${colors.accent2}15` : colors.bg3,
                        borderColor: category === c.id ? colors.accent2 : colors.cardBorder,
                      },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: category === c.id ? colors.accent2 : colors.textMuted }]}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Icon name={c.icon} size={14} color={category === c.id ? colors.accent2 : colors.textMuted} /><Text style={[styles.chipText, { color: category === c.id ? colors.accent2 : colors.textMuted }]}>{c.label}</Text></View>
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          {/* Clip info — read-only for video type */}
          {entry.type === 'video' && entry.clipUri && (
            <View style={styles.clipInfo}>
              <Text style={styles.fieldLabel}>CLIP FILE</Text>
              <Text style={styles.clipPath} numberOfLines={1}>{entry.clipUri.split('/').pop()}</Text>
            </View>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable onPress={handleDelete} style={styles.deleteBtn}>
            <Text style={styles.deleteBtnText}>Delete</Text>
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
  typeLabel: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.text,
    marginBottom: 20,
  },
  fieldLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
    marginBottom: 8,
    marginTop: 16,
  },
  textArea: {
    backgroundColor: colors.bg3,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: colors.radius,
    padding: 14,
    color: colors.text,
    fontSize: 15,
    fontFamily: fonts.body,
    minHeight: 120,
    textAlignVertical: 'top',
    lineHeight: 22,
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
  checkMark: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.purple,
  },
  habitEmoji: {
    fontSize: 14,
  },
  habitLabel: {
    fontFamily: fonts.body,
    fontSize: 13,
  },
  moodChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  chipText: {
    fontFamily: fonts.body,
    fontSize: 13,
  },
  clipInfo: {
    marginTop: 8,
  },
  clipPath: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.textDim,
    backgroundColor: colors.bg3,
    padding: 10,
    borderRadius: 8,
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
    paddingVertical: 14,
    paddingHorizontal: 20,
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
