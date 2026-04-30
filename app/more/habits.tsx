import { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, TextInput, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';
import {
  getHabits,
  insertHabit,
  updateHabit,
  deleteHabit,
} from '../../src/services/database';
import type { Habit, CadenceType, TimeOfDay } from '../../src/types/entry';
import { summarizeCadence } from '../../src/services/habits/cadence';
import { slugify } from '../../src/services/habits/migrate';
import { generateId } from '../../src/utils/id';

const TIME_OF_DAY_OPTIONS: { value: TimeOfDay; label: string }[] = [
  { value: 'morning', label: 'Morning' },
  { value: 'midday', label: 'Midday' },
  { value: 'evening', label: 'Evening' },
  { value: 'anytime', label: 'Anytime' },
];

function timeOfDayLabel(t: TimeOfDay | undefined): string {
  switch (t ?? 'anytime') {
    case 'morning': return 'morning';
    case 'midday': return 'midday';
    case 'evening': return 'evening';
    default: return 'anytime';
  }
}

export default function HabitsScreen() {
  const router = useRouter();
  const [habits, setHabits] = useState<Habit[]>([]);
  const [editing, setEditing] = useState<Habit | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const all = await getHabits();
    setHabits(all);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const startCreate = () => {
    setEditing({
      id: generateId('habit'),
      label: '',
      sortOrder: habits.length,
      slug: '',
      cadenceType: 'daily',
      cadenceDays: null,
      cadenceCount: null,
      timeOfDay: 'anytime',
    });
    setCreating(true);
  };

  const startEdit = (h: Habit) => {
    setEditing(h);
    setCreating(false);
  };

  const saveEdit = async (h: Habit) => {
    if (!h.label.trim()) {
      Alert.alert('Habit needs a name');
      return;
    }
    const slug = h.slug?.trim() || slugify(h.label);
    const toWrite: Habit = { ...h, slug };
    if (creating) {
      await insertHabit(toWrite);
    } else {
      await updateHabit(toWrite);
    }
    setEditing(null);
    setCreating(false);
    await load();
  };

  const confirmDelete = (h: Habit) => {
    Alert.alert(
      'Delete habit?',
      `"${h.label}" will be permanently deleted. Past check-ins on entries are preserved.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteHabit(h.id);
            await load();
          },
        },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10}>
          <Icon name="chevronLeft" size={22} color={colors.textMuted} />
        </Pressable>
        <Text style={styles.title}>Habits</Text>
        <Pressable onPress={startCreate} hitSlop={10}>
          <Icon name="plus" size={22} color={colors.accent} />
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {habits.length === 0 && (
          <Text style={styles.emptyText}>No habits yet. Tap + to create one.</Text>
        )}

        {habits.map(h => (
          <Pressable key={h.id} onPress={() => startEdit(h)} style={styles.row}>
            <View style={styles.rowBody}>
              <Text style={styles.rowName}>{h.label}</Text>
              <Text style={styles.rowMeta}>
                {timeOfDayLabel(h.timeOfDay)} · {summarizeCadence(h)}
              </Text>
            </View>
            <Pressable
              onPress={() => confirmDelete(h)}
              hitSlop={6}
              style={styles.actionBtn}
            >
              <Icon name="trash" size={14} color={colors.coral} />
            </Pressable>
          </Pressable>
        ))}
      </ScrollView>

      {editing && (
        <HabitEditor
          habit={editing}
          onChange={setEditing}
          onSave={() => saveEdit(editing)}
          onCancel={() => { setEditing(null); setCreating(false); }}
          creating={creating}
        />
      )}
    </View>
  );
}

const CADENCE_OPTIONS: { type: CadenceType; label: string }[] = [
  { type: 'daily', label: 'Daily' },
  { type: 'weekdays', label: 'Weekdays' },
  { type: 'weekly', label: 'Weekly' },
  { type: 'specific_days', label: 'Specific days' },
  { type: 'n_per_week', label: 'N times per week' },
];

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; // 0=Sun ... 6=Sat

type HabitEditorProps = {
  habit: Habit;
  onChange: (h: Habit) => void;
  onSave: () => void;
  onCancel: () => void;
  creating: boolean;
};

function HabitEditor({ habit, onChange, onSave, onCancel, creating }: HabitEditorProps) {
  const insets = useSafeAreaInsets();
  // Lift the sheet above the persistent GlobalBottomNav (root-rendered, sits
  // on top of screen content) plus the system gesture bar at the bottom.
  // Without this padding, the form's last fields get covered.
  const sheetBottomPad = GLOBAL_NAV_HEIGHT + insets.bottom;
  const cadence = habit.cadenceType ?? 'daily';
  const days = habit.cadenceDays ?? [];

  const setCadenceType = (t: CadenceType) => {
    onChange({
      ...habit,
      cadenceType: t,
      cadenceDays: t === 'specific_days' ? (days.length ? days : [1, 3, 5])
                : t === 'weekly' ? [days[0] ?? 0]
                : null,
      cadenceCount: t === 'n_per_week' ? (habit.cadenceCount ?? 3) : null,
    });
  };

  const toggleDay = (d: number) => {
    if (cadence === 'weekly') {
      onChange({ ...habit, cadenceDays: [d] });
      return;
    }
    if (cadence === 'specific_days') {
      const next = days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort();
      onChange({ ...habit, cadenceDays: next });
    }
  };

  return (
    <View style={[editorStyles.overlay, { paddingBottom: sheetBottomPad }]}>
      <View style={editorStyles.sheet}>
        <View style={editorStyles.sheetHeader}>
          <Pressable onPress={onCancel} hitSlop={10}>
            <Text style={editorStyles.sheetCancel}>cancel</Text>
          </Pressable>
          <Text style={editorStyles.sheetTitle}>
            {creating ? 'New habit' : 'Edit habit'}
          </Text>
          <Pressable onPress={onSave} hitSlop={10}>
            <Text style={editorStyles.sheetSave}>save</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={editorStyles.body}>
          <Text style={editorStyles.label}>Name</Text>
          <TextInput
            value={habit.label}
            onChangeText={t => onChange({ ...habit, label: t })}
            placeholder="e.g. Pull-ups"
            placeholderTextColor={colors.textDim}
            style={editorStyles.input}
          />

          <Text style={editorStyles.label}>Time of day</Text>
          <View style={editorStyles.timeRow}>
            {TIME_OF_DAY_OPTIONS.map(opt => {
              const active = (habit.timeOfDay ?? 'anytime') === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => onChange({ ...habit, timeOfDay: opt.value })}
                  style={[editorStyles.timeChip, active && editorStyles.timeChipActive]}
                >
                  <Text style={[editorStyles.timeChipText, active && editorStyles.timeChipTextActive]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={editorStyles.label}>Cadence</Text>
          <View style={editorStyles.cadenceList}>
            {CADENCE_OPTIONS.map(opt => (
              <Pressable
                key={opt.type}
                onPress={() => setCadenceType(opt.type)}
                style={[
                  editorStyles.cadenceRow,
                  cadence === opt.type && editorStyles.cadenceRowActive,
                ]}
              >
                <Text
                  style={[
                    editorStyles.cadenceText,
                    cadence === opt.type && editorStyles.cadenceTextActive,
                  ]}
                >
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {(cadence === 'weekly' || cadence === 'specific_days') && (
            <>
              <Text style={editorStyles.label}>
                {cadence === 'weekly' ? 'Day of the week' : 'Days'}
              </Text>
              <View style={editorStyles.dayRow}>
                {DAY_LABELS.map((lbl, i) => {
                  const active = days.includes(i);
                  return (
                    <Pressable
                      key={i}
                      onPress={() => toggleDay(i)}
                      style={[editorStyles.dayBtn, active && editorStyles.dayBtnActive]}
                    >
                      <Text style={[editorStyles.dayText, active && editorStyles.dayTextActive]}>
                        {lbl}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}

          {cadence === 'n_per_week' && (
            <>
              <Text style={editorStyles.label}>Times per week</Text>
              <View style={editorStyles.dayRow}>
                {[1, 2, 3, 4, 5, 6, 7].map(n => {
                  const active = (habit.cadenceCount ?? 0) === n;
                  return (
                    <Pressable
                      key={n}
                      onPress={() => onChange({ ...habit, cadenceCount: n })}
                      style={[editorStyles.dayBtn, active && editorStyles.dayBtnActive]}
                    >
                      <Text style={[editorStyles.dayText, active && editorStyles.dayTextActive]}>
                        {n}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingTop: 56,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontFamily: fonts.heading, fontSize: 18, color: colors.text },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: GLOBAL_NAV_HEIGHT + 40,
    paddingTop: 12,
  },
  emptyText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.textDim,
    paddingVertical: 40,
    textAlign: 'center',
    lineHeight: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
    gap: 8,
  },
  rowBody: { flex: 1, gap: 2 },
  rowName: { fontFamily: fonts.body, fontSize: 14, color: colors.text },
  rowMeta: { fontFamily: fonts.mono, fontSize: 10, color: colors.textDim },
  actionBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  actionText: { fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted },
});

const editorStyles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '85%',
    minHeight: '50%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  },
  sheetCancel: { fontFamily: fonts.mono, fontSize: 12, color: colors.textDim },
  sheetSave: { fontFamily: fonts.mono, fontSize: 12, color: colors.accent },
  sheetTitle: { fontFamily: fonts.heading, fontSize: 16, color: colors.text },
  body: { padding: 20, gap: 12 },
  label: { fontFamily: fonts.mono, fontSize: 10, color: colors.textDim, marginTop: 8 },
  input: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.bg2,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  cadenceList: { gap: 6 },
  cadenceRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  cadenceRowActive: {
    backgroundColor: colors.bg3,
    borderColor: colors.accent2,
  },
  cadenceText: { fontFamily: fonts.body, fontSize: 13, color: colors.textMuted },
  cadenceTextActive: { color: colors.accent },
  dayRow: { flexDirection: 'row', gap: 6 },
  dayBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayBtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  dayText: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
  dayTextActive: { color: colors.bg },
  timeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  timeChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  timeChipActive: { backgroundColor: colors.bg3, borderColor: colors.accent2 },
  timeChipText: { fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted },
  timeChipTextActive: { color: colors.accent },
});
