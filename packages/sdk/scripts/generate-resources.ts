// Writes `packages/sdk/src/generated/resources.ts` — the SDK's resource methods,
// one per route contract that names an `sdk` method (ADR 0014 D5). With
// `--check` it writes nothing and fails when the committed file differs: the
// CI drift gate (`bun run check:sdk-resources`).
//
// The generated file carries strings and flags only (`RouteSpec`s) and imports
// the contracts as TYPES: every parameter and return type is derived at compile
// time from the route's own `BodyOf` / `QueryOf` / `ResponseOf`, so a field
// renamed in a contract is a compile error in every caller, not a runtime 400.
//
// What the generator decides, from the contract (it may read the schemas; the
// SDK's runtime never does):
//
// - the KIND: `binary` / `stream` from the response's `kind`; `list` / `search`
//   when the JSON response is an object whose `object` is the literal `'list'` /
//   `'search_result'` — exactly the envelopes `listOf` / `searchResultOf` build;
//   `json` otherwise;
// - where `params` goes: the body on a route that declares one (its query keys
//   split out when it declares both), else the query, else there is none;
// - whether `params` is optional: when the input object has no required key;
// - the SSE event name of a stream: its event schema's `object` literal.
//
// Only `service` routes are generated: the server SDK authenticates with a
// service token, so a `public` (payer) or `user` (Oxy session) route is never
// a method here, even when it names an `sdk` path.
//
// `__tests__/generated/types.test.ts` proves every generated signature equals
// the one derived from the contract types alone.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RouteContract } from '@peable.to/contracts';
import type { RouteKind, RouteSpec } from '../src/core/routeMethods';

const TARGET = new URL('../src/generated/resources.ts', import.meta.url);
const TARGET_FROM_ROOT = 'packages/sdk/src/generated/resources.ts';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// ---------------------------------------------------------------------------
// Reading a schema (zod 4's public `_zod.def`), without importing zod.
// ---------------------------------------------------------------------------

interface SchemaLike {
  readonly _zod: {
    readonly def: {
      readonly type: string;
      readonly shape?: Readonly<Record<string, SchemaLike>>;
      readonly values?: readonly unknown[];
      readonly in?: SchemaLike;
      readonly innerType?: SchemaLike;
      readonly getter?: () => SchemaLike;
    };
    /** Set when the INPUT may omit the value (`optional`, or `defaulted`). */
    readonly optin?: 'optional' | 'defaulted';
  };
}

function isSchema(value: unknown): value is SchemaLike {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

/** The object a schema validates, through pipes, lazies and readonly wrappers. */
function objectShape(schema: SchemaLike): Readonly<Record<string, SchemaLike>> | undefined {
  const { def } = schema._zod;
  if (def.type === 'object') return def.shape;
  if (def.type === 'pipe' && def.in) return objectShape(def.in);
  if (def.type === 'lazy' && def.getter) return objectShape(def.getter());
  if ((def.type === 'readonly' || def.type === 'nonoptional') && def.innerType) {
    return objectShape(def.innerType);
  }
  return undefined;
}

function literalOf(schema: SchemaLike | undefined): unknown {
  if (schema === undefined) return undefined;
  const { def } = schema._zod;
  return def.type === 'literal' && def.values?.length === 1 ? def.values[0] : undefined;
}

/** Whether a request schema can be omitted: an object none of whose keys is required. */
function inputIsOptional(schema: SchemaLike): boolean {
  if (schema._zod.optin !== undefined) return true;
  const shape = objectShape(schema);
  if (shape === undefined) return false;
  return Object.values(shape).every((field) => field._zod.optin !== undefined);
}

function kindOf(route: RouteContract): RouteKind {
  const { response } = route;
  if ('kind' in response) return response.kind;
  const envelope = literalOf(objectShape(response)?.object);
  if (envelope === 'list') return 'list';
  if (envelope === 'search_result') return 'search';
  return 'json';
}

// ---------------------------------------------------------------------------
// The tree.
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_ARGUMENTS = new Set(['params', 'options']);

export interface Method {
  readonly name: string;
  readonly route: RouteContract;
  readonly spec: RouteSpec;
  readonly optionalParams: boolean;
}

export interface Namespace {
  readonly path: readonly string[];
  readonly methods: Map<string, Method>;
  readonly children: Map<string, Namespace>;
}

function namespace(path: readonly string[]): Namespace {
  return { path, methods: new Map(), children: new Map() };
}

function specOf(route: RouteContract, sdk: string): RouteSpec {
  const pathParams = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] as string);
  for (const name of pathParams) {
    if (!IDENTIFIER.test(name) || RESERVED_ARGUMENTS.has(name)) {
      throw new Error(`${route.operationId}: path parameter '${name}' cannot be an argument name`);
    }
    if (route.params?.[name] === undefined) {
      throw new Error(`${route.operationId}: path parameter '${name}' is not documented`);
    }
  }
  const kind = kindOf(route);
  let input: RouteSpec['input'] = 'none';
  let queryKeys: string[] | undefined;
  if (route.body !== undefined && route.query !== undefined) {
    input = 'body+query';
    const shape = isSchema(route.query) ? objectShape(route.query) : undefined;
    if (shape === undefined) {
      throw new Error(`${route.operationId}: a query beside a body must be an object`);
    }
    queryKeys = Object.keys(shape);
  } else if (route.body !== undefined) {
    input = 'body';
  } else if (route.query !== undefined) {
    input = 'query';
  }
  let streamEvent: string | undefined;
  if ('kind' in route.response && route.response.kind === 'stream') {
    const event = literalOf(objectShape(route.response.event as unknown as SchemaLike)?.object);
    if (typeof event !== 'string') {
      throw new Error(`${route.operationId}: a stream's event schema needs an \`object\` literal`);
    }
    streamEvent = event;
  }
  return {
    sdk,
    operationId: route.operationId,
    method: route.method.toUpperCase() as RouteSpec['method'],
    path: route.path,
    pathParams,
    input,
    ...(queryKeys === undefined ? {} : { queryKeys }),
    encoding: route.bodyEncoding === 'multipart' ? 'multipart' : 'json',
    kind,
    account: route.peableAccount === true,
    ...(streamEvent === undefined ? {} : { streamEvent }),
    ...('kind' in route.response && route.response.kind === 'binary'
      ? { accept: route.response.contentType }
      : {}),
  };
}

