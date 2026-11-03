import { z } from 'zod';
import { contractRegistry } from './objects';

/**
 * Request-side building blocks (ADR 0014 D1).
 *
 * A request schema has two sides and both matter:
 *
 * - its INPUT (`z.input`) is the wire — what a caller sends, what the SDK's
 *   parameter types are, and what the OpenAPI document describes;
 * - its OUTPUT (`z.output`) is what a backend handler receives once parsed —
 *   a query integer as a `number`, `expand` always an array, a metadata update
 *   as a `{ set, unset }` patch.
 *
 * So the transforms live HERE, beside the shape, and the backend never
 * re-parses what a contract already decided.
 */

/** Attach the JSON Schema a node is documented with when its input side is not the wire's spelling. */
function documentedAs<T extends z.ZodType>(schema: T, jsonSchema: Record<string, unknown>): T {
  contractRegistry.add(schema as z.ZodType, { ...contractRegistry.get(schema), jsonSchema });
  return schema;
}

/**
 * An integer in a query string. Arrives as a string from a URL, as a number
 * from a typed caller; both are the same request.
 */
export function queryInteger(bounds: { min?: number; max?: number } = {}) {
  let target = z.number().int();
  if (bounds.min !== undefined) target = target.min(bounds.min);
  if (bounds.max !== undefined) target = target.max(bounds.max);
  return documentedAs(z.union([z.number(), z.string()]).transform(Number).pipe(target), {
    type: 'integer',
    ...(bounds.min === undefined ? {} : { minimum: bounds.min }),
    ...(bounds.max === undefined ? {} : { maximum: bounds.max }),
  });
}

/** `true` / `false` in a query string (or a real boolean from a typed caller). */
export const queryBoolean = documentedAs(
  z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true'),
  { type: 'boolean' },
);

/** The latest representable instant (9999-12-31T23:59:59Z), the bound of every Unix-seconds parameter. */
export const MAX_UNIX_SECONDS = 253_402_300_799;

/** Unix seconds in a body. */
export const unixSecondsParam = z.number().int().min(0).max(MAX_UNIX_SECONDS);

/** Unix seconds in a query string. */
export const queryUnixSeconds = queryInteger({ min: 0, max: MAX_UNIX_SECONDS });

/** A range over a Unix-seconds field; each bound optional, together a conjunction. */
export interface RangeFilter {
  readonly gt?: number | undefined;
  readonly gte?: number | undefined;
  readonly lt?: number | undefined;
  readonly lte?: number | undefined;
}

/**
 * `created=X` (exactly that second) or `created[gt|gte|lt|lte]=X`. The bare
 * form is normalized to the range `[X, X]` so the repository reads one shape.
 */
export const rangeParam = documentedAs(
  z.union([
    queryUnixSeconds.transform((x): RangeFilter => ({ gte: x, lte: x })),
    z
      .object({
        gt: queryUnixSeconds.optional(),
        gte: queryUnixSeconds.optional(),
        lt: queryUnixSeconds.optional(),
        lte: queryUnixSeconds.optional(),
      })
      .strict()
      .transform((range): RangeFilter => range),
  ]),
  {
    description: 'Unix seconds: exactly one second, or a range with `gt`, `gte`, `lt`, `lte`.',
    oneOf: [
      { type: 'integer', minimum: 0 },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          gt: { type: 'integer', minimum: 0 },
          gte: { type: 'integer', minimum: 0 },
          lt: { type: 'integer', minimum: 0 },
          lte: { type: 'integer', minimum: 0 },
        },
      },
    ],
  },
);

/**
 * `expand[]=a&expand[]=b` arrives as an array; `expand=a` as a string. Both
 * mean the same request. Dot paths, at most four levels; on a list every path
 * starts with `data.`.
 */
export const expandParam = documentedAs(
  z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (typeof value === 'string' ? [value] : value))
    .pipe(z.array(z.string().min(1).max(200)).max(20)),
  {
    type: 'array',
    items: { type: 'string', maxLength: 200 },
    maxItems: 20,
    description:
      'Dot paths of references to replace with the objects they name (at most four levels; `data.`-prefixed on a list).',
  },
);

/** The public id of a cursor. Bounded so a cursor is never an unbounded index probe. */
export const cursorParam = z.string().min(1).max(255);

/** An object id in a body or query. */
export const idParam = z.string().min(1).max(255);

export const LIST_LIMIT_DEFAULT = 10;
export const LIST_LIMIT_MAX = 100;

/** The list limit: 1–100, default 10. */
export const limitParam = documentedAs(
  z
    .union([z.number(), z.string()])
    .transform(Number)
    .pipe(z.number().int().min(1).max(LIST_LIMIT_MAX))
    .optional()
    .transform((value) => value ?? LIST_LIMIT_DEFAULT),
  { type: 'integer', minimum: 1, maximum: LIST_LIMIT_MAX, default: LIST_LIMIT_DEFAULT },
);

/** The parameters every list accepts. */
export const listShape = {
  limit: limitParam,
  starting_after: cursorParam
    .optional()
    .describe('The id of the LAST object of the previous page: the next page is older.'),
  ending_before: cursorParam
    .optional()
    .describe('The id of the FIRST object of the current page: the page returned is newer.'),
  created: rangeParam.optional(),
  expand: expandParam.optional(),
};

