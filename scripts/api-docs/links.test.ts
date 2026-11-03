import { describe, expect, it } from 'bun:test';
import { anchorsOf, deadLinks, slugOf } from './links';

describe('dead links between docs pages', () => {
  const pages = new Map([
    [
      'index.mdx',
      '# Peable\n\nSee [checkout](/checkout#embedded-checkout) and [codes](/errors#resource_missing).',
    ],
    [
      'checkout.mdx',
      '# Checkout\n\n## Embedded checkout\n\nBack [home](/) or [up](#checkout).\n\n```ts\nconst a = "](/nowhere)";\n```',
    ],
    ['errors.mdx', '# Error codes\n\n### `resource_missing`\n'],
  ]);

  it('accepts links to pages and headings that exist, ignoring code', () => {
    expect(deadLinks(pages)).toEqual([]);
  });

  it('reports a missing page and a missing heading', () => {
    const broken = new Map(pages);
    broken.set('tax.mdx', '# Tax\n\n[a](/billing) [b](/checkout#hosted-checkout)');
    expect(deadLinks(broken)).toEqual([
      "tax.mdx: (/billing) (no page 'billing')",
      "tax.mdx: (/checkout#hosted-checkout) (no heading '#hosted-checkout' on 'checkout')",
    ]);
  });

  it('slugs files and headings the way the docs site does', () => {
    expect(slugOf('index.mdx')).toBe('');
    expect(slugOf('reference/objects/customer.mdx')).toBe('reference/objects/customer');
    expect([
      ...anchorsOf('## 4. Take a payment\n\n## Take a payment\n\n## `peable listen`'),
    ]).toEqual(['4-take-a-payment', 'take-a-payment', 'peable-listen']);
  });
});
