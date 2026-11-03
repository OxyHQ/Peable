/**
 * The provider customer behind a Peable customer — created LAZILY (ADR 0016),
 * the first time something at the provider needs one: a card attached, a
 * payment that saves its card (`setup_future_usage`), or one charged off-session.
 *
 * The idempotency key is derived from the customer's own public id and the
 * provider, so a retry, a crash between the provider call and the binding
 * insert, or two concurrent first attaches all converge on ONE provider customer.
 */
import { getDb } from '../../db/postgres';
import {
  findCustomerBinding,
  insertCustomerBinding,
  type CustomerRow,
} from '../../db/customers/customerRepository';
import { isCustomerHoldingProvider, type PaymentProvider } from '../providers/provider';

export class CustomersUnavailableError extends Error {
  constructor() {
    super('this rail cannot hold customers');
    this.name = 'CustomersUnavailableError';
  }
}

export async function ensureProviderCustomer(
  customer: CustomerRow,
  provider: PaymentProvider,
): Promise<string> {
  const db = getDb();
  const existing = await findCustomerBinding(db, customer.id, provider.id);
  if (existing !== null) return existing;
  if (!isCustomerHoldingProvider(provider)) throw new CustomersUnavailableError();
  const created = await provider.createCustomer({
    customerId: customer.publicId,
    idempotencyKey: `cus:${customer.publicId}:${provider.id}`,
  });
  return insertCustomerBinding(db, {
    customerId: customer.id,
    provider: provider.id,
    providerObjectId: created.providerObjectId,
  });
}
