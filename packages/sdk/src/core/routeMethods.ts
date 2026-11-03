// The runtime half of the generated resources (`../generated/resources.ts`).
//
// The generator reads every route contract and writes, per route, a
// `RouteSpec`: strings and flags only — method, path, where its input goes, how
// its answer is read. This module turns those specs into the nested resource
// tree a `Peable` client exposes. No schema is imported at runtime; the TYPES of
// each method come from the contracts at compile time (`import type`), in the
// generated interface.

import type { List, ResponseOf, RouteContract, SearchResult } from '@peable.to/contracts';
import type {
  AccountOptions,
  DownloadedBytes,
  GatewayClient,
  IdempotencyOptions,
  RequestOptions,
  RestClientRequestOptions,
} from './client';
import {
  type ApiListPromise,
  type ApiSearchPromise,
  listPromise,
  type QueryValue,
  searchPromise,
} from './list';
import { type LiveStreamOptions, liveStream } from './liveStream';

/** How a route's success is read. */
export type RouteKind =
  /** One JSON object. */
  | 'json'
  /** `{object:'list', …}`: a page promise that is also an async iterable over every item. */
  | 'list'
  /** `{object:'search_result', …}`: the same, paging forward over `next_page`. */
  | 'search'
  /** Bytes: `{ bytes, contentType, filename }`. */
  | 'binary'
  /** Server-Sent Events: an async iterable that reconnects and resumes on its own. */
  | 'stream';

/** Where a route's `params` argument goes. */
export type RouteInput =
  | 'none'
  | 'body'
  | 'query'
  /** A body, except the keys in `queryKeys`, which go in the query. */
  | 'body+query';

export interface RouteSpec {
  /** The dotted method path from the client: `billing.meters.listEventSummaries`. */
  readonly sdk: string;
  readonly operationId: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** OpenAPI template: `/v1/customers/{id}`. */
  readonly path: string;
  /** The template's parameters, in path order — the method's leading arguments. */
  readonly pathParams: readonly string[];
  readonly input: RouteInput;
  readonly queryKeys?: readonly string[];
  /** `multipart`: a body carrying bytes is sent as `multipart/form-data`. */
  readonly encoding: 'json' | 'multipart';
  readonly kind: RouteKind;
  /** Accepts `Peable-Account`: the client's default `peableAccount` applies. */
  readonly account: boolean;
  /** On a stream: the SSE `event:` name of the objects it carries. */
  readonly streamEvent?: string;
  /** On a binary route: the content type it answers, sent as `Accept`. */
  readonly accept?: string;
}

// ---------------------------------------------------------------------------
// Types the generated signatures are spelled with.
// ---------------------------------------------------------------------------

/** A list route's answer: the first page, and every item across all pages. */
export type ListPromiseOf<R extends RouteContract> =
  ResponseOf<R> extends { object: 'list'; data: (infer T)[]; has_more: boolean; url: string }
    ? ApiListPromise<T, ResponseOf<R>>
    : never;

/** A search route's answer: the first page, and every match across all pages. */
export type SearchPromiseOf<R extends RouteContract> =
  ResponseOf<R> extends {
    object: 'search_result';
    data: (infer T)[];
    has_more: boolean;
    next_page: string | null;
    url: string;
  }
    ? ApiSearchPromise<T, ResponseOf<R>>
    : never;

/** What a live tail accepts as its last argument. */
export type StreamOptions = Pick<RequestOptions, 'apiVersion'> & LiveStreamOptions;

export type { AccountOptions, DownloadedBytes, IdempotencyOptions, RequestOptions };

// ---------------------------------------------------------------------------
// Runtime.
// ---------------------------------------------------------------------------

type Params = Readonly<Record<string, unknown>> | undefined;
type Options = Readonly<Record<string, unknown>> | undefined;

function fillPath(spec: RouteSpec, values: readonly unknown[]): string {
  let path = spec.path;
  spec.pathParams.forEach((name, index) => {
    const value = values[index];
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`Peable: ${spec.sdk}() needs \`${name}\` as a non-empty string`);
    }
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  });
  return path;
}

