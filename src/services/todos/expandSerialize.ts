import type { TodoExpansion } from '../../types/todoMeta';

// Serializes the LLM's structured JSON into a compact markdown string we
// store in todo_meta.expanded_md. The renderer in ExpansionModal parses
// this lightweight markdown subset (## headers, - bullets, paragraphs).
export function serializeExpansion(expansion: TodoExpansion): string {
  switch (expansion.type) {
    case 'idea': {
      const d = expansion.data;
      return [
        h('What'), p(d.what),
        h('Why'), p(d.why),
        h('Conditions'), p(d.conditions),
        h('First Step'), p(d.firstStep),
      ].join('\n\n').trim();
    }
    case 'knowledge': {
      const d = expansion.data;
      return [
        h('Concept'), p(d.concept),
        h('Where Used'), p(d.whereUsed),
        h('Why It Matters'), p(d.whyItMatters),
        h('Example'), p(d.example),
      ].join('\n\n').trim();
    }
    case 'study': {
      const d = expansion.data;
      const parts = [
        h('Topic'), p(d.topic),
        h('Why Now'), p(d.whyNow),
      ];
      if (d.prerequisites.length > 0) parts.push(h('Prerequisites'), bullets(d.prerequisites));
      if (d.resources.length > 0) parts.push(h('Resources'), bullets(d.resources));
      parts.push(h('First Session'), p(d.firstSession));
      return parts.join('\n\n').trim();
    }
    case 'reflect': {
      const d = expansion.data;
      const parts = [
        h('Topic'), p(d.topic),
        h('Prompt'), p(d.prompt),
      ];
      if (d.earlyInsight) parts.push(h('Early Insight'), p(d.earlyInsight));
      if (d.openQuestions.length > 0) parts.push(h('Open Questions'), bullets(d.openQuestions));
      return parts.join('\n\n').trim();
    }
  }
}

function h(label: string): string { return `## ${label}`; }
function p(text: string): string { return text.trim(); }
function bullets(items: string[]): string {
  return items.map(i => `- ${i.trim()}`).join('\n');
}
