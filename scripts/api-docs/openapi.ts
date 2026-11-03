// The API reference, rendered as MDX from the committed OpenAPI 3.1 document
// (`docs/openapi.json`, generated from `packages/contracts`).
//
// Generic on purpose: it renders whatever the document holds — every tag,
// operation, component and webhook — and knows nothing about any one resource.
// A route added to the contracts appears in the reference the next time
// `bun run generate:api-docs` runs, and `--check` fails CI until it has. The
// only vocabulary read beyond OpenAPI is Peable's extensions: `x-peable-sdk`,
// `x-peable-scope`, `x-peable-expandable`, `x-peable-test-mode-only` and
// `x-peable-event` on a stream.

import { cell, code, fence, frontMatter, Headings, table, text } from './mdx';

export interface Schema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  examples?: unknown[];
  'x-peable-expandable'?: string;
  [key: string]: unknown;
}

export interface Parameter {
  in: 'path' | 'query' | 'header' | 'cookie';
  name: string;
  required?: boolean;
  description?: string;
  schema?: Schema;
}

interface MediaType {
  schema?: Schema;
  'x-peable-event'?: Schema;
}

interface Response {
  description?: string;
  content?: Record<string, MediaType>;
}

export interface Operation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, MediaType> };
  responses?: Record<string, Response>;
  'x-peable-scope'?: string;
  'x-peable-sdk'?: string;
  'x-peable-expandable'?: string;
  'x-peable-test-mode-only'?: boolean;
}

interface SecurityScheme {
  type: string;
  scheme?: string;
  bearerFormat?: string;
  description?: string;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: { url: string; description?: string }[];
  tags?: { name: string; description?: string }[];
  paths?: Record<string, Record<string, Operation>>;
  webhooks?: Record<string, Record<string, Operation>>;
  security?: Record<string, string[]>[];
  components?: {
    schemas?: Record<string, Schema>;
    securitySchemes?: Record<string, SecurityScheme>;
  };
}

// ── Addresses ────────────────────────────────────────────────────────────────

/** Where the reference lives under the docs root, as a directory and a link. */
export const REFERENCE_DIR = 'reference';
const REFERENCE = `/${REFERENCE_DIR}`;
const COMPONENT_PREFIX = '#/components/schemas/';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
/** The tag the contracts' generator files every webhook event under. */
export const WEBHOOK_TAG = 'Webhook events';
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** Where the reference sits in the docs sidebar, after the guides. */
const REFERENCE_ORDER = 900;

