export interface KnowledgeSection {
  heading: string;
  content: string;
}

export interface ParsedDocument {
  title: string;
  sections: KnowledgeSection[];
}

const MAX_CHUNK_CHARS = 1_500;

/** Removes owner-only notes: HTML comments and `> OWNER ...` quote lines. */
export function stripOwnerNotes(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => !/^\s*>\s*OWNER\b/i.test(line))
    .join('\n');
}

/**
 * Splits Markdown into passages: the first `# ` line is the title, every `## ` starts a section,
 * and sections longer than MAX_CHUNK_CHARS are split on blank lines.
 */
export function parseMarkdown(markdown: string, fallbackTitle: string): ParsedDocument {
  const lines = stripOwnerNotes(markdown).replace(/\r\n/g, '\n').split('\n');
  let title = fallbackTitle;
  let heading = fallbackTitle;
  let buffer: string[] = [];
  const raw: KnowledgeSection[] = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content) raw.push({ heading, content });
    buffer = [];
  };

  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^#{2,3}\s+(.+)$/.exec(line);
    if (h1 && title === fallbackTitle && raw.length === 0 && buffer.join('').trim() === '') {
      title = h1[1]!.trim();
      heading = title;
    } else if (h2) {
      flush();
      heading = h2[1]!.trim();
    } else {
      buffer.push(line);
    }
  }
  flush();

  return { title, sections: raw.flatMap(splitLongSection) };
}

/** Splits plain text (e.g. one PDF page) into passages under a fixed heading. */
export function sectionsFromText(text: string, heading: string): KnowledgeSection[] {
  const content = text.replace(/\r\n/g, '\n').trim();
  return content ? splitLongSection({ heading, content }) : [];
}

function splitLongSection(section: KnowledgeSection): KnowledgeSection[] {
  if (section.content.length <= MAX_CHUNK_CHARS) return [section];
  const parts: string[] = [];
  let current = '';
  for (const paragraph of section.content.split(/\n\s*\n/)) {
    const pieces = paragraph.length > MAX_CHUNK_CHARS ? hardSplit(paragraph) : [paragraph];
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > MAX_CHUNK_CHARS) {
        parts.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) parts.push(current);
  return parts.map((content) => ({ heading: section.heading, content: content.trim() }));
}

function hardSplit(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS) out.push(text.slice(i, i + MAX_CHUNK_CHARS));
  return out;
}
