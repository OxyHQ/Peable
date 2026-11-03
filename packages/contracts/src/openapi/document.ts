import { z } from 'zod';
import { errorEnvelopeSchema } from '../common/envelopes';
import { contractRegistry } from '../common/objects';
import { isJsonResponse, pathParamNames, type RouteContract } from '../route';
import { routes } from '../routes';
import { PEABLE_API_VERSION } from '../vocabulary/version';
import { webhookEvents } from './webhooks';

/**
 * The OpenAPI 3.1 document of the whole public API, generated from the route
 * contracts (ADR 0014 D5). Served at `/openapi.json`, committed as
 * `docs/openapi.json`, rendered into Peable's docs on oxy.so (`bun run generate:api-docs`); CI fails when the committed
 * copy drifts from this function's output.
 *
 * Every registered object becomes `#/components/schemas/<Name>` and every
 * reference to it a `$ref`. Request schemas are documented by their INPUT side
 * (what a caller sends), responses by their OUTPUT side.
 */

type JsonSchema = Record<string, unknown>;

const COMPONENT_PREFIX = '#/components/schemas/';

/** Apply the registry's documentation (`jsonSchema` replacements, `x-peable-expandable`) to a generated node. */
function override(ctx: { zodSchema: unknown; jsonSchema: JsonSchema }): void {
  const meta = contractRegistry.get(ctx.zodSchema as z.ZodType);
  const global = z.globalRegistry.get(ctx.zodSchema as z.ZodType);
  if (meta?.jsonSchema) {
    for (const key of Object.keys(ctx.jsonSchema)) delete ctx.jsonSchema[key];
    Object.assign(ctx.jsonSchema, meta.jsonSchema);
  }
  const description = meta?.description ?? global?.description;
  if (description !== undefined && ctx.jsonSchema.description === undefined)
    ctx.jsonSchema.description = description;
  if (meta?.['x-peable-expandable'] !== undefined)
    ctx.jsonSchema['x-peable-expandable'] = meta['x-peable-expandable'];
  if (meta?.examples !== undefined) ctx.jsonSchema.examples = [...meta.examples];
  // `jsonSchema`/`id` are registry bookkeeping, never document fields.
  delete ctx.jsonSchema.jsonSchema;
  delete ctx.jsonSchema.id;
}

function toJson(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    metadata: contractRegistry,
    io,
    unrepresentable: 'any',
    reused: 'inline',
    cycles: 'ref',
    override,
  }) as JsonSchema;
  delete json.$schema;
  return hoistDefinitions(json);
}

/** Every `$defs` entry produced while converting one schema, by component name. */
const collected = new Map<string, JsonSchema>();

/**
 * `z.toJSONSchema` puts the registered objects a schema reaches into its own
 * `$defs` and points at them with `#/components/schemas/<id>`; lift them into
 * the document's components once.
 */
function hoistDefinitions(json: JsonSchema): JsonSchema {
  const defs = json.$defs as Record<string, JsonSchema> | undefined;
  delete json.$defs;
  const rewritten = rewriteRefs(json) as JsonSchema;
  if (defs) {
    for (const [id, def] of Object.entries(defs)) {
      if (id.startsWith('__schema'))
        throw new Error(
          `an unregistered recursive schema produced '${id}'; register it with defineComponent`,
        );
      if (!collected.has(id)) collected.set(id, rewriteRefs(def) as JsonSchema);
    }
  }
  return rewritten;
}

/** `#/$defs/<id>` → `#/components/schemas/<id>`, everywhere in a node. */
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
      key,
      key === '$ref' && typeof inner === 'string'
        ? inner.replace(/^#\/\$defs\//, COMPONENT_PREFIX)
        : rewriteRefs(inner),
    ]),
  );
}

/** The JSON Schema of a registered component, or the inline one. */
function schemaRef(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const id = contractRegistry.get(schema)?.id;
  if (id !== undefined) {
    if (!collected.has(id)) {
      // A registered root converts to a `$ref` plus its own definition in
      // `$defs`, which `hoistDefinitions` has just collected under `id`.
      const json = toJson(schema, io);
      if (!collected.has(id)) {
        delete json.$id;
        collected.set(id, json);
      }
    }
    return { $ref: `${COMPONENT_PREFIX}${id}` };
  }
  return toJson(schema, io);
}

const requestIdHeader = {
  'Request-Id': {
    description: 'Identifies this request to Peable support.',
    schema: { type: 'string' },
  },
  'Peable-Version': {
    description: 'The date of the wire this answer is spelled in.',
    schema: { type: 'string', example: PEABLE_API_VERSION },
  },
} as const;

const SECURITY: Record<RouteContract['auth'], unknown[]> = {
  service: [{ oxyServiceToken: [] }],
  user: [{ oxyUserSession: [] }],
  public: [],
};

/** A query schema's properties as OpenAPI parameters. */
function queryParameters(query: z.ZodType): unknown[] {
  const json = toJson(query, 'input');
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, schema]) => {
    const { description, ...rest } = schema;
    const isArray = rest.type === 'array';
    const isObject = rest.type === 'object' || Array.isArray(rest.oneOf);
    return {
      in: 'query',
      name: isArray ? `${name}[]` : name,
      ...(required.has(name) ? { required: true } : {}),
      ...(description === undefined ? {} : { description }),
      ...(isObject ? { style: 'deepObject', explode: true } : {}),
      schema: rest,
    };
  });
}

