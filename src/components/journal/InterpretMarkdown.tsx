import { Fragment } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, fonts } from '../../constants/theme';

// Focused markdown renderer for the Interpret modal output. Handles only
// the patterns the AI actually emits per services/ai/interpret.ts:
//
//   - `## Heading` and `### Heading` (emoji-prefixed are common; just text)
//   - `> blockquote` (single or stacked across consecutive lines)
//   - `- item` and `* item` (bullet list)
//   - `1. item` (ordered list)
//   - `---` (horizontal rule)
//   - `**bold**` inline emphasis (within paragraphs / bullets / blockquotes)
//   - blank lines = paragraph break
//
// Intentionally does NOT support: links, images, code blocks, tables,
// nested lists. The AI prompt forbids those for this surface.

type Block =
  | { kind: 'h2'; text: string }
  | { kind: 'h3'; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'hr' }
  | { kind: 'p'; text: string };

function parse(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    if (/^---+$/.test(trimmed)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    if (trimmed.startsWith('### ')) {
      blocks.push({ kind: 'h3', text: trimmed.slice(4).trim() });
      i++;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      blocks.push({ kind: 'h2', text: trimmed.slice(3).trim() });
      i++;
      continue;
    }
    if (trimmed.startsWith('# ')) {
      blocks.push({ kind: 'h2', text: trimmed.slice(2).trim() });
      i++;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t.startsWith('>')) {
          quoteLines.push(t.replace(/^>\s?/, ''));
          i++;
        } else if (!t) {
          // blank line ends the quote block
          break;
        } else {
          break;
        }
      }
      blocks.push({ kind: 'quote', lines: quoteLines });
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (/^[-*]\s+/.test(t)) {
          items.push(t.replace(/^[-*]\s+/, ''));
          i++;
        } else if (!t) {
          break;
        } else {
          break;
        }
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        if (/^\d+\.\s+/.test(t)) {
          items.push(t.replace(/^\d+\.\s+/, ''));
          i++;
        } else if (!t) {
          break;
        } else {
          break;
        }
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    // Paragraph — gather consecutive non-blank, non-special lines.
    const paraLines: string[] = [trimmed];
    i++;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t) break;
      if (
        t.startsWith('#') || t.startsWith('>') || /^---+$/.test(t)
        || /^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t)
      ) break;
      paraLines.push(t);
      i++;
    }
    blocks.push({ kind: 'p', text: paraLines.join(' ') });
  }

  return blocks;
}

// Splits inline `**bold**` segments. Returns a list of {bold, text} runs
// suitable for rendering inside a single Text element via nested Text.
function splitBold(input: string): { bold: boolean; text: string }[] {
  const out: { bold: boolean; text: string }[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    if (m.index > last) out.push({ bold: false, text: input.slice(last, m.index) });
    out.push({ bold: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < input.length) out.push({ bold: false, text: input.slice(last) });
  return out.length > 0 ? out : [{ bold: false, text: input }];
}

function Inline({ text, style, boldStyle }: { text: string; style: any; boldStyle?: any }) {
  const runs = splitBold(text);
  return (
    <Text style={style} selectable>
      {runs.map((r, i) => (
        <Text key={i} style={r.bold ? [style, boldStyle ?? styles.bold] : style} selectable>
          {r.text}
        </Text>
      ))}
    </Text>
  );
}

export function InterpretMarkdown({ markdown }: { markdown: string }) {
  const blocks = parse(markdown);
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h2':
            return <Inline key={i} text={b.text} style={styles.h2} />;
          case 'h3':
            return <Inline key={i} text={b.text} style={styles.h3} />;
          case 'hr':
            return <View key={i} style={styles.hr} />;
          case 'quote':
            return (
              <View key={i} style={styles.quote}>
                {b.lines.map((line, j) => (
                  <Inline
                    key={j}
                    text={line}
                    style={styles.quoteText}
                    boldStyle={styles.quoteBold}
                  />
                ))}
              </View>
            );
          case 'ul':
            return (
              <View key={i} style={styles.list}>
                {b.items.map((it, j) => (
                  <View key={j} style={styles.listItem}>
                    <Text style={styles.bullet} selectable>•</Text>
                    <Inline text={it} style={styles.listText} />
                  </View>
                ))}
              </View>
            );
          case 'ol':
            return (
              <View key={i} style={styles.list}>
                {b.items.map((it, j) => (
                  <View key={j} style={styles.listItem}>
                    <Text style={styles.bullet} selectable>{j + 1}.</Text>
                    <Inline text={it} style={styles.listText} />
                  </View>
                ))}
              </View>
            );
          case 'p':
            return <Inline key={i} text={b.text} style={styles.p} />;
          default:
            return <Fragment key={i} />;
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 14,
  },
  p: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 22,
    color: colors.text,
  },
  bold: {
    fontFamily: fonts.body,
    fontWeight: '700',
    color: colors.text,
  },
  h2: {
    fontFamily: fonts.heading,
    fontSize: 18,
    lineHeight: 24,
    color: colors.text,
    letterSpacing: -0.2,
    marginTop: 8,
  },
  h3: {
    fontFamily: fonts.heading,
    fontSize: 15,
    lineHeight: 22,
    color: colors.accent,
    letterSpacing: -0.1,
    marginTop: 4,
  },
  hr: {
    height: 1,
    backgroundColor: colors.cardBorder,
    marginVertical: 4,
  },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.accent,
    paddingLeft: 12,
    paddingVertical: 4,
    gap: 4,
  },
  quoteText: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 21,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  quoteBold: {
    fontFamily: fonts.body,
    fontSize: 14,
    fontWeight: '700',
    fontStyle: 'italic',
    color: colors.text,
  },
  list: {
    gap: 4,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  bullet: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 22,
    color: colors.textDim,
    minWidth: 16,
  },
  listText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 22,
    color: colors.text,
  },
});
