import { colors } from '../../constants/theme';
import type { IconName } from '../../components/ui/Icon';
import type { TodoType } from '../../types/todoMeta';

export type TodoTypeMeta = {
  type: TodoType;
  label: string;
  icon: IconName;
  color: string;
  order: number;        // display order in filter chip row + type-change picker
};

// Single source of truth for type presentation across /todos, the dashboard,
// the type-change picker, and (later) the expansion modal. Keep all UI reads
// going through here so a color/icon tweak is one edit.
export const TYPE_META: Record<TodoType, TodoTypeMeta> = {
  todo:      { type: 'todo',      label: 'Todo',      icon: 'checkSquare',   color: colors.textDim, order: 0 },
  idea:      { type: 'idea',      label: 'Idea',      icon: 'lightbulb',     color: colors.amber,   order: 1 },
  knowledge: { type: 'knowledge', label: 'Knowledge', icon: 'bookOpen',      color: colors.teal,    order: 2 },
  study:     { type: 'study',     label: 'Study',     icon: 'graduationCap', color: colors.accent,  order: 3 },
  reflect:   { type: 'reflect',   label: 'Reflect',   icon: 'eye',           color: colors.indigo,  order: 4 },
};

// Convenience: types in display order (excluding 'todo' if requested for
// places like the change-type picker that want non-todo first).
export const TYPES_IN_ORDER: TodoType[] =
  Object.values(TYPE_META).sort((a, b) => a.order - b.order).map(t => t.type);
