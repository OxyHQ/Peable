/**
 * The schema object drizzle and drizzle-kit are both built from.
 *
 * This is the one barrel this package has, and it exists because drizzle's
 * `drizzle(client, { schema })` and drizzle-kit's `schema:` both take a MODULE,
 * not a list of tables — a table missing from here is a table drizzle-kit never
 * generates DDL for and drizzle cannot resolve a relation through.
 */

export { merchants } from './merchants';
export { checkoutSessions, paymentIntents, paymentLinks } from './payments';
export {
  SOCIAL_RECEIVE_FIRST_FRESH_INDEX,
  socialReceiveCursors,
  socialSendAttributions,
} from './social';
export { webhookDeliveries } from './webhooks';
export { providerEvents } from './providerEvents';
export { connectedAccounts } from './connectedAccounts';
export { transfers } from './transfers';
export { refunds } from './refunds';
export { disputes } from './disputes';
