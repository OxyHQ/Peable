// Every link between Peable's docs pages, checked against the pages and
// headings that exist. The docs site rewrites a root-relative link
// (`](/checkout#embedded-checkout)`) to the page of that slug in this package
// and leaves one to a slug it does not have as it is — a dead link on
// oxy.so — so this is where a renamed page or heading is caught.

import { Headings } from './mdx';

/** A page's slug as the site derives it: the path without `.mdx`, `index` at the root as ''. */
export function slugOf(file: string): string {
  const noExt = file.replace(/\.mdx?$/i, '');
  return noExt === 'index' ? '' : noExt;
}

function stripCode(source: string): string {
  return source.replace(/^(```|~~~)[\s\S]*?^\1/gm, '').replace(/(`+)[\s\S]*?\1/g, '');
}

/** The anchors of a page's Markdown headings, in order, as `rehype-slug` gives them. */
export function anchorsOf(source: string): Set<string> {
  const headings = new Headings();
  const anchors = new Set<string>();
  const body = source.replace(/^(```|~~~)[\s\S]*?^\1/gm, '');
  for (const match of body.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)) {
    const level = Math.min(4, match[1]?.length ?? 1) as 1 | 2 | 3 | 4;
    // Escapes are Markdown, not text: `\{` renders as `{`.
    const title = (match[2] ?? '')
      .replace(/\\([\\{}|])/g, '$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    anchors.add(headings.add(level, title).anchor);
  }
  return anchors;
}

/** Every dead internal link of a set of pages (`file → MDX`), as `file: target`. */
export function deadLinks(pages: ReadonlyMap<string, string>): string[] {
  const bySlug = new Map<string, Set<string>>();
  for (const [file, source] of pages) bySlug.set(slugOf(file), anchorsOf(source));
  const dead: string[] = [];
  for (const [file, source] of pages) {
    const own = bySlug.get(slugOf(file)) ?? new Set<string>();
    for (const match of stripCode(source).matchAll(/\]\((\/[^)\s#]*|)(#[^)\s]*)?\)/g)) {
      const target = match[1] ?? '';
      const anchor = match[2]?.slice(1);
      const slug = target.replace(/^\//, '').replace(/\/+$/, '');
      const anchors = target === '' ? own : bySlug.get(slug);
      if (!anchors) dead.push(`${file}: ${match[0].slice(1)} (no page '${slug}')`);
      else if (anchor && !anchors.has(decodeURIComponent(anchor)))
        dead.push(
          `${file}: ${match[0].slice(1)} (no heading '#${anchor}' on '${slug || 'index'}')`,
        );
    }
  }
  return dead;
}
