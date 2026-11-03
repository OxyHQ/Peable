/**
 * Customers (`cus_…`, ADR 0016) — Orbit's own object. Every write commits with
 * its `customer.*` event (ADR 0001 D7); the provider customer is a binding made
 * lazily elsewhere (`providerCustomer.ts`) and never touched here.
 */
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import {
  insertCustomer,
  tombstoneCustomer,
  updateCustomer,
  type CustomerFields,
  type CustomerRow,
} from '../../db/customers/customerRepository';
import {
  findPaymentMethodForMerchant,
  findPaymentMethodsByIds,
} from '../../db/customers/paymentMethodRepository';
import { getDb } from '../../db/postgres';
import type { MetadataPatch } from '../../db/metadata';
import { newId } from '../../lib/ids';
import { toCustomerDTO, toPaymentMethodDTO } from '../../lib/serialize';
import { recordCustomerObjectEvent } from '../intentTransition';
import { kickWebhookOutbox } from '../webhookOutbox';
import { detachAtProvider } from './paymentMethodService';

/** A request naming something that is not a payment method of THIS customer — a 400 with `param`. */
export class CustomerParameterError extends Error {
  constructor(
    message: string,
    readonly param: string,
    readonly code: 'parameter_invalid' | 'resource_missing' = 'parameter_invalid',
  ) {
    super(message);
    this.name = 'CustomerParameterError';
  }
}

export async function createCustomer(
  merchant: MerchantRow,
  fields: CustomerFields & { readonly metadata: Record<string, string> },
): Promise<CustomerRow> {
  const customer = await getDb().transaction(async (tx) => {
    const row = await insertCustomer(tx, {
      ...fields,
      publicId: newId('cus'),
      merchantId: merchant.id,
    });
    await recordCustomerObjectEvent(tx, merchant.id, 'customer.created', toCustomerDTO(row));
    return row;
  });
  kickWebhookOutbox();
  return customer;
}

/**
 * Update a live customer. `defaultPaymentMethod` is a `pm_…` that must be
 * attached to THIS customer (`null` clears it) — refused by name before the
 * composite reference would refuse it as a 500.
 *
 * @throws {CustomerParameterError}
 */
export async function updateCustomerFields(
  merchant: MerchantRow,
  customer: CustomerRow,
  patch: CustomerFields & {
    readonly metadata?: MetadataPatch | undefined;
    readonly defaultPaymentMethod?: string | null | undefined;
  },
): Promise<CustomerRow | 'missing' | 'limit_exceeded'> {
  let defaultPaymentMethodId: string | null | undefined;
  if (patch.defaultPaymentMethod === null) defaultPaymentMethodId = null;
  else if (patch.defaultPaymentMethod !== undefined) {
    const method = await findPaymentMethodForMerchant(
      getDb(),
      patch.defaultPaymentMethod,
      merchant.id,
    );
    if (!method) {
      throw new CustomerParameterError(
        `no such payment method: '${patch.defaultPaymentMethod}'`,
        'invoice_settings[default_payment_method]',
        'resource_missing',
      );
    }
    if (method.customerId !== customer.id) {
      throw new CustomerParameterError(
        'the default payment method must be attached to this customer',
        'invoice_settings[default_payment_method]',
      );
    }
    defaultPaymentMethodId = method.id;
  }
  const { defaultPaymentMethod: _ignored, ...rest } = patch;
  const result = await getDb().transaction(async (tx) => {
    const updated = await updateCustomer(tx, customer.publicId, merchant.id, {
      ...rest,
      ...(defaultPaymentMethodId !== undefined ? { defaultPaymentMethodId } : {}),
    });
    if (typeof updated !== 'string') {
      await recordCustomerObjectEvent(tx, merchant.id, 'customer.updated', toCustomerDTO(updated));
    }
    return updated;
  });
  if (typeof result !== 'string') kickWebhookOutbox();
  return result;
}

/**
 * Delete a customer: a TOMBSTONE (payment intents still reference it), its
 * methods detached and its default cleared in the same transaction, with
 * `customer.deleted` and one `payment_method.detached` per method. The
 * provider side is detached after the commit, best-effort — locally the
 * methods are already unusable, which is what stops Peable charging them.
 */
export async function deleteCustomer(
  merchant: MerchantRow,
  publicId: string,
): Promise<CustomerRow | null> {
  const deleted = await getDb().transaction(async (tx) => {
    const result = await tombstoneCustomer(tx, publicId, merchant.id);
    if (!result) return null;
    const methods = await findPaymentMethodsByIds(tx, result.detachedMethodIds);
    for (const method of methods) {
      await recordCustomerObjectEvent(
        tx,
        merchant.id,
        'payment_method.detached',
        toPaymentMethodDTO(method),
      );
    }
    await recordCustomerObjectEvent(
      tx,
      merchant.id,
      'customer.deleted',
      toCustomerDTO(result.customer),
    );
    return { customer: result.customer, methods };
  });
  if (!deleted) return null;
  kickWebhookOutbox();
  for (const method of deleted.methods) {
    await detachAtProvider(method).catch(() => undefined);
  }
  return deleted.customer;
}
