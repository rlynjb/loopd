export function generateId(prefix = ''): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return prefix ? `${prefix}-${ts}-${rand}` : `${ts}-${rand}`;
}