function operation(route: RouteContract): JsonSchema {
  const parameters: unknown[] = pathParamNames(route.path).map((name) => ({
    in: 'path',
    name,
    required: true,
    ...(route.params?.[name] === undefined ? {} : { description: route.params[name] }),
    schema: { type: 'string' },
  }));
  if (route.query) parameters.push(...queryParameters(route.query));
  if (route.idempotent)
    parameters.push({
      in: 'header',
      name: 'Idempotency-Key',
      description:
        'Makes a retry safe: the same key with the same request answers the stored response for 24 hours (ADR 0014 D3). The SDK sends one on every POST.',
      schema: { type: 'string', maxLength: 255 },
    });
  if (route.peableAccount)
    parameters.push({
      in: 'header',
      name: 'Peable-Account',
      description: 'A platform acting on one of its connected accounts (`ca_…`).',
      schema: { type: 'string' },
    });
  parameters.push({
    in: 'header',
    name: 'Peable-Version',
    description: `The wire date the caller was written against. Only \`${PEABLE_API_VERSION}\` exists.`,
    schema: { type: 'string', enum: [PEABLE_API_VERSION] },
  });

  const status = String(route.status ?? 200);
  const response = route.response;
  let content: JsonSchema | undefined;
  if (isJsonResponse(response)) {
    content = { 'application/json': { schema: schemaRef(response, 'output') } };
  } else if (response.kind === 'binary') {
    content = { [response.contentType]: { schema: { type: 'string', format: 'binary' } } };
  } else {
    content = {
      'text/event-stream': {
        schema: { type: 'string' },
        'x-peable-event': schemaRef(response.event, 'output'),
      },
    };
  }

  return {
    operationId: route.operationId,
    tags: [route.tag],
    summary: route.summary,
    ...(route.description === undefined ? {} : { description: route.description }),
    security: SECURITY[route.auth],
    ...(route.scope === undefined ? {} : { 'x-peable-scope': route.scope }),
    ...(route.sdk === undefined ? {} : { 'x-peable-sdk': route.sdk }),
    ...(route.expandable === undefined ? {} : { 'x-peable-expandable': route.expandable }),
    ...(route.testModeOnly ? { 'x-peable-test-mode-only': true } : {}),
    parameters,
    ...(route.body
      ? {
          requestBody: {
            required: true,
            content: {
              [route.bodyEncoding === 'multipart' ? 'multipart/form-data' : 'application/json']: {
                schema: toJson(route.body, 'input'),
              },
            },
          },
        }
      : {}),
    responses: {
      [status]: {
        description: 'Success',
        headers: requestIdHeader,
        ...(status === '204' ? {} : { content }),
      },
      default: {
        description: 'The error envelope; the HTTP status and `error.type` identify the failure.',
        headers: requestIdHeader,
        content: { 'application/json': { schema: schemaRef(errorEnvelopeSchema, 'output') } },
      },
    },
  };
}

/** Sort an object's keys, recursively, so the document is byte-stable. */
function sortKeys(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>);
  // Only component and path maps are sorted: a schema's own key order (type
  // before properties) reads better as generated.
  return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v, depth + 1)]));
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: Record<string, unknown>;
  servers: { url: string; description: string }[];
  tags: { name: string }[];
  paths: Record<string, Record<string, unknown>>;
  webhooks: Record<string, unknown>;
  components: Record<string, unknown>;
}

/** Generate the whole document. Pure: the same contracts give the same bytes. */
export function buildOpenApiDocument(): OpenApiDocument {
  collected.clear();
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();
  for (const route of routes as readonly RouteContract[]) {
    paths[route.path] ??= {};
    const methods = paths[route.path] as Record<string, unknown>;
    if (methods[route.method] !== undefined)
      throw new Error(`${route.method.toUpperCase()} ${route.path} is declared twice`);
    methods[route.method] = operation(route);
    tags.add(route.tag);
  }
  const webhooks: Record<string, unknown> = {};
  for (const event of webhookEvents()) {
    webhooks[event.type] = {
      post: {
        operationId: `webhook_${event.type.replace(/[^a-z0-9]+/g, '_')}`,
        summary: event.type,
        ...(event.description === undefined ? {} : { description: event.description }),
        tags: ['Webhook events'],
        parameters: [
          {
            in: 'header',
            name: 'Peable-Signature',
            required: true,
            description:
              '`t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, one `v1=` per active secret while a secret is rolling. Verify with `peable.webhooks.constructEvent`.',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: schemaRef(event.schema, 'output') } },
        },
        responses: { '2XX': { description: 'Acknowledged. Anything else is retried.' } },
      },
    };
    tags.add('Webhook events');
  }

  const schemas = Object.fromEntries(
    [...collected.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  return sortKeys({
    openapi: '3.1.0',
    info: {
      title: 'Peable API',
      version: PEABLE_API_VERSION,
      description:
        'The Peable payments API (Orbit): FairCoin and card payments, Checkout, Payment Links, Billing, Connect and Tax. Amounts are base-unit integer strings; instants are Unix seconds; every object carries `id`, `object` and `livemode`. Guides: https://oxy.so/developers/docs/peable/.',
      contact: { name: 'Peable', url: 'https://oxy.so/developers/docs/peable/' },
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: 'https://api.peable.to', description: 'Production (test and live modes)' }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    webhooks: Object.fromEntries(Object.entries(webhooks).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      securitySchemes: {
        oxyServiceToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Oxy service token (EdDSA JWT)',
          description:
            "Your server's Oxy service token, minted from its application credential. `@peable.to/sdk` mints and refreshes it for you.",
        },
        oxyUserSession: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Oxy user session',
          description: 'A signed-in Oxy user (the Peable app, an Oxy app acting for its user).',
        },
      },
      schemas,
    },
  }) as OpenApiDocument;
}
