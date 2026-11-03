import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deadLinks } from './links';
import {
  allEntries,
  type OpenApiDocument,
  objectSlug,
  referencePages,
  tagGroups,
  tagSlug,
  WEBHOOK_TAG,
} from './openapi';

const committed = JSON.parse(
  readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8'),
) as OpenApiDocument;

function byFile(pages: { file: string; content: string }[]): Map<string, string> {
  return new Map(pages.map((page) => [page.file, page.content]));
}

describe('the reference rendered from the committed docs/openapi.json', () => {
  const pages = referencePages(committed);

  it('renders every operation under each of its tags, with its SDK method and scope', () => {
    for (const entry of allEntries(committed)) {
      for (const tag of entry.operation.tags ?? []) {
        const page = pages.find((p) => p.file === `reference/${tagSlug(tag)}.mdx`);
        expect(page?.content).toContain(
          entry.kind === 'webhook'
            ? `## \`${entry.path}\``
            : `\`${entry.method.toUpperCase()} ${entry.path}\``,
        );
        if (entry.operation['x-peable-sdk'])
          expect(page?.content).toContain(`peable.${entry.operation['x-peable-sdk']}()`);
        if (entry.operation['x-peable-scope'])
          expect(page?.content).toContain(`\`${entry.operation['x-peable-scope']}\``);
      }
    }
  });

  it('gives every component schema its page', () => {
    const names = Object.keys(committed.components?.schemas ?? {});
    const objects = pages.filter((page) => page.file.startsWith('reference/objects/'));
    expect(objects.map((page) => page.title).sort()).toEqual([...names].sort());
  });

  it('links only to pages and headings it generates', () => {
    const generated = byFile(pages);
    // The guides and the errors page the reference links into.
    for (const stub of ['quickstart', 'webhooks', 'errors'])
      generated.set(`${stub}.mdx`, '# Stub\n\n### `test_mode_only`\n');
    expect(deadLinks(generated)).toEqual([]);
  });

  it('starts every page with the front matter the docs site reads, naming its source', () => {
    for (const page of pages) {
      expect(page.content).toMatch(
        /^---\ntitle: "[^"\n]+"\n(description: "[^"\n]+"\n)?order: \d+\ngenerated: "by bun run generate:api-docs from docs\/openapi.json; do not edit"\n---\n\n# /,
      );
    }
  });
});

const fixture: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Fixture API', version: '2099-01-01' },
  tags: [{ name: 'Widgets' }],
  paths: {
    '/v1/widgets': {
      post: {
        operationId: 'createWidget',
        tags: ['Widgets'],
        summary: 'Create a widget',
        security: [{ token: [] }],
        'x-peable-test-mode-only': true,
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['size'],
                properties: {
                  size: { type: 'string', enum: ['s', 'm'], description: 'Pipes | split {cells}.' },
                  parts: {
                    type: 'array',
                    items: { type: 'object', properties: { label: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
          },
        },
      },
    },
    '/v1/widgets/{id}/pdf': {
      get: {
        operationId: 'widgetPdf',
        tags: ['Widgets'],
        summary: 'Create a widget',
        security: [],
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        responses: { '200': { content: { 'application/pdf': { schema: { type: 'string' } } } } },
      },
    },
    '/v1/widgets/stream': {
      get: {
        operationId: 'streamWidgets',
        tags: ['Widgets'],
        responses: {
          '200': {
            content: {
              'text/event-stream': {
                schema: { type: 'string' },
                'x-peable-event': { $ref: '#/components/schemas/Widget' },
              },
            },
          },
        },
      },
    },
  },
  webhooks: {
    'widget.created': {
      post: {
        tags: [WEBHOOK_TAG],
        summary: 'widget.created',
        description: 'Signed `t=<unix seconds>`, sent <after> a widget exists.',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
        },
      },
    },
  },
  components: {
    securitySchemes: { token: { type: 'http', scheme: 'bearer', bearerFormat: 'Test token' } },
    schemas: {
      Widget: {
        type: 'object',
        properties: {
          object: { type: 'string', const: 'widget' },
          owner: {
            anyOf: [{ type: 'string' }, { $ref: '#/components/schemas/Widget' }],
            'x-peable-expandable': 'widget',
          },
        },
        examples: [{ object: 'widget', owner: 'wd_1' }],
      },
    },
  },
};

describe('the renderer, on a document that uses everything', () => {
  const pages = referencePages(fixture);
  const content = (file: string) => pages.find((page) => page.file === file)?.content ?? '';
  const widgets = content('reference/widgets.mdx');
  const events = content('reference/webhook-events.mdx');

  it('renders webhooks on the events page, anchored the way the site slugs the event type', () => {
    expect(events).toContain('## `widget.created`');
    const group = tagGroups(fixture).find((g) => g.tag === WEBHOOK_TAG);
    expect(group?.entries[0]?.heading.anchor).toBe('widgetcreated');
    expect(events).toContain('[Widget](/reference/objects/widget)');
  });

  it('escapes what MDX would compile outside code spans, and keeps code spans literal', () => {
    expect(events).toContain('`t=<unix seconds>`');
    expect(events).toContain('sent &lt;after&gt; a widget');
    expect(widgets).toContain('Pipes \\| split \\{cells\\}.');
  });

  it('gives repeated headings the suffix the site gives them', () => {
    const group = tagGroups(fixture).find((g) => g.tag === 'Widgets');
    expect(group?.entries.map((e) => e.heading.anchor)).toEqual([
      'create-a-widget',
      'create-a-widget-1',
      'get-v1widgetsstream',
    ]);
  });

  it('names required fields in bracket notation, nested arrays included', () => {
    expect(widgets).toContain('`size` **required**');
    expect(widgets).toContain('`parts[][label]`');
  });

  it('describes bytes, streams, public routes and test-mode-only routes', () => {
    expect(widgets).toContain('The bytes, as `application/pdf`.');
    expect(widgets).toContain('A Server-Sent Events stream (`text/event-stream`)');
    expect(widgets).toContain('None. A payer-facing route');
    expect(widgets).toContain('Test mode only');
    expect(widgets).toContain('[Test token](/reference#test-token)');
  });

  it('lists expandable fields, examples and back-links on the object page', () => {
    const widget = content('reference/objects/widget.mdx');
    expect(widget).toContain('- `owner` → [Widget](/reference/objects/widget)');
    expect(widget).toContain('"owner": "wd_1"');
    expect(widget).toContain('[`POST /v1/widgets`](/reference/widgets#create-a-widget)');
    expect(widget).toContain('[`widget.created`](/reference/webhook-events#widgetcreated)');
  });

  it('refuses two tags that would share a page', () => {
    const clash: OpenApiDocument = {
      ...fixture,
      tags: [{ name: 'Widgets' }, { name: 'widgets' }],
      paths: { '/a': { get: { tags: ['Widgets'] } }, '/b': { get: { tags: ['widgets'] } } },
    };
    expect(() => referencePages(clash)).toThrow('reference/widgets.mdx');
  });

  it('slugs object and tag names into kebab case', () => {
    expect(objectSlug('DeletedCustomer')).toBe('deleted-customer');
    expect(objectSlug('URLSettings')).toBe('url-settings');
    expect(tagSlug('Payment methods')).toBe('payment-methods');
  });
});
