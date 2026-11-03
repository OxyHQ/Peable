// The generator (`scripts/generate-resources.ts`) over synthetic routes: every
// kind is detected from the contract alone, `params` lands where the route
// reads it, and a route that cannot become a method is refused at generation.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  defineRoute,
  listOf,
  type RouteContract,
  routes,
  searchResultOf,
} from '@peable.to/contracts';
import { z } from 'zod';
import { buildTree, formatResources, renderResources } from '../../scripts/generate-resources';

const item = z.object({ id: z.string(), object: z.literal('widget') }).strict();
const base = { tag: 'Widgets', summary: 'A widget operation', auth: 'service' } as const;

const synthetic: readonly RouteContract[] = [
  defineRoute({
    ...base,
    operationId: 'listWidgets',
    method: 'get',
    path: '/v1/widgets',
    query: z.object({ limit: z.number().optional() }).strict(),
    response: listOf(item),
    sdk: 'widgets.list',
  }),
  defineRoute({
    ...base,
    operationId: 'searchWidgets',
    method: 'get',
    path: '/v1/widgets/search',
    query: z.object({ query: z.string(), page: z.string().optional() }).strict(),
    response: searchResultOf(item),
    sdk: 'widgets.search',
  }),
  defineRoute({
    ...base,
    operationId: 'downloadWidget',
    method: 'get',
    path: '/v1/widgets/{id}/contents',
    params: { id: 'The widget.' },
    response: { kind: 'binary', contentType: 'application/pdf' },
    sdk: 'widgets.contents',
  }),
  defineRoute({
    ...base,
    operationId: 'streamWidgets',
    method: 'get',
    path: '/v1/widgets/stream',
    query: z.object({ types: z.string().optional() }).strict(),
    response: { kind: 'stream', event: item },
    sdk: 'widgets.stream',
  }),
  defineRoute({
    ...base,
    operationId: 'uploadWidget',
    method: 'post',
    path: '/v1/widgets',
    body: z.object({ purpose: z.string(), file: z.unknown() }).strict(),
    bodyEncoding: 'multipart',
    response: item,
    sdk: 'widgets.create',
  }),
  defineRoute({
    ...base,
    operationId: 'scopedWidgetPart',
    method: 'post',
    path: '/v1/widgets/{widget}/parts/{part}',
    params: { widget: 'The widget.', part: 'The part.' },
    query: z.object({ environment: z.string() }).strict(),
    body: z.object({ active: z.boolean().optional() }).strict(),
    peableAccount: true,
    response: item,
    sdk: 'widgets.parts.update',
  }),
  defineRoute({
    ...base,
    operationId: 'notInTheSdk',
    method: 'get',
    path: '/v1/widgets/private',
    response: item,
  }),
];

describe('kind and input detection', () => {
  const { specs, root } = buildTree(synthetic);
  const spec = (sdk: string) => specs.find((candidate) => candidate.sdk === sdk);

  test('list and search from the envelope, binary and stream from the response kind', () => {
    expect(spec('widgets.list')?.kind).toBe('list');
    expect(spec('widgets.search')?.kind).toBe('search');
    expect(spec('widgets.contents')?.kind).toBe('binary');
    expect(spec('widgets.stream')).toMatchObject({ kind: 'stream', streamEvent: 'widget' });
    expect(spec('widgets.create')).toMatchObject({ kind: 'json', encoding: 'multipart' });
  });

  test('path parameters in path order; a body beside a query keeps the query keys apart', () => {
    expect(spec('widgets.parts.update')).toMatchObject({
      method: 'POST',
      pathParams: ['widget', 'part'],
      input: 'body+query',
      queryKeys: ['environment'],
      account: true,
    });
    expect(spec('widgets.contents')).toMatchObject({ input: 'none', pathParams: ['id'] });
  });

  test('a route without `sdk` is not generated', () => {
    expect(specs.map((candidate) => candidate.operationId)).not.toContain('notInTheSdk');
  });

  test('params are optional exactly when no key is required', () => {
    const widgets = root.children.get('widgets');
    expect(widgets?.methods.get('list')?.optionalParams).toBe(true);
    expect(widgets?.methods.get('search')?.optionalParams).toBe(false);
    expect(widgets?.methods.get('create')?.optionalParams).toBe(false);
    // The query's `environment` is required, so the merged params are too.
    expect(widgets?.children.get('parts')?.methods.get('update')?.optionalParams).toBe(false);
  });
});

describe('rendering', () => {
  const source = renderResources(synthetic);

  test('signatures name the contract types and the options the route accepts', () => {
    expect(source).toContain(
      "list(params?: QueryOf<Op<'listWidgets'>>, options?: RequestOptions): ListPromiseOf<Op<'listWidgets'>>;",
    );
    expect(source).toContain(
      "search(params: QueryOf<Op<'searchWidgets'>>, options?: RequestOptions): SearchPromiseOf<Op<'searchWidgets'>>;",
    );
    expect(source).toContain(
      'contents(id: string, options?: RequestOptions): Promise<DownloadedBytes>;',
    );
    expect(source).toContain(
      "stream(params?: QueryOf<Op<'streamWidgets'>>, options?: StreamOptions): AsyncGenerator<ResponseOf<Op<'streamWidgets'>>>;",
    );
    expect(source).toContain(
      "update(widget: string, part: string, params: BodyOf<Op<'scopedWidgetPart'>> & QueryOf<Op<'scopedWidgetPart'>>, options?: RequestOptions & IdempotencyOptions & AccountOptions): Promise<ResponseOf<Op<'scopedWidgetPart'>>>;",
    );
    expect(source).toContain('export interface WidgetsPartsResource {');
    expect(source).toContain('readonly parts: WidgetsPartsResource;');
  });

  test('imports the contracts as types only — no schema reaches the runtime', () => {
    const imports = source
      .split('\n')
      .filter((line) => line.includes("from '@peable.to/contracts"));
    expect(imports).toEqual([
      "import type { BodyOf, QueryOf, ResponseOf, RouteMap } from '@peable.to/contracts';",
    ]);
  });
});

describe('refusals', () => {
  const route = (overrides: Partial<RouteContract>): RouteContract => ({
    ...base,
    operationId: 'x',
    method: 'get',
    path: '/v1/x',
    response: item,
    sdk: 'x.retrieve',
    ...overrides,
  });

  test('a duplicate method, a method nesting under a method, a root method', () => {
    expect(() => buildTree([route({}), route({ operationId: 'y' })])).toThrow(/declared twice/);
    expect(() =>
      buildTree([route({}), route({ operationId: 'y', sdk: 'x.retrieve.deeper' })]),
    ).toThrow(/nests under a method/);
    expect(() => buildTree([route({ sdk: 'retrieve' })])).toThrow(/dotted method path/);
  });

  test('an undocumented path parameter, or one that collides with an argument', () => {
    expect(() => buildTree([route({ path: '/v1/x/{id}' })])).toThrow(/not documented/);
    expect(() => buildTree([route({ path: '/v1/x/{options}', params: { options: 'x' } })])).toThrow(
      /cannot be an argument name/,
    );
  });

  test('a stream whose events carry no `object` literal', () => {
    expect(() =>
      buildTree([route({ response: { kind: 'stream', event: z.object({ id: z.string() }) } })]),
    ).toThrow(/object/);
  });
});

test('the committed file is what the generator writes for the current contracts', () => {
  const committed = readFileSync(
    new URL('../../src/generated/resources.ts', import.meta.url),
    'utf8',
  );
  expect(committed).toBe(formatResources(renderResources(routes as readonly RouteContract[])));
});
