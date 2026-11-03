// The error-code catalogue, rendered from the contracts' error vocabulary —
// the same tables the gateway's `sendError` is typed against, so a code it can
// answer with is a code this page lists. Every error envelope's `doc_url`
// (`errorDocUrl(code)`) is this page with the code as its fragment, so each
// code's heading must slug to the code itself: the caller checks that.

import {
  ERROR_CODE_DESCRIPTIONS,
  ERROR_CODES,
  ERROR_TYPE_DESCRIPTIONS,
  ERROR_TYPES,
  errorDocUrl,
} from '../../packages/contracts/src/vocabulary/errors';
import { code, frontMatter, Headings, text } from './mdx';

/** The page's file under the docs root, and its link. */
export const ERRORS_FILE = 'errors.mdx';
export const ERRORS_LINK = '/errors';

export interface ErrorsPage {
  file: string;
  content: string;
  /** The anchor each type and each code renders with. */
  typeAnchors: Map<string, string>;
  codeAnchors: Map<string, string>;
}

export function errorsPage(): ErrorsPage {
  const headings = new Headings();
  const typeAnchors = new Map<string, string>();
  const codeAnchors = new Map<string, string>();
  const parts: string[] = [
    frontMatter({
      title: 'Error codes',
      description:
        'Every error type and error code the Peable API answers with, and what it means.',
      order: 899,
      generatedFrom: 'packages/contracts/src/vocabulary/errors.ts',
    }),
    headings.add(1, 'Error codes').markdown,
    `Every error Peable answers carries ${code('error.type')} — the broad class to branch on — and, when there is a more specific reason, ${code('error.code')}. ${code('error.doc_url')} links straight to that code below (${code(errorDocUrl('resource_missing'))}). How to read and handle an error, in the API and in the SDK, is in [handling errors](/handling-errors).`,
  ];
  parts.push(headings.add(2, 'Error types').markdown);
  for (const type of ERROR_TYPES) {
    const heading = headings.add(3, `Type ${code(type)}`);
    typeAnchors.set(type, heading.anchor);
    parts.push(heading.markdown, text(ERROR_TYPE_DESCRIPTIONS[type]));
  }
  parts.push(headings.add(2, 'All codes').markdown);
  parts.push(
    `${ERROR_CODES.length} codes, alphabetically. A ${code('card_error')} can also carry the card network's own decline code, which is not listed here.`,
  );
  for (const errorCode of ERROR_CODES) {
    const heading = headings.add(3, code(errorCode));
    codeAnchors.set(errorCode, heading.anchor);
    parts.push(heading.markdown, text(ERROR_CODE_DESCRIPTIONS[errorCode]));
  }
  return { file: ERRORS_FILE, content: `${parts.join('\n\n')}\n`, typeAnchors, codeAnchors };
}
