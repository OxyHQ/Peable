/**
 * Checkout's parsed requests (Orbit Phase 3), as the services consume them.
 *
 * The request SCHEMAS are the contract's (`@peable.to/contracts`
 * `createCheckoutSessionParams`, `updateCheckoutSessionPublicParams`,
 * `createPaymentLinkParams`, …): the routes validate with those objects and
 * this module only turns a parsed request into what the repositories store.
 */
import type { z } from 'zod';
import {
  CHECKOUT_SESSION_ID_TEMPLATE,
  type createCheckoutSessionParams,
  type customFieldsParam,
  type updateCheckoutSessionPublicParams,
} from '@peable.to/contracts';
import type { StoredCheckoutCollection, StoredCustomField } from '../../db/schema/payments';
import { sendError } from '../../lib/http';
import type { Response } from 'express';
import { isKnownTaxCode } from '../tax/codes';

export { adjustableBoundsOf } from '@peable.to/contracts';

/** A parsed `POST /v1/checkout_sessions` body. */
export type CreateSessionBody = z.output<typeof createCheckoutSessionParams>;

/** A parsed `POST /v1/checkout_sessions/:id/public` body — the payer's edit. */
export type PayerUpdate = z.output<typeof updateCheckoutSessionPublicParams>;

/** `{CHECKOUT_SESSION_ID}` in a redirect URL, substituted on the way to the payer. */
export function substituteSessionId(url: string, sessionPublicId: string): string {
  return url.split(CHECKOUT_SESSION_ID_TEMPLATE).join(sessionPublicId);
}

type CollectionInput = {
  billing_address_collection?: 'auto' | 'required' | undefined;
  shipping_address_collection?: { allowed_countries: string[] } | undefined;
  phone_number_collection?: { enabled: boolean } | undefined;
  tax_id_collection?: { enabled: boolean } | undefined;
  consent_collection?: { terms_of_service?: 'none' | 'required' | undefined } | undefined;
};

/** The stored collection a request's options describe. */
export function storedCollectionOf(input: CollectionInput): StoredCheckoutCollection {
  return {
    billingAddressCollection: input.billing_address_collection ?? 'auto',
    shippingCountries: input.shipping_address_collection
      ? [...new Set(input.shipping_address_collection.allowed_countries)]
      : null,
    phoneNumber: input.phone_number_collection?.enabled ?? false,
    taxId: input.tax_id_collection?.enabled ?? false,
    termsOfService: input.consent_collection?.terms_of_service === 'required',
  };
}

export const DEFAULT_COLLECTION: StoredCheckoutCollection = storedCollectionOf({});

export function storedCustomFieldsOf(
  fields: z.output<typeof customFieldsParam> | undefined,
): StoredCustomField[] {
  return (fields ?? []).map((field) => {
    const bounds = field.text ?? field.numeric;
    return {
      key: field.key,
      label: field.label.custom,
      type: field.type,
      optional: field.optional ?? false,
      options: field.dropdown ? field.dropdown.options.map((o) => ({ ...o })) : null,
      minimumLength: bounds?.minimum_length ?? null,
      maximumLength: bounds?.maximum_length ?? null,
      value: null,
    };
  });
}

/**
 * The contract holds an inline `product_data.tax_code` to the code FORMAT;
 * which codes exist is Peable Tax's catalog (`services/tax/codes.ts`). Answers
 * the 400 the schema would have, and returns `false`, for a well-formed code
 * the catalog does not know.
 */
export function refuseUnknownTaxCodes(res: Response, body: CreateSessionBody): boolean {
  for (const [index, line] of (body.line_items ?? []).entries()) {
    const code = line.price_data?.product_data?.tax_code;
    if (code === undefined || isKnownTaxCode(code)) continue;
    sendError(
      res,
      400,
      'invalid_request_error',
      'is not a Peable Tax code (GET /v1/tax/codes lists them)',
      'parameter_invalid',
      `line_items[${String(index)}][price_data][product_data][tax_code]`,
    );
    return false;
  }
  return true;
}
