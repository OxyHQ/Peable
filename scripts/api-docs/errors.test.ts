import { describe, expect, it } from 'bun:test';
import {
  ERROR_CODES,
  ERROR_DOCS_BASE_URL,
  ERROR_TYPES,
  errorDocUrl,
} from '../../packages/contracts/src/vocabulary/errors';
import { errorsPage } from './errors';
import { anchorsOf, deadLinks } from './links';

describe('the error-code page', () => {
  const page = errorsPage();
  const rendered = anchorsOf(page.content);

  it('is the page every doc_url points at', () => {
    expect(ERROR_DOCS_BASE_URL).toBe('https://oxy.so/developers/docs/peable/errors/');
    expect(page.file).toBe('errors.mdx');
  });

  it('anchors every error code at the code itself', () => {
    for (const code of ERROR_CODES) {
      expect(page.codeAnchors.get(code)).toBe(code);
      expect(rendered.has(code)).toBe(true);
      expect(new URL(errorDocUrl(code)).hash).toBe(`#${code}`);
    }
  });

  it('anchors every error type apart from the codes, though a type and a code share a name', () => {
    const codes = new Set<string>(ERROR_CODES);
    for (const type of ERROR_TYPES) {
      const anchor = page.typeAnchors.get(type) ?? '';
      expect(anchor).toBe(`type-${type}`);
      expect(codes.has(anchor)).toBe(false);
    }
  });

  it('links only to the guide it names', () => {
    const pages = new Map([
      ['errors.mdx', page.content],
      ['handling-errors.mdx', '# Handling errors\n'],
    ]);
    expect(deadLinks(pages)).toEqual([]);
  });
});
