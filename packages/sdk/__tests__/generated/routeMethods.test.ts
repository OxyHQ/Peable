// The runtime of a generated method (`core/routeMethods.ts`), per kind, over
// the specs the generator derives from synthetic routes.

import { describe, expect, test } from 'bun:test';
import { defineRoute, listOf, type RouteContract } from '@peable.to/contracts';
import { PEABLE_API_VERSION } from '@peable.to/contracts/vocabulary';
import { z } from 'zod';
import { buildTree } from '../../scripts/generate-resources';
import { buildResourceTree } from '../../src/core/routeMethods';
import { createMockFetch, type MockFetchHandler } from '../support/mockFetch';
import {
  buildTestClient,
  serviceTokenMintResponse,
  TEST_GATEWAY_URL,
} from '../support/testGateway';

const item = z.object({ id: z.string(), object: z.literal('widget') }).strict();
const base = { tag: 'Widgets', summary: 'Widgets', auth: 'service' } as const;

const routes: readonly RouteContract[] = [
  defineRoute({
    ...base,
    operationId: 'listWidgets',
    method: 'get',
    path: '/v1/widgets',
    query: z.object({ limit: z.number().optional(), starting_after: z.string().optional() }),
    peableAccount: true,
    response: listOf(item),
    sdk: 'widgets.list',
  }),
  defineRoute({
    ...base,
    operationId: 'createWidget',
    method: 'post',
    path: '/v1/widgets',
    body: z.object({ purpose: z.string(), file: z.unknown().optional() }),
    bodyEncoding: 'multipart',
    response: item,
    sdk: 'widgets.create',
  }),
  defineRoute({
    ...base,
    operationId: 'touchWidget',
    method: 'post',
    path: '/v1/widgets/{id}/touch',
    params: { id: 'The widget.' },
    response: item,
    sdk: 'widgets.touch',
  }),
  defineRoute({
    ...base,
    operationId: 'scopedWidget',
    method: 'post',
    path: '/v1/orgs/{org}/widgets/{id}',
    params: { org: 'The org.', id: 'The widget.' },
    query: z.object({ environment: z.string() }),
    body: z.object({ active: z.boolean() }),
    response: item,
    sdk: 'widgets.scoped',
  }),
  defineRoute({
    ...base,
    operationId: 'widgetContents',
    method: 'get',
    path: '/v1/widgets/{id}/contents',
    params: { id: 'The widget.' },
    response: { kind: 'binary', contentType: 'text/csv' },
    sdk: 'widgets.contents',
  }),
  defineRoute({
    ...base,
    operationId: 'streamWidgets',
    method: 'get',
    path: '/v1/widgets/stream',
    query: z.object({ types: z.string().optional() }),
    response: { kind: 'stream', event: item },
    sdk: 'widgets.stream',
  }),
];

type Method = (...args: unknown[]) => unknown;
interface Widgets {
  list: Method;
  create: Method;
  touch: Method;
  scoped: Method;
  contents: Method;
  stream: Method;
}

function widgets(handler: MockFetchHandler, config: { peableAccount?: string } = {}) {
  const mock = createMockFetch((request) =>
    request.url.includes('/auth/service-token') ? serviceTokenMintResponse() : handler(request),
  );
  const tree = buildResourceTree<{ widgets: Widgets }>(
    buildTestClient(mock.fetch, config),
    buildTree(routes).specs,
  );
  const calls = () => mock.requests.filter((request) => !request.url.includes('/auth/'));
  return { widgets: tree.widgets, calls };
}

