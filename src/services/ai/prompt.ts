import type { Entry } from '../../types/entry';
import type { ClipItem } from '../../types/project';

const SYSTEM = `You are composing a daily vlog summary for a personal journal app called loopd. Given the user's journal entries, habits, todos, and video clip metadata for one day, produce a structured JSON response that will be used to auto-compose a short-form vertical vlog.

Tone: casual and conversational, not formal or corporate. Use lowercase where natural. Keep idiomatic expressions minimal — be direct and simple. Stick strictly to what happened in the entries. Do not add filler phrases, forward-looking statements, or commentary beyond what the data says. Keep wording minimal — prefer the user's own words from their journal entries over paraphrasing.

Rules:
- clipOrder must only reference clip IDs from the provided clips list
- clipTrims startMs and endMs must be within each clip's duration (0 to durationMs)
- textOverlays max 4 items, keep text concise (under 60 chars each)
- filterPreset must be one of: none, moody, cool, film, muted
- mood must be one of: flat, ok, good, great, fired
- headline should be 3-8 words, casual vibe
- summary should be as many sentences as needed to capture the day — could be 1, could be 5, depends on the entries

Respond with ONLY valid JSON matching this exact shape:
{
  "headline": string,
  "summary": string,
  "mood": "flat" | "ok" | "good" | "great" | "fired",
  "clipOrder": string[],
  "clipTrims": [{ "id": string, "startMs": number, "endMs": number }],
  "textOverlays": [{ "text": string, "startPct": number, "endPct": number, "position": "top" | "center" | "bottom" }],
  "filterPreset": "none" | "moody" | "cool" | "film" | "muted",
  "generatedAt": string
}`;

export function buildPrompt(entries: Entry[], clips: { id: string; entryId: string; durationMs: number }[], habits: string[], date: string): { system: string; user: string } {
  const entryLines = entries.map(e => {
    const parts: string[] = [];
    if (e.text) parts.push(`Text: "${e.text}"`);
    if (e.habits.length > 0) parts.push(`Habits: ${e.habits.join(', ')}`);
    if (e.todos.length > 0) {
      const done = e.todos.filter(t => t.done).map(t => t.text);
      const open = e.todos.filter(t => !t.done).map(t => t.text);
      if (done.length) parts.push(`Done: ${done.join(', ')}`);
      if (open.length) parts.push(`Open: ${open.join(', ')}`);
    }
    return `[${e.createdAt}] ${parts.join(' | ')}`;
  }).join('\n');

  const clipLines = clips.map(c =>
    `Clip ${c.id}: entryId=${c.entryId}, duration=${c.durationMs}ms`
  ).join('\n');

  const user = `Date: ${date}
Habits checked today: ${habits.length > 0 ? habits.join(', ') : 'none'}

Entries:
${entryLines || 'No text entries'}

Clips:
${clipLines || 'No clips'}

Generate the vlog summary JSON.`;

  return { system: SYSTEM, user };
}
