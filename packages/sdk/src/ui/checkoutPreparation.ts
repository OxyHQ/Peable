import type { ReactNode } from 'react';
import type { CheckoutRequest } from '@oxy.so/bloom/checkout-sheet';
import type { PeableCheckoutSheetProps } from './PeableCheckoutSheet';
import type { SheetCheckoutSource, SheetExpectation } from './sheetCheckout';

/** Structured payer data, never parsed from a profile's free-text location. */
export interface SheetShippingAddress {
  readonly name: string;
  readonly line1: string;
  readonly line2: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  /** ISO 3166-1 alpha-2 country. */
  readonly country: string;
  readonly phone: string;
}

export interface SheetCheckoutDetails {
  readonly email: string;
  /** Explicit payer consent, never inferred from choosing a shipping destination. */
  readonly useShippingForBilling?: boolean;
  readonly shipping: SheetShippingAddress;
  /** Selection metadata only; the frozen full address is what the payer reviewed. */
  readonly selectedAddressId: string | null;
}

export interface SheetSavedAddress {
  readonly id: string;
  readonly label: string;
  readonly address: SheetShippingAddress;
}

export interface SheetPreparedCheckout {
  readonly source: Extract<SheetCheckoutSource, { type: 'checkout_session' }>;
  /** The host's authoritative newly priced order, including any shipping change. */
  readonly expected: SheetExpectation;
}

/** Open the sheet before an order exists, collect its prerequisites, then create it once. */
export interface SheetCheckoutPreparation {
  /** Stable account + cart identity. Change it on account/cart changes to discard private state. */
  readonly key: string;
  /** A host quote for review, not an authorization to charge. Peable reads the final order. */
  readonly request: CheckoutRequest;
  /** Label for a provisional quote, before destination-dependent pricing exists. */
  readonly amountLabel?: string;
  readonly initialDetails?: Partial<
    Pick<SheetCheckoutDetails, 'email' | 'shipping' | 'selectedAddressId'>
  >;
  readonly addresses?: readonly SheetSavedAddress[];
  readonly accountSummary?: PeableCheckoutSheetProps['accountSummary'];
  /** Extra prerequisites (pickup or digital consent), inside this sheet's Bloom frame. */
  readonly renderAdditionalDetails?: (context: { readonly disabled: boolean }) => ReactNode;
  readonly canContinue?: boolean;
  /**
   * Creates/retrieves the same order, never charges it. The host owns durable idempotency and
   * recovery. On an ambiguous error, the sheet retries these exact frozen details; only an
   * explicit SheetPreparationError('not_created') permits editing them.
   */
  readonly createSession: (
    details: Readonly<SheetCheckoutDetails>,
    context: { readonly signal: AbortSignal },
  ) => Promise<SheetPreparedCheckout>;
}

/** A host-safe error message. Only not_created proves fields may be edited; unknown preserves the attempt. */
export class SheetPreparationError extends Error {
  readonly outcome: 'not_created' | 'unknown';
  constructor(message: string, outcome: 'not_created' | 'unknown') {
    super(message);
    this.name = 'SheetPreparationError';
    this.outcome = outcome;
  }
}

export function initialCheckoutDetails(
  initial: SheetCheckoutPreparation['initialDetails'],
): SheetCheckoutDetails {
  return {
    email: initial?.email ?? '',
    shipping: initial?.shipping ?? {
      name: '',
      line1: '',
      line2: '',
      city: '',
      state: '',
      postalCode: '',
      country: '',
      phone: '',
    },
    selectedAddressId: initial?.selectedAddressId ?? null,
  };
}

export function freezeCheckoutDetails(
  details: SheetCheckoutDetails,
): Readonly<SheetCheckoutDetails> {
  return Object.freeze({
    email: details.email.trim(),
    useShippingForBilling: details.useShippingForBilling === true,
    selectedAddressId: details.selectedAddressId,
    shipping: Object.freeze({
      ...details.shipping,
      country: details.shipping.country.trim().toUpperCase(),
    }),
  });
}

/** Field completeness only; the merchant backend validates destination and shipping eligibility. */
export function canPrepareCheckout(
  request: CheckoutRequest,
  details: SheetCheckoutDetails,
): boolean {
  if (request.requiresContact !== false && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email.trim()))
    return false;
  if (!request.requiresShipping) return true;
  const address = details.shipping;
  return (
    [address.name, address.line1, address.city].every((value) => value.trim()) &&
    /^[a-z]{2}$/i.test(address.country.trim())
  );
}
