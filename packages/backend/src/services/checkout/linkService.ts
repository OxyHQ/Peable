/**
 * Payment Links v2 (Orbit Phase 3): a shareable URL over catalog prices.
 *
 * A link's line items are fixed when it is created (a payer may hold a
 * session priced from them); its options change, and every change records
 * `payment_link.updated` with the moved fields. A payer visiting the link
 * creates a Checkout Session (`createSessionFromLink`), never a payment.
 */
import { z } from 'zod';
import {
  CHECKOUT_CUSTOMER_CREATIONS,
  CHECKOUT_SUBMIT_TYPES,
  type CheckoutLineItem,
  PAYMENT_LINK_LIMITS,
  type PaymentLink,
} from '@peable.to/shared-types';
import { findBranding } from '../../db/merchants/brandingRepository';
import { findPriceForMerchant } from '../../db/catalog/priceRepository';
import { findProductsByPublicIds } from '../../db/catalog/productRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import type { MetadataPatch } from '../../db/metadata';
import {
  DEFAULT_LINK_OPTIONS,
  findLinkForMerchant,
  insertPaymentLink,
  listLineItemsForLinks,
  listLinkLineItems,
  type PaymentLinkOptions,
  type PaymentLinkRow,
  updatePaymentLink,
} from '../../db/payments/paymentLinkRepository';
import { type DatabaseOrTransaction, getDb } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { expandParam } from '../../lib/list';
import {
  METADATA_LIMIT_MESSAGE,
  metadataCreateSchema,
  metadataUpdateSchema,
} from '../../lib/metadata';
import { toPaymentLinkDTO } from '../../lib/serializeCheckout';
import { previousAttributes } from '../catalog/catalogService';
import {
  assertRailAvailable,
  NetworkMismatchError,
  RailMismatchError,
  RailUnavailableError,
  resolveRail,
} from '../createIntent';
import { recordEvent } from '../events';
import type { TaxService } from '../tax/taxService';
import { kickWebhookOutbox } from '../webhookOutbox';
import { CheckoutError, invalid } from './errors';
import { linkLineItemDTO, resolveLinkLines } from './lineItems';
import {
  adjustableBoundsOf,
  collectionFields,
  linkLineItemSchema,
  localeSchema,
  redirectUrlSchema,
  storedCollectionOf,
  storedCustomFieldsOf,
} from './params';