function isBytes(value: unknown): value is Blob | ArrayBuffer | ArrayBufferView {
  return (
    (typeof Blob !== 'undefined' && value instanceof Blob) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function carriesBytes(value: unknown): boolean {
  if (isBytes(value)) return true;
  if (Array.isArray(value)) return value.some(carriesBytes);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(carriesBytes);
  return false;
}

function toBlob(value: Blob | ArrayBuffer | ArrayBufferView): Blob {
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
  // Copied into a plain ArrayBuffer: a view over a SharedArrayBuffer is not a BlobPart.
  const view =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(
          (value as ArrayBufferView).buffer,
          (value as ArrayBufferView).byteOffset,
          (value as ArrayBufferView).byteLength,
        );
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return new Blob([copy.buffer]);
}

/**
 * A body as `multipart/form-data`: bytes become file parts (a `File` keeps its
 * name), objects bracket notation (`metadata[order_id]`), scalars strings.
 */
export function toFormData(body: Readonly<Record<string, unknown>>): FormData {
  const form = new FormData();
  const append = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (isBytes(value)) {
      const blob = toBlob(value);
      const name = (blob as { name?: unknown }).name;
      form.append(key, blob, typeof name === 'string' && name.length > 0 ? name : 'upload');
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        append(`${key}[${index}]`, item);
      });
    } else if (typeof value === 'object') {
      for (const [sub, inner] of Object.entries(value)) append(`${key}[${sub}]`, inner);
    } else {
      form.append(key, String(value));
    }
  };
  for (const [key, value] of Object.entries(body)) append(key, value);
  return form;
}

/** Split `params` into what the request carries where. */
function placeInput(
  spec: RouteSpec,
  params: Params,
): Pick<RestClientRequestOptions, 'body' | 'form' | 'query'> {
  if (spec.input === 'none' || params === undefined) {
    // A write still sends a JSON body (`{}`), so the gateway reads one shape.
    return spec.method === 'POST' || spec.method === 'PUT' ? { body: {} } : {};
  }
  if (spec.input === 'query') return { query: params as Record<string, QueryValue> };
  let body: Record<string, unknown> = { ...params };
  let query: Record<string, QueryValue> | undefined;
  if (spec.input === 'body+query') {
    query = {};
    for (const key of spec.queryKeys ?? []) {
      query[key] = body[key] as QueryValue;
      const { [key]: _moved, ...rest } = body;
      body = rest;
    }
  }
  const encoded =
    spec.encoding === 'multipart' && carriesBytes(body) ? { form: toFormData(body) } : { body };
  return query === undefined ? encoded : { ...encoded, query };
}

function requestOf(spec: RouteSpec, params: Params, options: Options): RestClientRequestOptions {
  return { ...options, ...placeInput(spec, params), acceptsPeableAccount: spec.account };
}

/** One method: `(…pathParams, params?, options?)`. */
function routeMethod(client: GatewayClient, spec: RouteSpec): (...args: unknown[]) => unknown {
  const arity = spec.pathParams.length;
  const takesParams = spec.input !== 'none';
  return (...args: unknown[]): unknown => {
    const params = (takesParams ? args[arity] : undefined) as Params;
    const options = args[takesParams ? arity + 1 : arity] as Options;
    // Resolved inside each fetch, so a bad argument is a rejected promise (or
    // a throwing iterator), never a synchronous throw from a method that
    // otherwise always answers asynchronously.
    const pathOf = (): string => fillPath(spec, args);
    switch (spec.kind) {
      case 'json':
        return (async () =>
          client.request(spec.method, pathOf(), requestOf(spec, params, options)))();
      case 'binary':
        return (async () =>
          client.download(spec.method, pathOf(), {
            ...requestOf(spec, params, options),
            ...(spec.accept === undefined ? {} : { headers: { Accept: spec.accept } }),
          }))();
      case 'list':
        return listPromise(
          async (page: Record<string, unknown>) =>
            client.request<List<{ id: string }>>(
              spec.method,
              pathOf(),
              requestOf(spec, page, options),
            ),
          (params ?? {}) as Record<string, unknown>,
        );
      case 'search':
        return searchPromise(
          async (page: Record<string, unknown> & { query: string }) =>
            client.request<SearchResult<unknown>>(
              spec.method,
              pathOf(),
              requestOf(spec, page, options),
            ),
          (params ?? {}) as Record<string, unknown> & { query: string },
        );
      case 'stream': {
        const { apiVersion, peableAccount, ...live } = (options ?? {}) as StreamOptions &
          AccountOptions;
        return (async function* () {
          yield* liveStream(
            client,
            pathOf(),
            spec.streamEvent ?? 'message',
            (params ?? {}) as Record<string, QueryValue>,
            live,
            {
              ...(apiVersion === undefined ? {} : { apiVersion }),
              ...(peableAccount === undefined ? {} : { peableAccount }),
              acceptsPeableAccount: spec.account,
            },
          );
        })();
      }
    }
  };
}

/**
 * The nested resource tree of `specs`: `customers.create`,
 * `billing.meters.listEventSummaries`. `T` is the generated interface that
 * types it.
 */
export function buildResourceTree<T>(client: GatewayClient, specs: readonly RouteSpec[]): T {
  const root: Record<string, unknown> = {};
  for (const spec of specs) {
    const segments = spec.sdk.split('.');
    const name = segments.pop() as string;
    let node = root;
    for (const segment of segments) {
      if (node[segment] === undefined) node[segment] = {};
      node = node[segment] as Record<string, unknown>;
    }
    node[name] = routeMethod(client, spec);
  }
  return root as T;
}
