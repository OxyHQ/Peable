import { z } from 'zod';

/**
 * The object registry: every named wire object (`Customer`, `PaymentIntent`, …)
 * is defined ONCE, here in `packages/contracts`, and registered under its
 * OpenAPI component name and its `object` value.
 *
 * Three things read it:
 *
 * - `expandable(type)` — a reference that `expand[]` can replace with the
 *   object it names validates against the registered schema;
 * - the OpenAPI generator — every registered object is a
 *   `#/components/schemas/<Name>` and every reference to it is a `$ref`;
 * - {@link Expand} — the TypeScript half, which turns a reference's marker
 *   into the object type, so `Customer['invoice_settings']['default_payment_method']`
 *   is `string | PaymentMethod | null` without the schemas referencing each
 *   other at the type level (which TypeScript cannot infer, and which the
 *   declaration emitter would elide to `any`).
 */

/** OpenAPI-facing metadata a schema can carry. */
export interface ContractMeta {
  /** The component name: `#/components/schemas/<id>`. */
  id?: string;
  title?: string;
  description?: string;
  /** Example values, rendered in the reference and the OpenAPI document. */
  examples?: readonly unknown[];
  deprecated?: boolean;
  /** On an expandable reference: the `object` type `expand[]` replaces it with. */
  'x-peable-expandable'?: string;
  /** Replaces the generated JSON Schema of this node (a query integer's wire spelling). */
  jsonSchema?: Record<string, unknown>;
}

/** The one registry every contract schema's metadata lives in. */
export const contractRegistry = z.registry<ContractMeta>();

declare const refBrand: unique symbol;

/**
 * The TYPE of an expandable reference before {@link Expand} resolves it. Never
 * a runtime value: at runtime the reference is an id string or the object.
 */
export interface Ref<K extends string> {
  readonly [refBrand]: K;
}

/**
 * `object` value → wire type, for every object a reference can expand into.
 *
 * Each resource module adds its own entries by declaration merging:
 *
 * ```ts
 * declare module '../common/objects' {
 *   interface ObjectMap { customer: Customer }
 * }
 * ```
 *
 * so a resource is registered by the same file that defines it.
 */
// biome-ignore lint/suspicious/noEmptyInterface: filled by declaration merging, one entry per resource module
export interface ObjectMap {}

/** Every object type a reference can name. */
export type ObjectType = keyof ObjectMap;

/**
 * A schema's output with every {@link Ref} replaced by the object it names —
 * the wire type. Homomorphic, so optional and readonly modifiers survive.
 */
export type Expand<T> =
  T extends Ref<infer K>
    ? K extends keyof ObjectMap
      ? ObjectMap[K]
      : never
    : T extends readonly (infer U)[]
      ? Expand<U>[]
      : T extends object
        ? { [P in keyof T]: Expand<T[P]> }
        : T;

/** The wire type a schema describes (its output, references resolved). */
export type Wire<S extends z.ZodType> = Expand<z.output<S>>;

/** The parameters a request schema accepts as sent on the wire (its input). */
export type Params<S extends z.ZodType> = z.input<S>;

const objectSchemas = new Map<string, z.ZodType>();

/**
 * Register a wire object: its `object` value (the key references use) and its
 * component name. Returns the schema so a definition reads as one expression.
 */
export function defineObject<T extends z.ZodType>(
  type: string,
  id: string,
  schema: T,
  meta: Omit<ContractMeta, 'id'> = {},
): T {
  if (objectSchemas.has(type)) throw new Error(`object type '${type}' is defined twice`);
  objectSchemas.set(type, schema);
  contractRegistry.add(schema as z.ZodType, { id, ...meta });
  return schema;
}

/**
 * Register a named schema that is not an expandable object — a tombstone, a
 * shared sub-object, a polymorphic payload — as `#/components/schemas/<id>`.
 */
export function defineComponent<T extends z.ZodType>(
  id: string,
  schema: T,
  meta: Omit<ContractMeta, 'id'> = {},
): T {
  contractRegistry.add(schema as z.ZodType, { id, ...meta });
  return schema;
}

/** The registered schema of `type`, or `undefined`. */
export function objectSchema(type: string): z.ZodType | undefined {
  return objectSchemas.get(type);
}

/**
 * The registered schema of `type`. Resolved lazily (a reference is declared
 * before the module defining its target has loaded), and loud when nothing
 * registers it: a reference to an unknown object is a contract bug.
 */
export function resolveObject(type: string): z.ZodType {
  const schema = objectSchemas.get(type);
  if (!schema) throw new Error(`no wire object is registered as '${type}'`);
  return schema;
}

/** Every registered object type, in registration order. */
export function objectTypes(): string[] {
  return [...objectSchemas.keys()];
}

/**
 * A reference `expand[]` can replace: the id (`cus_…`) or, expanded, the
 * object. The naming rule (`lib/expand.ts` in the backend): an expandable
 * reference is spelled WITHOUT `_id`, and a field without `_id` that is not
 * expandable is a bug.
 */
export function expandable<K extends string>(
  type: K,
  description?: string,
): z.ZodType<string | Ref<K>, string | Ref<K>> {
  const resolved = z.lazy(() => resolveObject(type));
  const union = z.union([z.string(), resolved]);
  contractRegistry.add(union, {
    'x-peable-expandable': type,
    ...(description === undefined ? {} : { description }),
  });
  return union as unknown as z.ZodType<string | Ref<K>, string | Ref<K>>;
}

/**
 * A field that always carries the FULL object `type` names (never an id): a
 * subscription item's `price`, a payer view's `payment_intent`, a report run's
 * result `file`. Validated against the registered schema and typed through
 * {@link Ref}, so {@link Expand} resolves it to that object's wire type.
 */
export function embedded<K extends string>(
  type: K,
  description?: string,
): z.ZodType<Ref<K>, Ref<K>> {
  const schema = z.lazy(() => resolveObject(type));
  return (description === undefined
    ? schema
    : schema.describe(description)) as unknown as z.ZodType<Ref<K>, Ref<K>>;
}

/** Attach OpenAPI metadata to a schema without changing its type. */
export function describe<T extends z.ZodType>(schema: T, meta: ContractMeta): T {
  contractRegistry.add(schema as z.ZodType, { ...contractRegistry.get(schema), ...meta });
  return schema;
}