function inputOptional(route: RouteContract, input: RouteSpec['input']): boolean {
  const schemas = [
    input === 'body' || input === 'body+query' ? route.body : undefined,
    input === 'query' || input === 'body+query' ? route.query : undefined,
  ].filter((schema): schema is NonNullable<typeof schema> => schema !== undefined);
  return schemas.every((schema) => isSchema(schema) && inputIsOptional(schema));
}

export function buildTree(routes: readonly RouteContract[]): {
  root: Namespace;
  specs: RouteSpec[];
} {
  const root = namespace([]);
  const specs: RouteSpec[] = [];
  for (const route of routes) {
    // The server SDK speaks with a service token: a payer (`public`) route
    // belongs to the browser entry and a `user` route to an Oxy session,
    // whatever `sdk` name they carry.
    if (route.sdk === undefined || route.auth !== 'service') continue;
    const segments = route.sdk.split('.');
    if (segments.length < 2 || !segments.every((segment) => IDENTIFIER.test(segment))) {
      throw new Error(`${route.operationId}: sdk '${route.sdk}' is not a dotted method path`);
    }
    const name = segments[segments.length - 1] as string;
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      if (node.methods.has(segment)) {
        throw new Error(`${route.operationId}: '${route.sdk}' nests under a method`);
      }
      let child = node.children.get(segment);
      if (child === undefined) {
        child = namespace([...node.path, segment]);
        node.children.set(segment, child);
      }
      node = child;
    }
    if (node.methods.has(name) || node.children.has(name)) {
      throw new Error(`${route.operationId}: '${route.sdk}' is declared twice`);
    }
    const spec = specOf(route, route.sdk);
    specs.push(spec);
    node.methods.set(name, { name, route, spec, optionalParams: inputOptional(route, spec.input) });
  }
  if (root.methods.size > 0) throw new Error('a method cannot sit at the client root');
  return { root, specs };
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

