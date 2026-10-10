import { z } from 'zod';
import { CURRENCY_CODES, PAYMENT_INTENT_RAILS, isBaseUnitString } from '@peable.to/shared-types';

/**
 * The rail/amount/currency/network fragment every creating route shares.
 *
 * ONE definition, three routes: `POST /v1/payment_intents`,
 * `POST /v1/payment_links` and `POST /v1/checkout_sessions` all accept the same
 * four fields and mean the same thing by them. Three copies of a zod object
 * would be three places for the card rail to be accepted on two of them and
 * refused on the third — which is exactly the kind of drift the closed value
 * sets in `db/schema/valueSets.ts` exist to prevent one layer down.
 *
 * What this fragment does NOT do is decide coherence. `rail` + `currency` +
 * `network` have to agree with each other and with the merchant, and that is
 * `createIntent`'s `assertRailCurrency` and network firewall — a service-level
 * rule with one owner, not a zod refinement copied per route. Routes translate
 * its `RailMismatchError` into a 422.
 */
export const railBodyFields = {
  amount: z.string().refine(isBaseUnitString, 'amount must be a minor-unit integer string'),
  /**
   * Optional, defaulting to `faircoin` in the service. Absent means the rail
   * this gateway shipped with, so every integration written before ADR 0001
   * keeps working with no change at all.
   */
  rail: z.enum(PAYMENT_INTENT_RAILS as [string, ...string[]]).optional(),
  /** Optional: `FAIR` follows from the faircoin rail; the card rail must name one. */
  currency: z.enum(CURRENCY_CODES as unknown as [string, ...string[]]).optional(),
  /**
   * Optional NOW, and it was required before.
   *
   * This is the one backwards-compatibility risk in the fragment: a caller that
   * previously got a 422 for omitting `network` now reaches the service. It
   * still fails — `createIntent` refuses a faircoin intent with no network —
   * but with a different message. Making it conditionally required in zod would
   * need a refinement that duplicates the rail rules the service owns.
   */
  network: z.enum(['mainnet', 'testnet']).optional(),
} as const;
