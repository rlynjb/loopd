import type { NotionPage, NotionQueryResponse } from '../../types/notion';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const RATE_LIMIT_DELAY = 350;

let lastRequestTime = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_DELAY) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY - elapsed));
  }
  lastRequestTime = Date.now();
}

async function notionFetch(
  token: string,
  endpoint: string,
  options: { method?: string; body?: unknown } = {}
): Promise<unknown> {
  await rateLimit();

  const res = await fetch(`${NOTION_API}${endpoint}`, {
    method: options.method ?? 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '1', 10);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return notionFetch(token, endpoint, options);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json();
}

// Query a database with optional filter, handling pagination
export async function queryDatabase(
  token: string,
  dbId: string,
  filter?: Record<string, unknown>,
  sorts?: Record<string, unknown>[],
): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const body: Record<string, unknown> = {};
    if (filter) body.filter = filter;
    if (sorts) body.sorts = sorts;
    if (cursor) body.start_cursor = cursor;
    body.page_size = 100;

    const data = await notionFetch(token, `/databases/${dbId}/query`, {
      method: 'POST',
      body,
    }) as NotionQueryResponse;

    pages.push(...data.results);
    hasMore = data.has_more;
    cursor = data.next_cursor ?? undefined;
  }

  return pages;
}

// Get a single database (for testing connection)
export async function getDatabase(token: string, dbId: string): Promise<unknown> {
  return notionFetch(token, `/databases/${dbId}`);
}

// Create a page in a database
export async function createPage(
  token: string,
  dbId: string,
  properties: Record<string, unknown>,
): Promise<NotionPage> {
  return notionFetch(token, '/pages', {
    method: 'POST',
    body: {
      parent: { database_id: dbId },
      properties,
    },
  }) as Promise<NotionPage>;
}

// Update a page's properties
export async function updatePage(
  token: string,
  pageId: string,
  properties: Record<string, unknown>,
): Promise<NotionPage> {
  return notionFetch(token, `/pages/${pageId}`, {
    method: 'PATCH',
    body: { properties },
  }) as Promise<NotionPage>;
}

// Archive a page (soft delete)
export async function archivePage(token: string, pageId: string): Promise<void> {
  await notionFetch(token, `/pages/${pageId}`, {
    method: 'PATCH',
    body: { archived: true },
  });
}