function pascal(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

function interfaceName(node: Namespace): string {
  return `${node.path.map(pascal).join('')}Resource`;
}

function docComment(lines: readonly string[], indent: string): string {
  const body = lines
    .flatMap((line) => line.split('\n'))
    .map((line) => line.replace(/\*\//g, '*\\/'));
  return [
    `${indent}/**`,
    ...body.map((line) => `${indent} *${line ? ` ${line}` : ''}`),
    `${indent} */`,
  ].join('\n');
}

function returnType(method: Method): string {
  const op = `Op<'${method.route.operationId}'>`;
  switch (method.spec.kind) {
    case 'json':
      return `Promise<ResponseOf<${op}>>`;
    case 'list':
      return `ListPromiseOf<${op}>`;
    case 'search':
      return `SearchPromiseOf<${op}>`;
    case 'binary':
      return 'Promise<DownloadedBytes>';
    case 'stream':
      return `AsyncGenerator<ResponseOf<${op}>>`;
  }
}

function signature(method: Method): string {
  const { spec } = method;
  const op = `Op<'${method.route.operationId}'>`;
  const args = spec.pathParams.map((name) => `${name}: string`);
  const input =
    spec.input === 'body'
      ? `BodyOf<${op}>`
      : spec.input === 'query'
        ? `QueryOf<${op}>`
        : spec.input === 'body+query'
          ? `BodyOf<${op}> & QueryOf<${op}>`
          : undefined;
  if (input !== undefined) args.push(`params${method.optionalParams ? '?' : ''}: ${input}`);
  const options =
    spec.kind === 'stream'
      ? ['StreamOptions']
      : ['RequestOptions', ...(spec.method === 'POST' ? ['IdempotencyOptions'] : [])];
  if (spec.account) options.push('AccountOptions');
  args.push(`options?: ${options.join(' & ')}`);
  return `${method.name}(${args.join(', ')}): ${returnType(method)};`;
}

function methodDoc(method: Method): string[] {
  const { route, spec } = method;
  const lines = [route.summary.endsWith('.') ? route.summary : `${route.summary}.`];
  if (route.description) lines.push('', route.description);
  lines.push('', `\`${spec.method} ${route.path}\``);
  return lines;
}

function renderInterfaces(node: Namespace, out: string[]): void {
  for (const child of node.children.values()) renderInterfaces(child, out);
  const name = node.path.length === 0 ? 'GeneratedResources' : interfaceName(node);
  const members: string[] = [];
  for (const [segment, child] of node.children) {
    members.push(`  readonly ${segment}: ${interfaceName(child)};`);
  }
  for (const method of node.methods.values()) {
    members.push(docComment(methodDoc(method), '  '), `  ${signature(method)}`);
  }
  const tags = [...new Set([...node.methods.values()].map((method) => method.route.tag))];
  const doc =
    node.path.length === 0
      ? 'Every resource namespace the route contracts declare, as the client exposes it.'
      : `${tags.length > 0 ? `${tags.join(', ')}: ` : ''}\`peable.${node.path.join('.')}\`.`;
  out.push(`${docComment([doc], '')}\nexport interface ${name} {\n${members.join('\n')}\n}`);
}

/** The generated module for `routes`, unformatted. */
export function renderResources(routes: readonly RouteContract[]): string {
  const { root, specs } = buildTree(routes);
  const interfaces: string[] = [];
  renderInterfaces(root, interfaces);
  const body = interfaces.join('\n\n');
  // Import exactly the names the signatures use: an unused import is a lint warning.
  const used = (names: readonly string[]) =>
    names.filter((name) => new RegExp(`\\b${name}\\b`).test(body));
  const contractTypes = used(['BodyOf', 'QueryOf', 'ResponseOf']);
  const coreTypes = used([
    'AccountOptions',
    'DownloadedBytes',
    'IdempotencyOptions',
    'ListPromiseOf',
    'RequestOptions',
    'SearchPromiseOf',
    'StreamOptions',
  ]);
  const coreImports = [
    'buildResourceTree',
    ...[...coreTypes, 'RouteSpec'].map((name) => `type ${name}`),
  ]
    .sort((a, b) => a.replace(/^type /, '').localeCompare(b.replace(/^type /, '')))
    .join(', ');
  return `// GENERATED by packages/sdk/scripts/generate-resources.ts from the route contracts
// of @peable.to/contracts. Do not edit: run \`bun run generate:sdk-resources\`.
//
// Strings and flags at runtime (\`ROUTE_SPECS\`); every parameter and return type
// is the contract's own (\`BodyOf\` / \`QueryOf\` / \`ResponseOf\`), imported as a type.

import type { ${[...contractTypes, 'RouteMap'].join(', ')} } from '@peable.to/contracts';
import type { GatewayClient } from '../core/client';
import { ${coreImports} } from '../core/routeMethods';

type Op<K extends keyof RouteMap> = RouteMap[K];

${body}

/** One spec per generated method. */
export const ROUTE_SPECS: readonly RouteSpec[] = ${JSON.stringify(specs)};

/** The generated namespaces, over \`client\`. \`Peable\` extends it. */
export class GeneratedClient implements GeneratedResources {
${[...root.children.keys()].map((segment) => `  readonly ${segment}: GeneratedResources['${segment}'];`).join('\n')}

  constructor(client: GatewayClient) {
    const tree = buildResourceTree<GeneratedResources>(client, ROUTE_SPECS);
${[...root.children.keys()].map((segment) => `    this.${segment} = tree.${segment};`).join('\n')}
  }
}
`;
}

/** {@link renderResources}, formatted as the repository formats TypeScript. */
export function formatResources(source: string): string {
  return execFileSync('bun', ['x', 'biome', 'format', `--stdin-file-path=${TARGET_FROM_ROOT}`], {
    cwd: REPO_ROOT,
    input: source,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
}

if (import.meta.main) {
  // The BUILT contracts — the same declarations the generated types resolve to.
  const { routes } = await import('@peable.to/contracts');
  const expected = formatResources(renderResources(routes as readonly RouteContract[]));
  if (process.argv.includes('--check')) {
    let committed = '';
    try {
      committed = readFileSync(TARGET, 'utf8');
    } catch {
      // Missing is stale.
    }
    if (committed !== expected) {
      console.error(
        `${TARGET_FROM_ROOT} is stale: the route contracts changed. Run \`bun run generate:sdk-resources\` and commit the result.`,
      );
      process.exit(1);
    }
  } else {
    writeFileSync(TARGET, expected);
  }
}
