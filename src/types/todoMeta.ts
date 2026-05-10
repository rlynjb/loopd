// Phase A: meta row + heuristic. Phase B: LLM classifier. Phase C (this
// file's expansion shapes): per-type structured output that the user
// sees in the bottom-sheet expansion modal.

export type TodoType =
  | 'todo'
  | 'idea'
  | 'bug'
  | 'question'
  | 'decision'
  | 'knowledge'
  | 'content'
  | 'study';

export type ClassifierConfidence = 'high' | 'medium' | 'low' | 'heuristic';

// Lifecycle stage independent of `done` (which round-trips via the [] / [x]
// checkbox in prose) and `type` (the thinking-mode classification).
//   - 'todo'        → active, default
//   - 'in_progress' → currently being worked on
//   - 'backlog'     → de-prioritized but not abandoned
export type TodoStage = 'todo' | 'in_progress' | 'backlog';

// One row in `todo_meta` per TodoItem. Lifecycle invariant: every TodoItem
// in entries.todos_json has exactly one paired meta row, inserted/deleted
// in the same SQLite transaction by the scanner.
//
// Per the implementation plan §3.2, notionPageId stays on TodoItem only —
// no duplication here. Sync code joins TodoItem ↔ TodoMeta and uses the
// single id from the entries side.
export type TodoMeta = {
  todoId: string;
  entryId: string;
  entryDate: string;
  type: TodoType;
  stage: TodoStage;
  expandedMd: string | null;
  expandedAt: string | null;
  model: string | null;
  classifierConfidence: ClassifierConfidence | null;
  classifierModel: string | null;
  userOverriddenType: boolean;
  // User-set ordering. **Deprecated** as of 2026-05-05 — replaced by `pinned`.
  // The column stays on the schema and round-trips through sync; no UI
  // reads or writes it. New rows leave it NULL.
  position: number | null;
  // Pin flag (added 2026-05-05). Pinned rows float to the top of the /todos
  // list above the createdAt-DESC default sort. Toggled per-row from the
  // pin chip on each todo.
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

// ── Phase C: per-type expansion shapes (LLM JSON output) ──

export type IdeaExpansion = {
  what: string;
  why: string;
  conditions: string;
  firstStep: string;
};

export type BugExpansion = {
  observed: string;
  expected: string;
  suspectedCause: string;
  reproSteps: string[];
};

export type QuestionExpansion = {
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  followUps: string[];
  toVerify: string;
};

export type DecisionExpansion = {
  decision: string;
  reason: string;
  tradeoff: string;
  revisitWhen: string;
};

export type KnowledgeExpansion = {
  concept: string;
  whereUsed: string;
  whyItMatters: string;
  example: string;
};

export type ContentExpansion = {
  hook: string;
  keyPoints: string[];
  format: 'post' | 'video' | 'thread' | 'tutorial' | 'vlog';
  draftOutline: string;
};

// 'study' captures a learning *intention* — something the user wants to
// learn, distinct from `knowledge` (an insight already absorbed) and
// `idea` (an unproven possibility). The expansion gives the user a
// minimal study plan: what + why + prereqs + resources + first session.
export type StudyExpansion = {
  topic: string;
  whyNow: string;
  prerequisites: string[];
  resources: string[];
  firstSession: string;
};

// Discriminated union the orchestrator returns from a successful expansion
// before it's serialized to markdown. The type tag keeps the serializer
// switch type-safe.
export type TodoExpansion =
  | { type: 'idea';      data: IdeaExpansion }
  | { type: 'bug';       data: BugExpansion }
  | { type: 'question';  data: QuestionExpansion }
  | { type: 'decision';  data: DecisionExpansion }
  | { type: 'knowledge'; data: KnowledgeExpansion }
  | { type: 'content';   data: ContentExpansion }
  | { type: 'study';     data: StudyExpansion };

export type ExpandableType = Exclude<TodoType, 'todo'>;