interface CursorPair {
  readonly starting_after?: string | undefined;
  readonly ending_before?: string | undefined;
}

function refuseBothCursors(query: CursorPair, ctx: z.RefinementCtx): void {
  if (query.starting_after !== undefined && query.ending_before !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['ending_before'],
      message: 'starting_after and ending_before are mutually exclusive',
    });
  }
}

/**
 * A list query: the shared parameters plus the route's own filters.
 *
 * `.strict()`: an unknown parameter is a 400 naming it, never silently ignored
 * — `?stauts=settled` answering every intent is a filter the caller believes
 * they applied.
 */
export function listQuery<S extends z.ZodRawShape>(filters: S) {
  return z
    .object({ ...listShape, ...filters })
    .strict()
    .superRefine((query, ctx) => refuseBothCursors(query as CursorPair, ctx));
}

/** A retrieve's query: `expand[]` and nothing else unless the route says so. */
export function retrieveQuery<S extends z.ZodRawShape>(extra: S) {
  return z.object({ expand: expandParam.optional(), ...extra }).strict();
}

/** The query of a route that takes `expand[]` only. */
export const expandOnlyQuery = retrieveQuery({});

/** The query of a route that takes no parameters at all. */
export const emptyQuery = z.object({}).strict();

/** Search bounds — the gateway's, restated so a client can check before it asks. */
export const SEARCH_QUERY_MAX_LENGTH = 1000;
export const SEARCH_QUERY_MAX_CLAUSES = 10;
/** A `~` substring needs at least this many characters (Stripe's rule). */
export const SEARCH_SUBSTRING_MIN_LENGTH = 3;

/** The parameters every `GET /v1/<objects>/search` accepts. */
export const searchShape = {
  query: z
    .string({ error: 'query is required' })
    .min(1, 'query is required')
    .max(
      SEARCH_QUERY_MAX_LENGTH,
      `a query is at most ${String(SEARCH_QUERY_MAX_LENGTH)} characters`,
    )
    .describe(
      'Stripe\'s search query language: `email:"jenny@example.com"`, `amount>1000 AND currency:"EUR"`, `metadata[\'order_id\']:\'6735\'`, `name~"shirt"`, `-status:"canceled"`, `customer:null`.',
    ),
  limit: limitParam,
  page: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe('The `next_page` of the previous page, with the SAME query.'),
  expand: expandParam.optional(),
};

/** A search query. */
export const searchQuery = z.object(searchShape).strict();

// ---------------------------------------------------------------------------
// Metadata (ADR 0014 D1): Stripe's limits.
// ---------------------------------------------------------------------------

export const METADATA_MAX_KEYS = 50;
export const METADATA_KEY_MAX = 40;
export const METADATA_VALUE_MAX = 500;

/** A metadata update, as the repository applies it. */
export interface MetadataPatch {
  readonly set: Record<string, string>;
  readonly unset: readonly string[];
}

const metadataKey = z
  .string()
  .min(1, 'metadata keys cannot be empty')
  .max(METADATA_KEY_MAX, `metadata keys are at most ${METADATA_KEY_MAX} characters`)
  // A key is quoted back in bracket notation (`metadata[order_id]`) in every
  // error's `param`; a key containing brackets would make that ambiguous.
  .refine((key) => !/[[\]]/.test(key), 'metadata keys cannot contain square brackets');

const metadataValue = z
  .string()
  .max(METADATA_VALUE_MAX, `metadata values are at most ${METADATA_VALUE_MAX} characters`);

const metadataBag = z
  .record(metadataKey, metadataValue)
  .refine(
    (bag) => Object.keys(bag).length <= METADATA_MAX_KEYS,
    `metadata holds at most ${METADATA_MAX_KEYS} keys`,
  )
  .describe('At most 50 keys; keys ≤ 40 characters, values ≤ 500.');

/**
 * The bag a create stores. Empty values are dropped: there is nothing to unset
 * yet.
 */
export const metadataCreateParam = metadataBag.transform(
  (bag): Record<string, string> =>
    Object.fromEntries(Object.entries(bag).filter(([, value]) => value !== '')),
);

/**
 * The patch an update applies: named keys are set, a key sent as `""` is
 * removed, keys not named are kept. The 50-key limit is then judged on the
 * merged result, which only the database can see.
 */
export const metadataUpdateParam = metadataBag
  .transform(
    (bag): MetadataPatch => ({
      set: Object.fromEntries(Object.entries(bag).filter(([, value]) => value !== '')),
      unset: Object.entries(bag)
        .filter(([, value]) => value === '')
        .map(([key]) => key),
    }),
  )
  .describe('A patch: named keys are set, a key sent as `""` is removed, others are kept.');

/** The answer when the MERGED bag would exceed the key limit. */
export const METADATA_LIMIT_MESSAGE = `metadata holds at most ${METADATA_MAX_KEYS} keys`;

/** `""` clears a field on an update, Stripe's rule. */
export const clearable = <T extends z.ZodType>(schema: T) => z.union([schema, z.literal('')]);

/** Bounded text. */
export const text = (max: number) => z.string().max(max);