describe('generated methods at runtime', () => {
  test('a list pages forward with the same options on every page; the client account applies', async () => {
    const pages: Record<string, unknown> = {
      first: {
        object: 'list',
        data: [{ id: 'w_1' }, { id: 'w_2' }],
        has_more: true,
        url: '/v1/widgets',
      },
      w_2: { object: 'list', data: [{ id: 'w_3' }], has_more: false, url: '/v1/widgets' },
    };
    const { widgets: api, calls } = widgets(
      (request) => ({
        status: 200,
        json: pages[new URL(request.url).searchParams.get('starting_after') ?? 'first'],
      }),
      { peableAccount: 'ca_default' },
    );
    const list = api.list({ limit: 2 }, { timeout: 5_000 }) as AsyncIterable<{ id: string }>;
    const ids: string[] = [];
    for await (const widget of list) ids.push(widget.id);
    expect(ids).toEqual(['w_1', 'w_2', 'w_3']);
    expect(calls().map((request) => request.url)).toEqual([
      `${TEST_GATEWAY_URL}/v1/widgets?limit=2`,
      `${TEST_GATEWAY_URL}/v1/widgets?limit=2&starting_after=w_2`,
    ]);
    expect(calls().map((request) => request.headers.get('Peable-Account'))).toEqual([
      'ca_default',
      'ca_default',
    ]);
    expect(calls()[0]?.headers.get('Peable-Version')).toBe(PEABLE_API_VERSION);
  });

  test('a route that does not accept Peable-Account never gets the client default', async () => {
    const { widgets: api, calls } = widgets(() => ({ status: 200, json: { id: 'w_1' } }), {
      peableAccount: 'ca_default',
    });
    await api.touch('w_1');
    expect(calls()[0]?.headers.get('Peable-Account')).toBeNull();
  });

  test('path parameters are encoded in order; a write without params sends {} and a key', async () => {
    const { widgets: api, calls } = widgets(() => ({ status: 200, json: { id: 'w 1' } }));
    await api.touch('w/1');
    expect(calls()[0]).toMatchObject({
      method: 'POST',
      url: `${TEST_GATEWAY_URL}/v1/widgets/w%2F1/touch`,
      body: '{}',
    });
    expect(calls()[0]?.headers.get('Idempotency-Key')).toBeTruthy();
    await expect(api.touch('') as Promise<unknown>).rejects.toThrow(/`id` as a non-empty string/);
  });

  test('a body beside a query sends the query keys in the URL and the rest as JSON', async () => {
    const { widgets: api, calls } = widgets(() => ({ status: 200, json: { id: 'w_1' } }));
    await api.scoped('org_1', 'w_1', { environment: 'production', active: false });
    expect(calls()[0]?.url).toBe(
      `${TEST_GATEWAY_URL}/v1/orgs/org_1/widgets/w_1?environment=production`,
    );
    expect(JSON.parse(calls()[0]?.body ?? '')).toEqual({ active: false });
  });

  test('a multipart route sends bytes as form data, and JSON when there are none', async () => {
    const { widgets: api, calls } = widgets(() => ({ status: 200, json: { id: 'w_1' } }));
    await api.create(
      { purpose: 'evidence', file: new Uint8Array([1, 2, 3]) },
      { idempotencyKey: 'k1' },
    );
    const form = calls()[0]?.form;
    expect(form?.get('purpose')).toBe('evidence');
    const file = form?.get('file') as Blob;
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls()[0]?.headers.get('Idempotency-Key')).toBe('k1');
    expect(calls()[0]?.headers.get('Content-Type')).toBeNull();

    await api.create({ purpose: 'business_logo' });
    expect(JSON.parse(calls()[1]?.body ?? '')).toEqual({ purpose: 'business_logo' });
  });

  test('a binary route answers bytes, content type and filename', async () => {
    const { widgets: api } = widgets(() => ({
      status: 200,
      text: 'a,b\n1,2\n',
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="w.csv"',
      },
    }));
    const answer = (await api.contents('w_1')) as {
      bytes: Uint8Array;
      contentType: string | null;
      filename: string | null;
    };
    expect(new TextDecoder().decode(answer.bytes)).toBe('a,b\n1,2\n');
    expect(answer.contentType).toBe('text/csv');
    expect(answer.filename).toBe('w.csv');
  });

  test('a stream yields the objects of its event, with the query and version', async () => {
    const { widgets: api, calls } = widgets(() => ({
      status: 200,
      text: [
        'event: ready',
        'data: {}',
        '',
        'id: 1',
        'event: widget',
        'data: {"id":"w_1","object":"widget"}',
        '',
        '',
      ].join('\n'),
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    let connected = 0;
    const stream = api.stream(
      { types: 'a,b' },
      { onConnect: () => connected++ },
    ) as AsyncGenerator<{
      id: string;
    }>;
    for await (const widget of stream) {
      expect(widget.id).toBe('w_1');
      break;
    }
    expect(connected).toBe(1);
    expect(calls()[0]?.url).toBe(`${TEST_GATEWAY_URL}/v1/widgets/stream?types=a%2Cb`);
    expect(calls()[0]?.headers.get('Accept')).toBe('text/event-stream');
    expect(calls()[0]?.headers.get('Peable-Version')).toBe(PEABLE_API_VERSION);
  });
});
