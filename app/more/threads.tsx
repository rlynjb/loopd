import { useCallback, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, TextInput, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { colors, fonts, GLOBAL_NAV_HEIGHT } from '../../src/constants/theme';
import { Icon } from '../../src/components/ui/Icon';
import {
  listThreads, createThread, editThread,
  archiveThread, unarchiveThread, setThreadPinned, destroyThread,
} from '../../src/services/threads/crud';
import { slugify } from '../../src/services/habits/migrate';
import type { Thread } from '../../src/types/thread';
import type { TimeOfDay } from '../../src/types/entry';

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

type Editing = {
  thread: Thread;
  // Track the original slug to detect rename on save (informational only —
  // mention reconcile is lazy per plan decision #3).
  originalSlug: string;
  isNew: boolean;
};

export default function ThreadsScreen() {
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);

  const load = useCallback(async () => {
    const all = await listThreads(true);
    setThreads(all);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const visible = threads.filter(t => showArchived ? t.archived : !t.archived);

  const startCreate = () => {
    const now = new Date().toISOString();
    setEditing({
      thread: {
        id: 'pending', // replaced on save by createThread
        name: '',
        slug: '',
        icon: null,
        color: null,
        targetCadenceDays: null,
        archived: false,
        pinned: false,
        timeOfDay: 'anytime',
        createdAt: now,
        updatedAt: now,
      },
      originalSlug: '',
      isNew: true,
    });
  };

  const startEdit = (t: Thread) => {
    setEditing({ thread: t, originalSlug: t.slug, isNew: false });
  };

  const save = async () => {
    if (!editing) return;
    const t = editing.thread;
    const name = t.name.trim();
    if (!name) { Alert.alert('Thread needs a name'); return; }
    const slug = (t.slug.trim() || slugify(name));
    if (!slug) { Alert.alert('Could not derive a slug — try a plainer name'); return; }

    if (editing.isNew) {
      const result = await createThread({
        name,
        slug,
        icon: t.icon,
        color: t.color,
        targetCadenceDays: t.targetCadenceDays,
        pinned: t.pinned,
        timeOfDay: t.timeOfDay,
      });
      if (!result.ok) {
        if (result.error === 'slug-taken') {
          Alert.alert('Slug already exists', `A thread with slug "${slug}" already exists.`);
        } else {
          Alert.alert('Could not create thread');
        }
        return;
      }
    } else {
      const result = await editThread({ ...t, name, slug });
      if (!result.ok) {
        Alert.alert('Slug already exists', `A different thread already uses "${slug}".`);
        return;
      }
    }
    setEditing(null);
    await load();
  };

  const toggleArchive = async (t: Thread) => {
    if (t.archived) await unarchiveThread(t.id);
    else await archiveThread(t.id);
    await load();
  };

  const togglePin = async (t: Thread) => {
    await setThreadPinned(t.id, !t.pinned);
    await load();
  };

  const confirmDelete = (t: Thread) => {
    Alert.alert(
      'Delete thread?',
      `"${t.name}" will be permanently deleted along with all its mentions.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => { await destroyThread(t.id); await load(); },
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
        <Text style={styles.title}>Threads</Text>
        <Pressable onPress={startCreate} hitSlop={10}>
          <Icon name="plus" size={22} color={colors.accent} />
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <View style={styles.toggleRow}>
          <Pressable
            onPress={() => setShowArchived(false)}
            style={[styles.toggleChip, !showArchived && styles.toggleChipActive]}
          >
            <Text style={[styles.toggleText, !showArchived && styles.toggleTextActive]}>
              Active
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setShowArchived(true)}
            style={[styles.toggleChip, showArchived && styles.toggleChipActive]}
          >
            <Text style={[styles.toggleText, showArchived && styles.toggleTextActive]}>
              Archived
            </Text>
          </Pressable>
        </View>

        {visible.length === 0 && (
          <Text style={styles.emptyText}>
            {showArchived
              ? 'No archived threads.'
              : 'No threads yet. Tap + to create one, or type "#name" in a journal entry.'}
          </Text>
        )}

        {visible.map(t => (
          <Pressable key={t.id} onPress={() => startEdit(t)} style={styles.row}>
            <View style={styles.rowBody}>
              <View style={styles.rowNameLine}>
                {t.pinned && <Text style={styles.pinDot}>★</Text>}
                <Text style={styles.rowName}>{t.name}</Text>
              </View>
              <Text style={styles.rowMeta}>
                {timeOfDayLabel(t.timeOfDay)} · #{t.slug}
              </Text>
            </View>
            <Pressable onPress={() => togglePin(t)} hitSlop={6} style={styles.actionBtn}>
              <Text style={[styles.actionText, t.pinned && { color: colors.accent }]}>
                {t.pinned ? 'unpin' : 'pin'}
              </Text>
            </Pressable>
            <Pressable onPress={() => toggleArchive(t)} hitSlop={6} style={styles.actionBtn}>
              <Text style={styles.actionText}>
                {t.archived ? 'unarchive' : 'archive'}
              </Text>
            </Pressable>
            {t.archived && (
              <Pressable onPress={() => confirmDelete(t)} hitSlop={6} style={styles.actionBtn}>
                <Icon name="trash" size={14} color={colors.coral} />
              </Pressable>
            )}
          </Pressable>
        ))}
      </ScrollView>

      {editing && (
        <ThreadEditor
          editing={editing}
          onChange={e => setEditing(e)}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}
    </View>
  );
}

type EditorProps = {
  editing: Editing;
  onChange: (e: Editing) => void;
  onSave: () => void;
  onCancel: () => void;
};

function ThreadEditor({ editing, onChange, onSave, onCancel }: EditorProps) {
  const insets = useSafeAreaInsets();
  // Lift sheet above the persistent GlobalBottomNav + system gesture bar.
  const sheetBottomPad = GLOBAL_NAV_HEIGHT + insets.bottom;
  const t = editing.thread;
  const slugDirty = t.slug !== '' && t.slug !== slugify(t.name);
  const setName = (name: string) => {
    // If the user hasn't manually edited the slug, keep it in lockstep.
    onChange({
      ...editing,
      thread: {
        ...t,
        name,
        slug: slugDirty ? t.slug : slugify(name),
      },
    });
  };
  const setSlug = (slug: string) => onChange({
    ...editing,
    thread: { ...t, slug: slug.toLowerCase().replace(/[^a-z0-9-]/g, '') },
  });
  const setTarget = (raw: string) => {
    const n = parseInt(raw, 10);
    onChange({
      ...editing,
      thread: { ...t, targetCadenceDays: Number.isFinite(n) && n > 0 ? n : null },
    });
  };
  return (
    <View style={[editorStyles.overlay, { paddingBottom: sheetBottomPad }]}>
      <View style={editorStyles.sheet}>
        <View style={editorStyles.sheetHeader}>
          <Pressable onPress={onCancel} hitSlop={10}>
            <Text style={editorStyles.sheetCancel}>cancel</Text>
          </Pressable>
          <Text style={editorStyles.sheetTitle}>
            {editing.isNew ? 'New thread' : 'Edit thread'}
          </Text>
          <Pressable onPress={onSave} hitSlop={10}>
            <Text style={editorStyles.sheetSave}>save</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={editorStyles.body}>
          <Text style={editorStyles.label}>Name</Text>
          <TextInput
            value={t.name}
            onChangeText={setName}
            placeholder="e.g. buffr"
            placeholderTextColor={colors.textDim}
            style={editorStyles.input}
          />

          <Text style={editorStyles.label}>Slug</Text>
          <TextInput
            value={t.slug}
            onChangeText={setSlug}
            placeholder="auto from name"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            style={editorStyles.input}
          />
          <Text style={editorStyles.helper}>
            #{t.slug || 'slug'} — used to match #tag mentions in prose
          </Text>

          <Text style={editorStyles.label}>Time of day</Text>
          <View style={editorStyles.timeRow}>
            {TIME_OF_DAY_OPTIONS.map(opt => {
              const active = (t.timeOfDay ?? 'anytime') === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => onChange({ ...editing, thread: { ...t, timeOfDay: opt.value } })}
                  style={[editorStyles.timeChip, active && editorStyles.timeChipActive]}
                >
                  <Text style={[editorStyles.timeChipText, active && editorStyles.timeChipTextActive]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={editorStyles.label}>Target cadence (days)</Text>
          <TextInput
            value={t.targetCadenceDays != null ? String(t.targetCadenceDays) : ''}
            onChangeText={setTarget}
            placeholder="optional — e.g. 2 for every 2 days"
            placeholderTextColor={colors.textDim}
            keyboardType="number-pad"
            style={editorStyles.input}
          />
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
  toggleRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  toggleChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  },
  toggleChipActive: { backgroundColor: colors.bg3, borderColor: colors.accent2 },
  toggleText: { fontFamily: fonts.mono, fontSize: 11, color: colors.textDim },
  toggleTextActive: { color: colors.accent },
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
  rowNameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pinDot: { fontSize: 12, color: colors.accent },
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
  body: { padding: 20, gap: 4 },
  label: { fontFamily: fonts.mono, fontSize: 10, color: colors.textDim, marginTop: 14 },
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
    marginTop: 4,
  },
  helper: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    marginTop: 4,
  },
  timeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
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
