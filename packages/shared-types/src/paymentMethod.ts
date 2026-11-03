// A PaymentMethod (`pm_…`) — Peable's wrapper over a provider payment method
// (ADR 0016). Card details are collected by the provider's own Elements in the
// browser; the card number never reaches Peable. A FairCoin customer has no
// payment method: signing stays on the payer's device.
import type { CardDetails } from './charge';
import type { Customer } from './customer';
import type { Address, AddressParams } from './paymentIntent';

export interface BillingDetails {
  address: Address | null;
  email: string | null;
  name: string | null;
  phone: string | null;
}

export interface PaymentMethod {
  id: string;
  object: 'payment_method';
  livemode: boolean;
  type: 'card';
  card: CardDetails;
  billing_details: BillingDetails;
  /** `cus_…`, or the {@link Customer} with `expand[]=customer`; `null` once detached. */
  customer: string | Customer | null;
  metadata: Record<string, string>;
  created: number;
}

export interface UpdatePaymentMethodParams {
  billing_details?: {
    address?: AddressParams;
    email?: string;
    name?: string;
    phone?: string;
  };
  metadata?: Record<string, string>;
}

export interface AttachPaymentMethodParams {
  customer: string;
}
