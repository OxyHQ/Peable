// A Customer (`cus_…`) — Orbit's own object (ADR 0016). A provider customer is
// an internal binding created lazily, per mode, when a card payment method is
// first attached; it is never serialized.
import type { Address, AddressParams, Shipping, ShippingParams } from './paymentIntent';
import type { PaymentMethod } from './paymentMethod';

export interface Customer {
  id: string;
  object: 'customer';
  livemode: boolean;
  email: string | null;
  name: string | null;
  phone: string | null;
  description: string | null;
  address: Address | null;
  shipping: Shipping | null;
  invoice_settings: {
    /** `pm_…`, or the {@link PaymentMethod} with `expand[]=invoice_settings.default_payment_method`. */
    default_payment_method: string | PaymentMethod | null;
  };
  metadata: Record<string, string>;
  created: number;
}

/** A deleted customer, as `DELETE /v1/customers/:id` answers. */
export interface DeletedCustomer {
  id: string;
  object: 'customer';
  deleted: true;
}

export interface CreateCustomerParams {
  email?: string;
  name?: string;
  phone?: string;
  description?: string;
  address?: AddressParams;
  shipping?: ShippingParams;
  invoice_settings?: { default_payment_method?: string };
  metadata?: Record<string, string>;
}

/** `POST /v1/customers/:id`. A field sent as `""` is cleared; `metadata` is a patch. */
export type UpdateCustomerParams = CreateCustomerParams;
