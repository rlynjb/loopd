import { colors } from '../../constants/theme';
import type { IconName } from '../../components/ui/Icon';
import type { TodoStage } from '../../types/todoMeta';

export type TodoStageMeta = {
  stage: TodoStage;
  label: string;
  icon: IconName;
  color: string;
  order: number;
};

// Stage is the lifecycle dimension orthogonal to type and done. Defaults to
// 'todo'; user moves into 'in_progress' when actively working it and 'backlog'
// when de-prioritizing without finishing.
// Note on naming: the SQLite value for the default stage is 'todo' (set by
// the table's DEFAULT clause + CHECK constraint), but we surface it to the
// user as "Open" because that reads better in the filter row and avoids
// shouting "todo" twice on a row that already has a type badge. Keeping the
// internal value lets us skip a CHECK-constraint migration.
export const STAGE_META: Record<TodoStage, TodoStageMeta> = {
  todo:        { stage: 'todo',        label: 'Open',        icon: 'circle',     color: colors.textDim, order: 0 },
  in_progress: { stage: 'in_progress', label: 'In Progress', icon: 'play',       color: colors.amber,   order: 1 },
  backlog:     { stage: 'backlog',     label: 'Backlog',     icon: 'moon',       color: colors.textDimmer, order: 2 },
};

export const STAGES_IN_ORDER: TodoStage[] =
  Object.values(STAGE_META).sort((a, b) => a.order - b.order).map(s => s.stage);
