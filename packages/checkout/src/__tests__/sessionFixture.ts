import type {
  CheckoutLineItem,
  CheckoutSessionPublic,
  PublicPaymentLink,
} from '@peable.to/shared-types';

/** One complete `CheckoutSessionPublic` for every suite, a card order by default. */
export function sessionFixture(
  overrides: Partial<CheckoutSessionPublic> = {},
): CheckoutSessionPublic {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'cs_0123456789abcdef01234567',
    object: 'checkout_session',
    livemode: false,
    mode: 'payment',
    status: 'open',
    payment_status: 'unpaid',
    ui_mode: 'hosted',
    locale: null,
    submit_type: 'auto',
    currency: 'EUR',
    rail: 'card',
    network: null,
    line_items: [lineItemFixture()],
    amount_subtotal: '2000',
    amount_total: '2000',
    total_details: { amount_discount: '0', amount_tax: '0', amount_shipping: '0' },
    discount: null,
    allow_promotion_codes: false,
    automatic_tax: { enabled: false, status: null },
    customer_details: { email: null, name: null, phone: null, address: null, tax_ids: [] },
    customer_email_locked: false,
    billing_address_collection: 'auto',
    shipping_address_collection: null,
    shipping_details: null,
    phone_number_collection: { enabled: false },
    tax_id_collection: { enabled: false },
    custom_fields: [],
    consent_collection: null,
    consent: null,
    terms_of_service_url: null,
    payment_intent: null,
    setup_intent: null,
    success_url: null,
    cancel_url: null,
    confirmation_message: null,
    merchant: { name: 'Test Merchant', avatar_url: null, logo_url: null, description: null },
    branding: {
      icon_url: null,
      logo_url: null,
      primary_color: '#1f6feb',
      accent_color: '#0b1f33',
      font: 'system',
      border_style: 'rounded',
    },
    publishable_key: 'pk_test_abc',
    expires_at: now + 3600,
    ...overrides,
  };
}

export function lineItemFixture(overrides: Partial<CheckoutLineItem> = {}): CheckoutLineItem {
  return {
    id: 'li_0123456789abcdef01234567',
    object: 'item',
    description: 'Notebook',
    price: 'price_0123456789abcdef01234567',
    product: 'prod_0123456789abcdef01234567',
    images: [],
    quantity: 2,
    adjustable_quantity: null,
    currency: 'EUR',
    unit_amount: '1000',
    amount_subtotal: '2000',
    amount_discount: '0',
    amount_tax: '0',
    amount_total: '2000',
    ...overrides,
  };
}

export function linkFixture(overrides: Partial<PublicPaymentLink> = {}): PublicPaymentLink {
  return {
    id: 'link_0123456789abcdef01234567',
    object: 'payment_link',
    livemode: false,
    active: true,
    currency: 'EUR',
    rail: 'card',
    network: null,
    line_items: [lineItemFixture()],
    contribution_amount: null,
    merchant: { name: 'Test Merchant', avatar_url: null, logo_url: null, description: null },
    branding: sessionFixture().branding,
    locale: null,
    ...overrides,
  };
}

/** A gateway refusal as the SDK throws it: a message and the field it names. */
export function refusal(message: string, param?: string): Error {
  return Object.assign(new Error(message), param ? { param } : {});
}
