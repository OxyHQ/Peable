import { PEABLE_DOCS_URL } from '../config';

/**
 * Where each object is explained in the integration guide — what an empty
 * list's "Learn more" opens. GitHub's heading anchors.
 */
const ANCHORS = {
  integration: '',
  payments: '2-server-create-a-checkout-session',
  cards: 'card-payments-customers-saved-cards-confirm-and-capture-adr-0019',
  catalog: 'catalog-products-prices-coupons-promotion-codes-adr-0018',
  billing: 'billing-subscriptions-invoices-credit-notes-entitlements-adr-0018',
  links: 'payment-links-a-shareable-url-over-your-prices',
  webhooks: '4-webhooks--the-source-of-truth-for-fulfillment',
  connect: 'connected_accountupdated--the-one-event-that-is-not-about-a-payment',
  testMode: 'test-vs-live',
  branding: 'branding',
} as const;

export type DocsTopic = keyof typeof ANCHORS;

export function docsUrl(topic: DocsTopic): string {
  const anchor = ANCHORS[topic];
  return anchor ? `${PEABLE_DOCS_URL}#${anchor}` : PEABLE_DOCS_URL;
}
