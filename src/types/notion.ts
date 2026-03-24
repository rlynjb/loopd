export type NotionPage = {
  id: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  properties: Record<string, NotionProperty>;
};

export type NotionProperty =
  | { type: 'title'; title: { plain_text: string }[] }
  | { type: 'rich_text'; rich_text: { plain_text: string }[] }
  | { type: 'date'; date: { start: string; end?: string | null } | null }
  | { type: 'select'; select: { name: string } | null }
  | { type: 'multi_select'; multi_select: { name: string }[] }
  | { type: 'checkbox'; checkbox: boolean }
  | { type: 'number'; number: number | null }
  | { type: 'relation'; relation: { id: string }[] }
  | { type: 'url'; url: string | null }
  | { type: string; [key: string]: unknown };

export type NotionQueryResponse = {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
};

export type SyncResult = {
  pulled: number;
  pushed: number;
  errors: string[];
};

export type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';