/** `Payment methods` → `payment-methods`. */
export function tagSlug(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** `DeletedCustomer` → `deleted-customer`. */
export function objectSlug(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

export function objectLink(name: string): string {
  return `${REFERENCE}/objects/${objectSlug(name)}`;
}

export function tagLink(tag: string): string {
  return `${REFERENCE}/${tagSlug(tag)}`;
}

/** The component a `$ref` names, or undefined for anything but a local component. */
export function refName(ref: string): string | undefined {
  return ref.startsWith(COMPONENT_PREFIX) ? ref.slice(COMPONENT_PREFIX.length) : undefined;
}

/** Double quotes would end a front-matter value the site's parser reads verbatim. */
function plain(value: string): string {
  return value.replace(/"/g, "'").replace(/`/g, '');
}

// ── The document as entries ─────────────────────────────────────────────────

export interface Entry {
  kind: 'operation' | 'webhook';
  /** `post` */
  method: string;
  /** `/v1/customers/{id}`, or the event type of a webhook. */
  path: string;
  operation: Operation;
}

function entriesOf(
  map: Record<string, Record<string, Operation>> | undefined,
  kind: Entry['kind'],
): Entry[] {
  const out: Entry[] = [];
  for (const [path, item] of Object.entries(map ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (HTTP_METHODS.includes(method)) out.push({ kind, method, path, operation });
    }
  }
  return out;
}

export function allEntries(doc: OpenApiDocument): Entry[] {
  return [...entriesOf(doc.paths, 'operation'), ...entriesOf(doc.webhooks, 'webhook')];
}

function tagsOf(entry: Entry): string[] {
  const tags = entry.operation.tags ?? [];
  if (tags.length > 0) return tags;
  return [entry.kind === 'webhook' ? WEBHOOK_TAG : 'Other'];
}

/** What an entry's heading says: its summary, or the event type of a webhook. */
function entryTitle(entry: Entry): string {
  if (entry.kind === 'webhook') return code(entry.path);
  return entry.operation.summary ?? `${entry.method.toUpperCase()} ${entry.path}`;
}

export interface TagGroup {
  tag: string;
  slug: string;
  /** Each entry with its heading on the tag page — the anchor every link to it uses. */
  entries: { entry: Entry; heading: { markdown: string; anchor: string } }[];
  /** The page's h1. */
  title: { markdown: string; anchor: string };
}

/**
 * Every tag with its entries and their anchors, in the document's tag order
 * (then any tag an operation names that the list omits). The webhook tag is
 * always present, so the reference has an events page before the contracts
 * declare one.
 */
export function tagGroups(doc: OpenApiDocument): TagGroup[] {
  const order = (doc.tags ?? []).map((t) => t.name);
  const groups = new Map<string, Entry[]>(order.map((name) => [name, []]));
  for (const entry of allEntries(doc)) {
    for (const tag of tagsOf(entry)) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag)?.push(entry);
    }
  }
  if (!groups.has(WEBHOOK_TAG)) groups.set(WEBHOOK_TAG, []);
  const named = [...groups.entries()].filter(
    ([tag, entries]) => tag !== WEBHOOK_TAG && entries.length > 0,
  );
  named.push([WEBHOOK_TAG, groups.get(WEBHOOK_TAG) ?? []]);
  return named.map(([tag, entries]) => {
    const headings = new Headings();
    const title = headings.add(1, tag);
    return {
      tag,
      slug: tagSlug(tag),
      title,
      entries: entries.map((entry) => ({ entry, heading: headings.add(2, entryTitle(entry)) })),
    };
  });
}

function schemas(doc: OpenApiDocument): Record<string, Schema> {
  return doc.components?.schemas ?? {};
}

/** `customer` → `Customer`: the component whose `object` is that constant. */
export function objectsByType(doc: OpenApiDocument): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, schema] of Object.entries(schemas(doc))) {
    const type = schema.properties?.object?.const;
    if (typeof type === 'string' && !out.has(type)) out.set(type, name);
  }
  return out;
}

// ── Schemas as text ─────────────────────────────────────────────────────────

function branches(node: Schema): Schema[] | undefined {
  return node.anyOf ?? node.oneOf ?? node.allOf;
}

function scalar(type: string, node: Schema): string {
  if (type === 'string' && node.format) return `string (${node.format})`;
  return type;
}

/** The type of a node, as parts of a union. `$ref`s are links to their object page. */
function typeParts(node: Schema): string[] {
  if (node.$ref) {
    const name = refName(node.$ref);
    return [name ? `[${name}](${objectLink(name)})` : code(node.$ref)];
  }
  if (node.const !== undefined) return [code(JSON.stringify(node.const))];
  const union = branches(node);
  if (union) return [...new Set(union.flatMap(typeParts))];
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  if (types.length === 0) {
    if (node.enum && node.enum.length > 0) return [typeof node.enum[0]];
    if (node.properties) return ['object'];
    return ['any'];
  }
  return types.map((type) => {
    if (type === 'array') {
      const items = node.items ? typeParts(node.items) : [];
      return items.length === 0 ? 'array' : `array of ${items.join(' or ')}`;
    }
    if (type === 'object' && !node.properties && typeof node.additionalProperties === 'object') {
      return `map of ${typeParts(node.additionalProperties).join(' or ')}`;
    }
    return scalar(type, node);
  });
}

export function typeLabel(node: Schema): string {
  return typeParts(node).join(' | ');
}

