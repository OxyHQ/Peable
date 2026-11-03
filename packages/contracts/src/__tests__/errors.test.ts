import { describe, expect, it } from 'bun:test';
import {
  ERROR_CODE_DESCRIPTIONS,
  ERROR_CODES,
  ERROR_DOCS_BASE_URL,
  errorDocUrl,
  isErrorCode,
} from '../vocabulary/errors';

describe('the error vocabulary', () => {
  it("documents every code on Peable's error-code page on oxy.so", () => {
    // The page is packages/sdk/docs/errors.mdx, published by the Oxy website's
    // docs sync; the canonical URL ends in a slash and each code is a fragment.
    expect(ERROR_DOCS_BASE_URL).toBe('https://oxy.so/developers/docs/peable/errors/');
    expect(errorDocUrl('resource_missing')).toBe(
      'https://oxy.so/developers/docs/peable/errors/#resource_missing',
    );
  });

  it('derives the code list from the descriptions, sorted', () => {
    expect([...ERROR_CODES]).toEqual(Object.keys(ERROR_CODE_DESCRIPTIONS).sort());
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true);
      expect(ERROR_CODE_DESCRIPTIONS[code].length).toBeGreaterThan(0);
    }
    expect(isErrorCode('toString')).toBe(false);
  });
});
