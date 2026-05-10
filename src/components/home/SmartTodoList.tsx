import { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable, TextInput, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts } from '../../constants/theme';
import { Icon } from '../ui/Icon';
import { formatRelativeTime } from '../../services/todos/rank';
import { updateTodo } from '../../services/todos/crud';
import { TypeBadge } from '../todos/TypeBadge';
import type { Entry, TodoItem } from '../../types/entry';
import type { TodoMeta } from '../../types/todoMeta';

const MAX_ROWS = 5;
// Recently-completed todos linger this long before disappearing from the
// dashboard — gives the user a beat to see "yes, the toggle worked."
const KEEP_DONE_MS = 2000;

type Props = {
  entries: Entry[];            // all entries (parent owns the query)
  today: string;               // YYYY-MM-DD
  onChanged: () => void;       // fired after any CRUD, so parent can reload entries
  // Per pushback #1 in the implementation plan: dashboard stays ranked.
  // Parent owns the meta lookup (hits the DB once per dashboard load) and
  // passes it down so each row can render its category badge.
  metas?: Map<string, TodoMeta>;
};

type DashboardTodo = TodoItem & {
  entryId: string;
  entryCreatedAt: string;
};

export function SmartTodoList({ entries, today: _today, onChanged, metas }: Props) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  // Sort matches /todos exactly (app/todos.tsx §8.2): NULL-position rows
  // first, ordered by createdAt DESC (newest at the top); then positioned
  // rows by position ASC. New captures land at the top of the dashboard
  // list the same way they do on the /todos page.
  const sorted = useMemo<DashboardTodo[]>(() => {
    const flat: DashboardTodo[] = [];
    for (const entry of entries) {
      for (const todo of entry.todos ?? []) {
        flat.push({ ...todo, entryId: entry.id, entryCreatedAt: entry.createdAt });
      }
    }
    // Drop long-completed items so the dashboard doesn't carry zombies.
    const now = Date.now();
    const filtered = flat.filter(t => {
      if (!t.done) return true;
      if (!t.completedAt) return true;
      return now - new Date(t.completedAt).getTime() <= KEEP_DONE_MS;
    });
    filtered.sort((a, b) => {
      const aPos = metas?.get(a.id)?.position ?? null;
      const bPos = metas?.get(b.id)?.position ?? null;
      if (aPos == null && bPos == null) {
        const aTime = new Date(a.createdAt ?? a.entryCreatedAt).getTime();
        const bTime = new Date(b.createdAt ?? b.entryCreatedAt).getTime();
        return bTime - aTime;
      }
      if (aPos == null) return -1;
      if (bPos == null) return 1;
      return aPos - bPos;
    });
    return filtered;
  }, [entries, metas]);

  // Top of the sorted list = newest captures + lowest-position user-ordered
  // rows. slice(0, N) — not slice(-N) — because the new sort puts the most
  // relevant items at the top, not the end.
  const visible = sorted.slice(0, MAX_ROWS);

  const handleToggle = useCallback(async (t: DashboardTodo) => {
    try {
      await updateTodo(t.entryId, t.id, { done: !t.done });
      onChanged();
    } catch (e) { console.warn('[todos] toggle failed:', e); }
  }, [onChanged]);

  const startEdit = useCallback((t: DashboardTodo) => {
    setEditingId(t.id);
    setEditText(t.text);
  }, []);

  const commitEdit = useCallback(async (t: DashboardTodo) => {
    const text = editText.trim();
    setEditingId(null);
    if (!text || text === t.text) return;
    try { await updateTodo(t.entryId, t.id, { text }); onChanged(); } catch (e) {
      console.warn('[todos] edit failed:', e);
    }
  }, [editText, onChanged]);

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Pressable onPress={() => router.push('/todos')} hitSlop={6}>
          <Text style={styles.label}>DROPS {sorted.length > 0 ? `(${sorted.length})` : ''}</Text>
        </Pressable>
        <Pressable onPress={() => router.push('/todos')} hitSlop={10} style={styles.linkBtn}>
          <Icon name="arrowRight" size={14} color={colors.accent} />
        </Pressable>
      </View>

      {visible.map(t => {
        const isEditing = editingId === t.id;
        const time = formatRelativeTime(t.createdAt ?? t.entryCreatedAt);
        return (
          <View key={t.id} style={styles.row}>
            <Pressable onPress={() => handleToggle(t)} hitSlop={10} style={styles.checkbox}>
              <View style={[styles.check, t.done && styles.checkOn]}>
                {t.done && <Icon name="checkSquare" size={14} color={colors.green} />}
              </View>
            </Pressable>
            <View style={styles.body}>
              {isEditing ? (
                <TextInput
                  value={editText}
                  onChangeText={setEditText}
                  onSubmitEditing={() => commitEdit(t)}
                  onBlur={() => commitEdit(t)}
                  autoFocus
                  returnKeyType="done"
                  style={[styles.text, styles.editInput]}
                />
              ) : (
                <Pressable onPress={() => startEdit(t)}>
                  <Text style={[styles.text, t.done && styles.textDone]} numberOfLines={2}>
                    {t.text}
                  </Text>
                </Pressable>
              )}
              <View style={styles.metaRow}>
                {metas?.get(t.id) && (
                  <TypeBadge
                    type={metas.get(t.id)!.type}
                    confidence={metas.get(t.id)!.classifierConfidence}
                  />
                )}
                <Text style={styles.meta}>{time}</Text>
              </View>
            </View>
          </View>
        );
      })}

    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  label: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.textDim,
    letterSpacing: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 8,
  },
  checkbox: {
    paddingTop: 2,
  },
  check: {
    width: 20,
    height: 20,
    borderWidth: 1.5,
    borderColor: colors.textDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: {
    borderColor: colors.green,
    backgroundColor: `${colors.green}12`,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  text: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.text,
    lineHeight: 20,
    padding: 0,
  },
  textDone: {
    color: colors.textDim,
    textDecorationLine: 'line-through',
  },
  editInput: {
    padding: 0,
    margin: 0,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  meta: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.textDim,
  },
  linkBtn: {
    padding: 4,
  },
});
