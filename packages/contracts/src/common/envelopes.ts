import { z } from 'zod';
import { ERROR_CODES, ERROR_TYPES } from '../vocabulary/errors';
import { contractRegistry, objectSchema } from './objects';

/** Object types an error referenced before they were registered (the contract tests assert none). */
export const unregisteredErrorReferences = new Set<string>();

function objectSchemaOrThrow(type: string): z.ZodType {
  const schema = objectSchema(type);
  if (schema) return schema;
  unregisteredErrorReferences.add(type);
  return z.object({ id: z.string(), object: z.literal(type) }).loose();
}

/**
 * The envelopes every resource shares (ADR 0014 D1): the list, the search
 * result, the deleted tombstone and the error.
 */

/**
 * One page of a list, newest first. `url` is the path that was listed, so a
 * page carries enough to fetch the next one without the caller remembering
 * where it came from.
 */
export function listOf<T extends z.ZodType>(item: T) {
  return z
    .object({
      object: z.literal('list'),
      data: z.array(item),
      has_more: z
        .boolean()
        .describe('Whether another page exists in the direction this one was read.'),
      url: z.string().describe('The path that was listed.'),
    })
    .strict();
}

/**
 * One page of a search. Pages FORWARD only, by an opaque `next_page` token
 * passed back as `page`, bound to the query it came from.
 */
export function searchResultOf<T extends z.ZodType>(item: T) {
  return z
    .object({
      object: z.literal('search_result'),
      data: z.array(item),
      has_more: z.boolean(),
      next_page: z
        .string()
        .nullable()
        .describe('Pass as `page` for the next page; `null` on the last one.'),
      url: z.string().describe('The path that was searched.'),
      total_count: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Present only when asked for with `expand[]=total_count`.'),
    })
    .strict();
}

/** A deleted object, as its `DELETE` answers: `{id, object, deleted: true}`. */
export function deletedOf<T extends string>(object: T) {
  return z.object({ id: z.string(), object: z.literal(object), deleted: z.literal(true) }).strict();
}

/** The error object inside every non-2xx answer. */
export const apiErrorSchema = z
  .object({
    type: z.enum(ERROR_TYPES).describe('The broad class a caller branches on first.'),
    // A string rather than the closed `ERROR_CODES`: a `card_error` carries the
    // provider's decline code (`insufficient_funds`, `expired_card`, …), which
    // Peable passes through. Every code Peable itself answers with is an
    // `ErrorCode` (the backend's `sendError` takes nothing else).
    code: z
      .string()
      .optional()
      .describe(
        `The machine-readable reason (one of ${String(ERROR_CODES.length)} documented at https://docs.peable.to/errors, or a card network's decline code on a \`card_error\`).`,
      ),
    decline_code: z
      .string()
      .optional()
      .describe("A card issuer's decline reason, on a `card_error`."),
    param: z
      .string()
      .optional()
      .describe('The offending request field, in bracket notation (`metadata[order_id]`).'),
    message: z.string().describe('A human-readable message, for a developer.'),
    doc_url: z.url().optional().describe('The documentation of `code`.'),
    request_id: z.string().nullable().describe('The `Request-Id` of this response, for support.'),
    payment_intent: z
      .lazy(() => objectSchemaOrThrow('payment_intent'))
      .optional()
      .describe(
        'On a `card_error` from a confirm or an invoice payment: the PaymentIntent, as it now is.',
      ),
    invoice: z
      .lazy(() => objectSchemaOrThrow('invoice'))
      .optional()
      .describe('On a failed invoice payment: the invoice, as it now is.'),
    refresh_url: z
      .url()
      .optional()
      .describe('On an expired onboarding link: where the seller gets a fresh one.'),
  })
  .strict();

/** `{ error: {...} }` — every non-2xx answer. */
export const errorEnvelopeSchema = z.object({ error: apiErrorSchema }).strict();
contractRegistry.add(errorEnvelopeSchema, {
  id: 'Error',
  description: 'Every non-2xx answer. The HTTP status and `error.type` identify the failure.',
});

export type ApiError = z.output<typeof apiErrorSchema>;
export type ErrorEnvelope = z.output<typeof errorEnvelopeSchema>;