/** Every node a union reaches, outermost first. */
function layers(node: Schema): Schema[] {
  const union = branches(node);
  return union ? [node, ...union.flatMap(layers)] : [node];
}

function constraints(node: Schema): string[] {
  const out: string[] = [];
  const { minLength: lo, maxLength: hi } = node;
  if (lo !== undefined && hi !== undefined)
    out.push(lo === hi ? `Exactly ${lo} characters.` : `${lo}–${hi} characters.`);
  else if (hi !== undefined) out.push(`At most ${hi} characters.`);
  else if (lo !== undefined && lo > 1) out.push(`At least ${lo} characters.`);
  const { minimum: min, maximum: max } = node;
  const hasMax = max !== undefined && max !== MAX_SAFE;
  if (min !== undefined && hasMax) out.push(`Between ${min} and ${max}.`);
  else if (hasMax) out.push(`At most ${max}.`);
  else if (min !== undefined && min !== 0) out.push(`At least ${min}.`);
  if (node.maxItems !== undefined) out.push(`At most ${node.maxItems} items.`);
  if (node.minItems !== undefined && node.minItems > 0)
    out.push(`At least ${node.minItems} item${node.minItems === 1 ? '' : 's'}.`);
  if (node.pattern && !node.format && node.pattern.length <= 60)
    out.push(`Matches ${code(node.pattern)}.`);
  if (node.default !== undefined) out.push(`Default ${code(JSON.stringify(node.default))}.`);
  return out;
}

/** The description cell of a field: its prose, its values, its limits, whether it expands. */
function describe(node: Schema): string {
  const all = layers(node);
  const parts: string[] = [];
  const description = all.find((layer) => layer.description)?.description;
  if (description) parts.push(description);
  const values = [...new Set(all.flatMap((layer) => layer.enum ?? []))].map((value) =>
    code(String(value)),
  );
  // A description that already names every value says it better than a list.
  if (values.length > 0 && !values.every((value) => description?.includes(value)))
    parts.push(`One of ${values.join(', ')}.`);
  for (const layer of all) parts.push(...constraints(layer));
  if (all.some((layer) => layer['x-peable-expandable'])) parts.push('Expandable.');
  return parts.join(' ');
}

