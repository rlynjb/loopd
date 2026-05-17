// SyncableTable contract — every cloud-synced table implements this so the
// orchestrator can run push/pull generically. See docs/buffr-cloud-sync-spec.md
// §6.2.
//
// `TLocal` is the raw SQLite row shape (snake_case, JSON-stringified columns).
// `TCloud` is the Postgres row shape (snake_case, JSONB columns as objects,
// booleans as bool, ISO strings for TIMESTAMPTZ).
//
// M1 only uses the push half of this interface. Pull-side methods land in M2.

export interface SyncableTable<TLocal, TCloud> {
  /** Postgres + SQLite table name (must match). */
  readonly tableName: string;

  /** Order vs other tables for push (parents before children). Spec §4.4. */
  readonly pushOrder: number;

  /** Order vs other tables for pull (parents before children). Spec §4.4. */
  readonly pullOrder: number;

  /**
   * The column name(s) used as the cloud upsert conflict key, including
   * user_id. For most tables: ['user_id', 'id']. For day_meta + ai_summaries:
   * ['user_id', 'date']. For todo_meta: ['user_id', 'todo_id'].
   */
  readonly cloudConflictColumns: readonly string[];

  /** Extract the row's identity for local UPDATE WHERE clauses. */
  getId(row: TLocal): string;

  /** Local column name that holds the row's identity (matches getId). */
  readonly localIdColumn: string;

  /** TLocal → TCloud. Adds user_id, parses JSON columns, ISO timestamps. */
  localToCloud(row: TLocal, userId: string): TCloud;

  /** TCloud → TLocal. Stringifies JSONB columns, drops user_id. */
  cloudToLocal(row: TCloud): TLocal;

  /** Rows where updated_at > synced_at (or synced_at IS NULL). */
  localQueryDirty(): Promise<TLocal[]>;

  /** Stamp synced_at on a successful push. */
  localMarkSynced(id: string, syncedAt: string): Promise<void>;

  // ── Pull-side (M2 onward — stub or omit for M1) ──

  /** Upsert a cloud-pulled row into local SQLite. M2. */
  localUpsert?(row: TLocal): Promise<void>;

  /**
   * Paginated full-table fetch for first-pull (M4). Cursor is the last
   * created_at value (string) seen; null means start from oldest.
   */
  localPaginate?(cursor: string | null, limit: number): Promise<{
    rows: TLocal[];
    nextCursor: string | null;
  }>;
}

/** Result of a single-table push. Used for orchestrator-level reporting. */
export type PushResult = {
  tableName: string;
  attempted: number;
  succeeded: number;
  failed: number;
  error?: string;
};
