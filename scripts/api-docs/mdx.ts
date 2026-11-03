// Spelling a string from the contracts as MDX the Oxy docs site
// (oxy.so/developers/docs, built by OxyHQ/website) compiles as text.
//
// MDX reads `{…}` as a JavaScript expression and `<…` as JSX, so both are
// escaped outside code spans; inside a code span MDX takes everything
// literally. A GFM table splits its row on `|` before it parses code spans,
// so a cell escapes `|` everywhere.
//
// Anchors are what the site's `rehype-slug` gives a heading — `github-slugger`
// over the heading's text, with `-1`, `-2` for repeats on one page — so a link
// computed here lands on the heading the site renders.

import GithubSlugger from 'github-slugger';

const CODE_SPAN = /(`+)([\s\S]*?)\1/g;

function outsideCode(value: string, transform: (plain: string) => string): string {
  let out = '';
  let last = 0;
  for (const match of value.matchAll(CODE_SPAN)) {
    out += transform(value.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + transform(value.slice(last));
}

/** Prose for a paragraph or a heading. */
export function text(value: string): string {
  return outsideCode(value, (plain) =>
    plain
      .replace(/\\/g, '\\\\')
      .replace(/[{}]/g, (brace) => `\\${brace}`)
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;'),
  );
}

/** Prose for a table cell: one line, `|` escaped everywhere. */
export function cell(value: string): string {
  return text(value.replace(/\s*\n\s*/g, ' ')).replace(/\|/g, '\\|');
}

/** An inline code span that survives any content (backticks included). */
export function code(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** A Markdown table. Every cell must already be escaped with {@link cell}. */
export function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '';
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

/** A fenced block; the fence outgrows any backtick run inside. */
export function fence(language: string, body: string): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}${language}\n${body}\n${marks}`;
}

/** The text a heading renders, as `rehype-slug` reads it: code spans lose their backticks. */
function headingText(markdown: string): string {
  return markdown.replace(CODE_SPAN, (_m, _ticks, inner: string) => inner.trim());
}

/**
 * The headings of one page, in order. `add` returns the heading's Markdown and
 * the anchor the site will give it.
 */
export class Headings {
  private readonly slugger = new GithubSlugger();

  add(level: 1 | 2 | 3 | 4, title: string): { markdown: string; anchor: string } {
    const markdown = text(title);
    return {
      markdown: `${'#'.repeat(level)} ${markdown}`,
      anchor: this.slugger.slug(headingText(title)),
    };
  }
}

/**
 * The YAML front matter the site reads (`title`, `description`, `order`), and
 * `generated`, which names the source of a generated page. It lives here rather
 * than as an MDX comment in the body: the site's prerendered prose is the raw
 * body through a Markdown renderer, which would print the comment as text.
 */
export function frontMatter(fields: {
  title: string;
  description?: string;
  order: number;
  generatedFrom: string;
}): string {
  const quote = (value: string) => JSON.stringify(value.replace(/\s*\n\s*/g, ' '));
  return [
    '---',
    `title: ${quote(fields.title)}`,
    ...(fields.description ? [`description: ${quote(fields.description)}`] : []),
    `order: ${fields.order}`,
    `generated: ${quote(`by bun run generate:api-docs from ${fields.generatedFrom}; do not edit`)}`,
    '---',
  ].join('\n');
}