interface Row {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

type Notation = 'dot' | 'bracket';

function childName(prefix: string, name: string, notation: Notation): string {
  if (prefix === '') return name;
  return notation === 'dot' ? `${prefix}.${name}` : `${prefix}[${name}]`;
}

/**
 * The fields of an object node, nested inline objects flattened into paths:
 * dot paths for what Peable answers (the spelling of `expand[]`), bracket
 * notation for what a caller sends (the spelling of `error.param`).
 */
function fieldRows(
  node: Schema,
  notation: Notation,
  prefix = '',
  depth = 0,
  rows: Row[] = [],
): Row[] {
  const required = new Set(node.required ?? []);
  for (const [name, property] of Object.entries(node.properties ?? {})) {
    const path = childName(prefix, name, notation);
    rows.push({
      name: path,
      type: typeLabel(property),
      required: required.has(name),
      description: describe(property),
    });
    if (depth >= 8) continue;
    for (const layer of layers(property)) {
      if (layer.$ref) continue;
      if (layer.properties) fieldRows(layer, notation, path, depth + 1, rows);
      else if (layer.items?.properties && !layer.items.$ref)
        fieldRows(layer.items, notation, `${path}[]`, depth + 1, rows);
    }
  }
  return rows;
}

function fieldTable(rows: Row[], showRequired: boolean): string {
  return table(
    ['Field', 'Type', 'Description'],
    rows.map((row) => [
      `${code(row.name)}${showRequired && row.required ? ' **required**' : ''}`,
      cell(row.type),
      cell(row.description),
    ]),
  );
}

/** A schema as MDX: a link for a `$ref`, a field table for an inline object. */
function schemaBlock(schema: Schema, notation: Notation, showRequired: boolean): string {
  if (schema.$ref || !schema.properties) {
    const description = describe(schema);
    return [`Type: ${text(typeLabel(schema))}`, description ? text(description) : '']
      .filter(Boolean)
      .join('\n\n');
  }
  const parts: string[] = [];
  if (schema.description) parts.push(text(schema.description));
  parts.push(fieldTable(fieldRows(schema, notation), showRequired));
  return parts.join('\n\n');
}

// ── Expandable fields ───────────────────────────────────────────────────────

export interface Expandable {
  path: string;
  type: string;
}

/** Every field of a schema that `expand[]` can replace with its object (no `$ref` is followed). */
export function expandableFields(node: Schema, prefix = '', depth = 0): Expandable[] {
  const out: Expandable[] = [];
  for (const [name, property] of Object.entries(node.properties ?? {})) {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    const all = layers(property);
    const expandable = all.find((layer) => layer['x-peable-expandable'])?.['x-peable-expandable'];
    if (expandable) {
      out.push({ path, type: expandable });
      continue;
    }
    if (depth >= 8) continue;
    for (const layer of all) {
      if (layer.$ref) continue;
      if (layer.properties) out.push(...expandableFields(layer, path, depth + 1));
      else if (layer.items?.properties && !layer.items.$ref)
        out.push(...expandableFields(layer.items, path, depth + 1));
    }
  }
  return out;
}

function resolve(doc: OpenApiDocument, node: Schema): Schema {
  const name = node.$ref ? refName(node.$ref) : undefined;
  return name ? (schemas(doc)[name] ?? node) : node;
}

function expandableList(doc: OpenApiDocument, fields: Expandable[], prefix = ''): string {
  const byType = objectsByType(doc);
  return fields
    .map(({ path, type }) => {
      const name = byType.get(type);
      return `- ${code(prefix + path)} → ${name ? `[${name}](${objectLink(name)})` : code(type)}`;
    })
    .join('\n');
}

// ── Operations ──────────────────────────────────────────────────────────────

const PUBLIC_AUTH =
  'None. A payer-facing route, authorised by the unguessable id or client secret it is called with.';

function schemeLabel(doc: OpenApiDocument, name: string): string {
  return doc.components?.securitySchemes?.[name]?.bearerFormat ?? name;
}

/** The index page's headings, so an operation can link to its security scheme. */
function indexHeadings(doc: OpenApiDocument) {
  const headings = new Headings();
  const title = headings.add(1, 'API reference');
  const servers = doc.servers && doc.servers.length > 0 ? headings.add(2, 'Base URL') : undefined;
  const schemeNames = Object.keys(doc.components?.securitySchemes ?? {});
  const authentication = schemeNames.length > 0 ? headings.add(2, 'Authentication') : undefined;
  const schemes = new Map(
    schemeNames.map((name) => [name, headings.add(3, schemeLabel(doc, name))]),
  );
  return {
    title,
    servers,
    authentication,
    schemes,
    resources: headings.add(2, 'Resources'),
    objects: headings.add(2, 'Objects'),
    errors: headings.add(2, 'Errors'),
  };
}

function securityLabel(doc: OpenApiDocument, operation: Operation): string {
  const requirements = operation.security ?? doc.security;
  if (requirements === undefined) return 'Not stated.';
  if (requirements.length === 0) return PUBLIC_AUTH;
  const anchors = indexHeadings(doc).schemes;
  return requirements
    .map((requirement) =>
      Object.keys(requirement)
        .map((name) => {
          const anchor = anchors.get(name)?.anchor;
          const label = text(schemeLabel(doc, name));
          return anchor ? `[${label}](${REFERENCE}#${anchor})` : label;
        })
        .join(' and '),
    )
    .join(', or ');
}

function successResponses(operation: Operation): [string, Response][] {
  return Object.entries(operation.responses ?? {}).filter(([status]) => /^2/.test(status));
}

/** A list or search envelope: `{ object: 'list' | 'search_result', data: [...] }`. */
function envelopeItems(schema: Schema): { kind: string; items: Schema } | undefined {
  const kind = schema.properties?.object?.const;
  const items = schema.properties?.data?.items;
  if (typeof kind === 'string' && schema.properties?.data?.type === 'array' && items)
    return { kind, items };
  return undefined;
}

function firstExample(doc: OpenApiDocument, node: Schema): unknown {
  for (const layer of layers(node)) {
    const resolved = resolve(doc, layer);
    if (resolved.examples && resolved.examples.length > 0) return resolved.examples[0];
  }
  return undefined;
}

function json(value: unknown): string {
  return fence('json', JSON.stringify(value, null, 2));
}

function responseSchemaBlock(doc: OpenApiDocument, path: string, schema: Schema): string {
  const envelope = envelopeItems(schema);
  if (envelope) {
    const noun = envelope.kind === 'search_result' ? 'A search result' : 'A list';
    const parts = [
      `${noun} (${code(`object: "${envelope.kind}"`)}) whose ${code('data')} holds ${text(typeLabel(envelope.items))} objects, newest first.`,
      fieldTable(fieldRows(schema, 'dot'), false),
    ];
    const example = firstExample(doc, envelope.items);
    if (example !== undefined) {
      const sample: Record<string, unknown> = { object: envelope.kind, data: [example] };
      sample.has_more = false;
      if (schema.properties?.next_page) sample.next_page = null;
      if (schema.properties?.url) sample.url = path;
      parts.push(json(sample));
    }
    return parts.join('\n\n');
  }
  const union = branches(schema);
  if (schema.$ref || (union?.every((branch) => branch.$ref) ?? false)) {
    const parts = [`Returns ${text(typeLabel(schema).replace(/ \| /g, ' or '))}.`];
    const example = firstExample(doc, schema);
    if (example !== undefined) parts.push(json(example));
    return parts.join('\n\n');
  }
  return schemaBlock(schema, 'dot', false);
}

function responseBlock(
  doc: OpenApiDocument,
  path: string,
  status: string,
  response: Response,
): string {
  const parts = [`**Response ${code(status)}**`];
  const content = Object.entries(response.content ?? {});
  if (content.length === 0) {
    parts.push(status === '204' ? 'No content.' : text(response.description ?? 'No content.'));
    return parts.join('\n\n');
  }
  for (const [type, media] of content) {
    if (type === 'text/event-stream') {
      const event = media['x-peable-event'];
      parts.push(
        `A Server-Sent Events stream (${code(type)})${event ? `; each event's ${code('data')} is ${text(typeLabel(event))}` : ''}.`,
      );
    } else if (type === 'application/json' && media.schema) {
      parts.push(responseSchemaBlock(doc, path, media.schema));
    } else {
      parts.push(`The bytes, as ${code(type)}.`);
    }
  }
  return parts.join('\n\n');
}

function parameterTable(parameters: Parameter[]): string {
  return table(
    ['Name', 'In', 'Type', 'Description'],
    parameters.flatMap((parameter) => {
      const schema = parameter.schema ?? {};
      const head = [
        `${code(parameter.name)}${parameter.required ? ' **required**' : ''}`,
        parameter.in,
        cell(typeLabel(schema)),
        cell(describe({ ...schema, description: parameter.description ?? schema.description })),
      ];
      // A deepObject parameter (`created[gte]`) lists its keys too.
      const base = parameter.name.replace(/\[\]$/, '');
      const children = layers(schema)
        .filter((layer) => layer.properties && !layer.$ref)
        .flatMap((layer) => fieldRows(layer, 'bracket', base))
        .map((row) => [code(row.name), parameter.in, cell(row.type), cell(row.description)]);
      return [head, ...children];
    }),
  );
}

function operationSection(
  doc: OpenApiDocument,
  entry: Entry,
  heading: { markdown: string },
): string {
  const { operation } = entry;
  const parts: string[] = [heading.markdown];
  if (entry.kind === 'operation') parts.push(code(`${entry.method.toUpperCase()} ${entry.path}`));
  if (operation.description) parts.push(text(operation.description));

  if (entry.kind === 'operation') {
    const facts: [string, string][] = [['Authentication', securityLabel(doc, operation)]];
    if (operation['x-peable-scope']) facts.push(['Scope', code(operation['x-peable-scope'])]);
    if (operation['x-peable-sdk'])
      facts.push(['SDK', code(`peable.${operation['x-peable-sdk']}()`)]);
    if (operation['x-peable-test-mode-only'])
      facts.push([
        'Mode',
        `Test mode only: a live credential is refused with [${code('test_mode_only')}](/errors#test_mode_only).`,
      ]);
    parts.push(facts.map(([label, value]) => `- **${label}:** ${value}`).join('\n'));
  }

  const parameters = operation.parameters ?? [];
  if (parameters.length > 0) parts.push('**Parameters**', parameterTable(parameters));

  for (const [type, media] of Object.entries(operation.requestBody?.content ?? {})) {
    if (!media.schema) continue;
    parts.push(`**${entry.kind === 'webhook' ? 'Payload' : 'Request body'}** (${code(type)})`);
    parts.push(
      entry.kind === 'webhook'
        ? responseSchemaBlock(doc, entry.path, media.schema)
        : schemaBlock(media.schema, 'bracket', true),
    );
  }

  if (entry.kind === 'operation') {
    for (const [status, response] of successResponses(operation))
      parts.push(responseBlock(doc, entry.path, status, response));
    const root = operation['x-peable-expandable'];
    const rootName = root ? objectsByType(doc).get(root) : undefined;
    const fields = rootName ? expandableFields(schemas(doc)[rootName] ?? {}) : [];
    if (fields.length > 0) {
      const isList = successResponses(operation).some(([, response]) => {
        const schema = response.content?.['application/json']?.schema;
        return schema ? envelopeItems(schema) !== undefined : false;
      });
      parts.push(
        `**Expandable** with ${code('expand[]')} (dot paths chain into an expanded object's own fields, at most four levels):`,
        expandableList(doc, fields, isList ? 'data.' : ''),
      );
    }
    if (Object.keys(operation.responses ?? {}).includes('default'))
      parts.push(
        `Errors answer the error envelope with the HTTP status and ${code('error.type')} of the failure ([error codes](/errors)).`,
      );
  }
  return parts.join('\n\n');
}

// ── Pages ───────────────────────────────────────────────────────────────────

export interface Page {
  /** The file, relative to the docs root: `reference/customers.mdx`. */
  file: string;
  /** The link the docs site resolves to it: `/reference/customers`. */
  link: string;
  title: string;
  content: string;
}

const SOURCE = 'docs/openapi.json';

function page(
  file: string,
  meta: { title: string; description?: string; order: number },
  body: string[],
): Page {
  return {
    file: `${file}.mdx`,
    link: `/${file}`,
    title: meta.title,
    content: `${[
      frontMatter({
        title: plain(meta.title),
        ...(meta.description ? { description: plain(meta.description) } : {}),
        order: meta.order,
        generatedFrom: SOURCE,
      }),
      ...body,
    ].join('\n\n')}\n`,
  };
}

/** One line for the page's table: the summary, unless it only repeats the event type. */
function summaryOf(entry: Entry): string {
  const { summary, description } = entry.operation;
  if (summary && summary !== entry.path) return summary;
  return description?.split(/(?<=\.)\s/)[0] ?? summary ?? '';
}

function method(entry: Entry): string {
  return entry.kind === 'webhook' ? 'event' : entry.method.toUpperCase();
}

function tagPage(doc: OpenApiDocument, group: TagGroup, order: number): Page {
  const description = doc.tags?.find((t) => t.name === group.tag)?.description;
  const parts: string[] = [group.title.markdown];
  if (description) parts.push(text(description));
  if (group.tag === WEBHOOK_TAG) {
    parts.push(
      `Every event Peable sends to a [webhook endpoint](/webhooks), and records as an event you can list for 30 days. Each delivery is a ${code('POST')} of the event envelope, signed in ${code('Peable-Signature')}; ${code('data.object')} is the object the event is about, exactly as the API returns it.`,
    );
    if (group.entries.length === 0)
      parts.push(
        'This version of the reference declares no event types yet. The [webhooks guide](/webhooks) describes the envelope and the events in use.',
      );
  }
  if (group.entries.length > 0) {
    parts.push(
      table(
        [group.tag === WEBHOOK_TAG ? 'Event' : 'Endpoint', 'Summary'],
        group.entries.map(({ entry, heading }) => [
          `[${code(entry.kind === 'webhook' ? entry.path : `${method(entry)} ${entry.path}`)}](#${heading.anchor})`,
          cell(summaryOf(entry)),
        ]),
      ),
    );
  }
  for (const { entry, heading } of group.entries) parts.push(operationSection(doc, entry, heading));
  return page(
    `${REFERENCE_DIR}/${group.slug}`,
    {
      title: group.tag,
      description:
        group.tag === WEBHOOK_TAG
          ? 'Every webhook event type and its payload.'
          : `The ${group.tag} endpoints of the Peable API.`,
      order,
    },
    parts,
  );
}

function indexPage(doc: OpenApiDocument, groups: TagGroup[]): Page {
  const h = indexHeadings(doc);
  const parts: string[] = [h.title.markdown];
  if (doc.info.description) parts.push(text(doc.info.description));
  parts.push(
    `Version ${code(doc.info.version)} of the ${text(doc.info.title)} (OpenAPI ${text(doc.openapi)}), sent as ${code('Peable-Version')} on every answer. Every page here is generated from the [OpenAPI document](https://github.com/OxyHQ/Peable/blob/main/docs/openapi.json), which is generated from the route contracts the gateway validates with, so the reference and the API cannot disagree.`,
  );
  if (h.servers && doc.servers) {
    parts.push(h.servers.markdown);
    parts.push(
      table(
        ['URL', 'Description'],
        doc.servers.map((server) => [code(server.url), cell(server.description ?? '')]),
      ),
    );
  }
  if (h.authentication) {
    parts.push(h.authentication.markdown);
    parts.push(
      `Every request carries ${code('Authorization: Bearer <token>')}. Each operation names the token it takes; routes with none are payer-facing. Credentials are in the [quickstart](/quickstart).`,
    );
    for (const [name, scheme] of Object.entries(doc.components?.securitySchemes ?? {})) {
      const heading = h.schemes.get(name);
      if (heading) parts.push(heading.markdown);
      parts.push(
        [
          `${code(name)}: ${text(scheme.type)}${scheme.scheme ? ` ${text(scheme.scheme)}` : ''}.`,
          scheme.description ? text(scheme.description) : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    }
  }
  parts.push(h.resources.markdown);
  parts.push(
    table(
      ['Section', 'Operations'],
      groups.map((group) => [
        `[${text(group.tag)}](${tagLink(group.tag)})`,
        String(group.entries.length),
      ]),
    ),
  );
  const names = Object.keys(schemas(doc));
  parts.push(h.objects.markdown);
  parts.push(
    names.length > 0
      ? names.map((name) => `[${name}](${objectLink(name)})`).join(' · ')
      : 'This version of the reference declares no objects yet.',
  );
  parts.push(h.errors.markdown);
  parts.push('Every error type and code, with what it means, is in [error codes](/errors).');
  return page(
    REFERENCE_DIR,
    {
      title: 'API reference',
      description: `Every endpoint, object and webhook event of the Peable API, version ${doc.info.version}.`,
      order: REFERENCE_ORDER,
    },
    parts,
  );
}

function mentions(node: unknown, ref: string): boolean {
  return JSON.stringify(node ?? null).includes(`"$ref":"${ref}"`);
}

function objectPage(doc: OpenApiDocument, groups: TagGroup[], name: string, schema: Schema): Page {
  const ref = `${COMPONENT_PREFIX}${name}`;
  const headings = new Headings();
  const parts: string[] = [headings.add(1, name).markdown];
  if (schema.description) parts.push(text(schema.description));
  const type = schema.properties?.object?.const;
  if (typeof type === 'string') parts.push(`Object type: ${code(type)}.`);

  if (schema.properties) {
    parts.push(headings.add(2, 'Attributes').markdown);
    parts.push(fieldTable(fieldRows(schema, 'dot'), false));
  } else {
    parts.push(headings.add(2, 'Type').markdown);
    parts.push(schemaBlock(schema, 'dot', false));
  }

  const fields = expandableFields(schema);
  if (fields.length > 0) {
    parts.push(headings.add(2, 'Expandable fields').markdown);
    parts.push(
      `Each is an id unless you ask for the object with ${code('expand[]')}; expansion resolves inside your own account.`,
    );
    parts.push(expandableList(doc, fields));
  }

  const example = schema.examples?.[0];
  if (example !== undefined) {
    parts.push(headings.add(2, 'Example').markdown);
    parts.push(json(example));
  }

  const returnedBy = groups.flatMap((group) =>
    group.entries
      .filter(
        ({ entry }) =>
          entry.kind === 'operation' &&
          successResponses(entry.operation).some(([, response]) => mentions(response.content, ref)),
      )
      .map((item) => ({ group, ...item })),
  );
  if (returnedBy.length > 0) {
    parts.push(headings.add(2, 'Returned by').markdown);
    parts.push(
      returnedBy
        .map(
          ({ group, entry, heading }) =>
            `- [${code(`${entry.method.toUpperCase()} ${entry.path}`)}](${tagLink(group.tag)}#${heading.anchor}) — ${text(entry.operation.summary ?? '')}`,
        )
        .join('\n'),
    );
  }
  const events = groups.flatMap((group) =>
    group.entries
      .filter(({ entry }) => entry.kind === 'webhook' && mentions(entry.operation.requestBody, ref))
      .map((item) => ({ group, ...item })),
  );
  if (events.length > 0) {
    parts.push(headings.add(2, 'Events').markdown);
    parts.push(
      events
        .map(
          ({ group, entry, heading }) =>
            `- [${code(entry.path)}](${tagLink(group.tag)}#${heading.anchor})`,
        )
        .join('\n'),
    );
  }
  const usedIn = Object.entries(schemas(doc))
    .filter(([other, node]) => other !== name && mentions(node, ref))
    .map(([other]) => `[${other}](${objectLink(other)})`);
  if (usedIn.length > 0) {
    parts.push(headings.add(2, 'Used in').markdown);
    parts.push(usedIn.join(' · '));
  }
  return page(
    `${REFERENCE_DIR}/objects/${objectSlug(name)}`,
    {
      title: name,
      description:
        typeof type === 'string'
          ? `The ${code(type)} object: its attributes, expandable fields and an example.`
          : `The ${name} shape of the Peable API.`,
      order: REFERENCE_ORDER + 500,
    },
    parts,
  );
}

/** Every reference page: the index, one per tag, one per component. */
export function referencePages(doc: OpenApiDocument): Page[] {
  const groups = tagGroups(doc);
  const pages = [
    indexPage(doc, groups),
    ...groups.map((group, index) => tagPage(doc, group, REFERENCE_ORDER + 1 + index)),
    ...Object.entries(schemas(doc)).map(([name, schema]) => objectPage(doc, groups, name, schema)),
  ];
  const seen = new Set<string>([`${REFERENCE_DIR}/objects.mdx`]);
  for (const generated of pages) {
    if (seen.has(generated.file))
      throw new Error(`two reference pages would be ${generated.file} ("${generated.title}")`);
    seen.add(generated.file);
  }
  return pages;
}