const afterCompletionSchema = z
  .object({
    type: z.enum(['redirect', 'hosted_confirmation']),
    redirect: z.object({ url: redirectUrlSchema }).strict().optional(),
    hosted_confirmation: z
      .object({
        custom_message: z
          .string()
          .trim()
          .min(1)
          .max(PAYMENT_LINK_LIMITS.customMessageMax)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === 'redirect' && !value.redirect) {
      ctx.addIssue({
        code: 'custom',
        path: ['redirect'],
        message: 'redirect.url is required',
      });
    }
    if (value.type === 'redirect' && value.hosted_confirmation) {
      ctx.addIssue({
        code: 'custom',
        path: ['hosted_confirmation'],
        message: 'hosted_confirmation is for type hosted_confirmation',
      });
    }
    if (value.type === 'hosted_confirmation' && value.redirect) {
      ctx.addIssue({
        code: 'custom',
        path: ['redirect'],
        message: 'redirect is for type redirect',
      });
    }
  });

const restrictionsSchema = z
  .object({
    completed_sessions: z.object({ limit: z.number().int().min(1).max(1_000_000) }).strict(),
  })
  .strict();

const optionFields = {
  allow_promotion_codes: z.boolean().optional(),
  ...collectionFields,
  automatic_tax: z.object({ enabled: z.boolean() }).strict().optional(),
  customer_creation: z.enum(CHECKOUT_CUSTOMER_CREATIONS).optional(),
  after_completion: afterCompletionSchema.optional(),
  submit_type: z.enum(CHECKOUT_SUBMIT_TYPES).optional(),
  locale: localeSchema.optional(),
};

/** `POST /v1/payment_links`. */
export const createLinkBodySchema = z
  .object({
    line_items: z.array(linkLineItemSchema).min(1).max(PAYMENT_LINK_LIMITS.lineItemsMax),
    ...optionFields,
    restrictions: restrictionsSchema.optional(),
    metadata: metadataCreateSchema.optional(),
    expand: expandParam.optional(),
  })
  .strict();

/** `POST /v1/payment_links/:id` — everything but the line items. `''` clears. */
export const updateLinkBodySchema = z
  .object({
    active: z.boolean().optional(),
    ...optionFields,
    shipping_address_collection: z
      .union([collectionFields.shipping_address_collection.unwrap(), z.literal('')])
      .optional(),
    custom_fields: z.union([collectionFields.custom_fields.unwrap(), z.literal('')]).optional(),
    restrictions: z.union([restrictionsSchema, z.literal('')]).optional(),
    metadata: metadataUpdateSchema.optional(),
    expand: expandParam.optional(),
  })
  .strict();

export type CreateLinkBody = z.infer<typeof createLinkBodySchema>;
export type UpdateLinkBody = z.infer<typeof updateLinkBodySchema>;

/** The `item`s of several links, by link id — one read of their prices and products. */
export async function linkLineItemsFor(
  db: DatabaseOrTransaction,
  merchantId: string,
  links: readonly PaymentLinkRow[],
): Promise<Map<string, CheckoutLineItem[]>> {
  const byLink = await listLineItemsForLinks(
    db,
    links.map((link) => link.id),
  );
  const all = [...byLink.values()].flat();
  const entries = await resolveLinkLines(db, merchantId, all);
  const out = new Map<string, CheckoutLineItem[]>();
  for (const link of links) {
    const mine = entries.filter((entry) => entry.row.linkId === link.id);
    out.set(
      link.id,
      mine.map((entry) => linkLineItemDTO(link.publicId, entry)),
    );
  }
  return out;
}

export async function toLinkDTO(
  db: DatabaseOrTransaction,
  row: PaymentLinkRow,
): Promise<PaymentLink> {
  const lines = await linkLineItemsFor(db, row.merchantId, [row]);
  return toPaymentLinkDTO(row, lines.get(row.id) ?? []);
}

export async function toLinkDTOs(
  db: DatabaseOrTransaction,
  merchantId: string,
  rows: readonly PaymentLinkRow[],
): Promise<PaymentLink[]> {
  const lines = await linkLineItemsFor(db, merchantId, rows);
  return rows.map((row) => toPaymentLinkDTO(row, lines.get(row.id) ?? []));
}

/** `payment_link.updated` with the moved fields, in the caller's transaction. */
export async function recordLinkUpdated(
  tx: DatabaseOrTransaction,
  row: PaymentLinkRow,
  previous: Record<string, unknown> | null,
): Promise<void> {
  await recordEvent(tx, {
    merchantId: row.merchantId,
    type: 'payment_link.updated',
    object: await toLinkDTO(tx, row),
    ...(previous ? { previousAttributes: previous } : {}),
  });
}

function optionsOf(body: Partial<CreateLinkBody>, base: PaymentLinkOptions): PaymentLinkOptions {
  const after = body.after_completion;
  return {
    allowPromotionCodes: body.allow_promotion_codes ?? base.allowPromotionCodes,
    collection: storedCollectionOf({
      billing_address_collection:
        body.billing_address_collection ?? base.collection?.billingAddressCollection,
      shipping_address_collection:
        body.shipping_address_collection ??
        (base.collection?.shippingCountries
          ? { allowed_countries: [...base.collection.shippingCountries] }
          : undefined),
      phone_number_collection: body.phone_number_collection ?? {
        enabled: base.collection?.phoneNumber ?? false,
      },
      tax_id_collection: body.tax_id_collection ?? { enabled: base.collection?.taxId ?? false },
      consent_collection: body.consent_collection ?? {
        terms_of_service: base.collection?.termsOfService ? 'required' : 'none',
      },
    }),
    customFields:
      body.custom_fields !== undefined
        ? storedCustomFieldsOf(body.custom_fields)
        : [...base.customFields],
    automaticTax: body.automatic_tax?.enabled ?? base.automaticTax,
    customerCreation: body.customer_creation ?? base.customerCreation,
    submitType: body.submit_type ?? base.submitType,
    locale: body.locale !== undefined ? body.locale : base.locale,
    afterCompletionType: after?.type ?? base.afterCompletionType,
    afterCompletionUrl: after
      ? after.type === 'redirect'
        ? (after.redirect?.url ?? null)
        : null
      : base.afterCompletionUrl,
    afterCompletionMessage: after
      ? after.type === 'hosted_confirmation'
        ? (after.hosted_confirmation?.custom_message ?? null)
        : null
      : base.afterCompletionMessage,
    completedSessionsLimit:
      body.restrictions !== undefined
        ? body.restrictions.completed_sessions.limit
        : base.completedSessionsLimit,
  };
}

async function assertOptionsUsable(
  merchant: MerchantRow,
  options: PaymentLinkOptions,
  tax: TaxService | undefined,
): Promise<void> {
  if (options.collection?.termsOfService) {
    const branding = await findBranding(getDb(), merchant.id);
    if (!branding.termsOfServiceUrl) {
      throw invalid(
        'parameter_invalid',
        'set a terms of service URL in your branding settings before asking payers to accept it',
        'consent_collection[terms_of_service]',
      );
    }
  }
  if (options.automaticTax) {
    const settings = tax ? await tax.getSettings(merchant) : null;
    if (settings?.status !== 'active') {
      throw invalid(
        'tax_settings_not_active',
        'automatic tax needs Peable Tax settings approved by the account owner',
        'automatic_tax[enabled]',
      );
    }
  }
}

/** `POST /v1/payment_links`. */
export async function createPaymentLink(
  merchant: MerchantRow,
  body: CreateLinkBody,
  deps: { tax?: TaxService | undefined } = {},
): Promise<PaymentLinkRow> {
  const db = getDb();
  const resolved: {
    priceId: string;
    currency: string;
    quantity: number;
    adjustable: { minimum: number; maximum: number } | null;
  }[] = [];
  for (const [index, line] of body.line_items.entries()) {
    const param = `line_items[${index}][price]`;
    const price = await findPriceForMerchant(db, line.price, merchant.id);
    if (!price) throw invalid('resource_missing', `no such price: '${line.price}'`, param);
    if (!price.active) throw invalid('parameter_invalid', 'the price is archived', param);
    if (price.type !== 'one_time') {
      throw invalid('parameter_invalid', 'a payment link sells one-time prices', param);
    }
    const [product] = await findProductsByPublicIds(db, merchant.id, [price.productPublicId]);
    if (!product?.active)
      throw invalid('parameter_invalid', 'the price’s product is archived', param);
    resolved.push({
      priceId: price.id,
      currency: price.currency,
      quantity: line.quantity,
      adjustable: adjustableBoundsOf(line.adjustable_quantity),
    });
  }
  const currency = resolved[0]?.currency;
  resolved.forEach((line, index) => {
    if (line.currency !== currency) {
      throw invalid(
        'parameter_invalid',
        `every price on a link must be in one currency (${currency})`,
        `line_items[${index}][price]`,
      );
    }
  });
  if (currency !== 'FAIR' && currency !== 'EUR' && currency !== 'USD') {
    throw invalid('parameter_invalid', 'unsupported currency', 'line_items');
  }
  const rail = currency === 'FAIR' ? ('faircoin' as const) : ('card' as const);
  let network: PaymentLinkRow['network'];
  try {
    const decided = resolveRail(merchant, {
      rail,
      currency,
      ...(rail === 'faircoin' && merchant.network ? { network: merchant.network } : {}),
    });
    assertRailAvailable(decided.rail, merchant.environment);
    network = decided.network;
  } catch (error) {
    if (error instanceof NetworkMismatchError || error instanceof RailMismatchError) {
      throw invalid('parameter_invalid', error.message, 'line_items');
    }
    if (error instanceof RailUnavailableError)
      throw new CheckoutError(503, 'rail_unavailable', error.message);
    throw error;
  }
  const options = optionsOf(body, DEFAULT_LINK_OPTIONS);
  await assertOptionsUsable(merchant, options, deps.tax);

  const row = await db.transaction(async (tx) => {
    const link = await insertPaymentLink(tx, {
      publicId: newId('link'),
      merchantId: merchant.id,
      oxyAppId: merchant.oxyAppId,
      environment: merchant.environment,
      currency,
      rail,
      network,
      metadata: body.metadata ?? {},
      options,
      lineItems: resolved,
    });
    await recordEvent(tx, {
      merchantId: merchant.id,
      type: 'payment_link.created',
      object: await toLinkDTO(tx, link),
    });
    return link;
  });
  kickWebhookOutbox();
  return row;
}

/** `POST /v1/payment_links/:id`. */
export async function updatePaymentLinkOptions(
  merchant: MerchantRow,
  publicId: string,
  body: UpdateLinkBody,
  deps: { tax?: TaxService | undefined } = {},
): Promise<PaymentLinkRow> {
  const db = getDb();
  const before = await findLinkForMerchant(db, publicId, merchant.id);
  if (!before) throw new CheckoutError(404, 'resource_missing', 'payment link not found');
  const touchesOptions = Object.keys(body).some(
    (key) => key !== 'active' && key !== 'metadata' && key !== 'expand',
  );
  if (before.contribution && touchesOptions) {
    throw invalid(
      'parameter_invalid',
      'a contribution link is managed through its organization’s contributions',
      Object.keys(body).find((key) => key !== 'active' && key !== 'metadata' && key !== 'expand'),
    );
  }
  const {
    shipping_address_collection: shipping,
    custom_fields: customFields,
    restrictions,
    active: _active,
    metadata: _metadata,
    expand: _expand,
    ...rest
  } = body;
  const base: PaymentLinkOptions = {
    allowPromotionCodes: before.allowPromotionCodes,
    collection: before.collection,
    customFields: before.customFields,
    automaticTax: before.automaticTax,
    customerCreation: before.customerCreation,
    submitType: before.submitType,
    locale: before.locale,
    afterCompletionType: before.afterCompletionType,
    afterCompletionUrl: before.afterCompletionUrl,
    afterCompletionMessage: before.afterCompletionMessage,
    completedSessionsLimit: before.completedSessionsLimit,
  };
  let options = optionsOf(
    {
      ...rest,
      ...(shipping !== undefined && shipping !== ''
        ? { shipping_address_collection: shipping }
        : {}),
      ...(customFields !== undefined && customFields !== '' ? { custom_fields: customFields } : {}),
      ...(restrictions !== undefined && restrictions !== '' ? { restrictions } : {}),
    },
    base,
  );
  if (shipping === '' && options.collection) {
    options = { ...options, collection: { ...options.collection, shippingCountries: null } };
  }
  if (customFields === '') options = { ...options, customFields: [] };
  if (restrictions === '') options = { ...options, completedSessionsLimit: null };
  if (touchesOptions) await assertOptionsUsable(merchant, options, deps.tax);

  const row = await db.transaction(async (tx) => {
    const updated = await updatePaymentLink(tx, publicId, merchant.id, {
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata as MetadataPatch } : {}),
      ...(touchesOptions ? { options } : {}),
    });
    if (updated === 'missing')
      throw new CheckoutError(404, 'resource_missing', 'payment link not found');
    if (updated === 'limit_exceeded')
      throw invalid('parameter_invalid', METADATA_LIMIT_MESSAGE, 'metadata');
    const lines = await linkLineItemsFor(tx, merchant.id, [before]);
    const previous = previousAttributes(
      toPaymentLinkDTO(before, lines.get(before.id) ?? []),
      toPaymentLinkDTO(updated, lines.get(before.id) ?? []),
    );
    if (previous) await recordLinkUpdated(tx, updated, previous);
    return updated;
  });
  kickWebhookOutbox();
  return row;
}

/** A link's lines (`GET /v1/payment_links/:id/line_items`) — a complete set, `has_more: false`. */
export async function linkLines(row: PaymentLinkRow): Promise<CheckoutLineItem[]> {
  const db = getDb();
  const entries = await resolveLinkLines(db, row.merchantId, await listLinkLineItems(db, row.id));
  return entries.map((entry) => linkLineItemDTO(row.publicId, entry));
}
