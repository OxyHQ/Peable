import type { Dispute, DisputeEvidence, Merchant } from '@peable.to/shared-types';
import type { RestClient } from '../core/client';

/**
 * The merchant this credential speaks for, and the disputes raised against it.
 *
 * ## One merchant per application PER ENVIRONMENT
 *
 * There is no merchant id in any of these calls. The gateway resolves the
 * merchant from the credential — its Oxy application AND that credential's
 * environment — so a development credential and a production one address
 * different merchants and cannot be made to address each other's.
 *
 * ## The FairCoin half is optional
 *
 * `network` and `xpub` are two halves of ONE capability and are supplied
 * together or not at all. A merchant that only takes cards registers with
 * neither; supplying a watch-only key for a chain they never intend to use
 * would mean custodying a real key or, worse, registering a fixture that
 * silently makes their receive addresses underivable by their own wallet.
 *
 * Peable never accepts a PRIVATE extended key. The gateway derives a child from
 * whatever it is given and refuses anything that can spend — that refusal is
 * the non-custody firewall, not a validation nicety.
 */

export interface RegisterMerchantParams {
  /** Both, or neither. Omit both for a card-only merchant. */
  network?: 'mainnet' | 'testnet';
  /** A WATCH-ONLY account extended public key. An `xprv` is refused. */
  xpub?: string;
  webhookUrl?: string;
  webhookSecret?: string;
  requiredConfirmations?: number;
  displayName?: string;
  /** A bare Oxy file id, never a URL. */
  avatarFileId?: string;
  description?: string;
}

/**
 * `null` CLEARS a field; omitting it leaves it alone.
 *
 * The distinction is by `undefined` rather than by falsiness, so a webhook URL
 * can be removed rather than only replaced.
 */
export interface UpdateMerchantParams {
  webhookUrl?: string | null;
  webhookSecret?: string | null;
  requiredConfirmations?: number;
  displayName?: string | null;
  avatarFileId?: string | null;
  description?: string | null;
}

export interface DisputeList {
  object: 'list';
  data: Dispute[];
}

export class MerchantsResource {
  constructor(private readonly client: RestClient) {}

  register(params: RegisterMerchantParams = {}): Promise<Merchant> {
    return this.client.request<Merchant>('POST', '/v1/merchants', { body: params });
  }

  retrieve(): Promise<Merchant> {
    return this.client.request<Merchant>('GET', '/v1/merchants/me');
  }

  update(params: UpdateMerchantParams): Promise<Merchant> {
    return this.client.request<Merchant>('PATCH', '/v1/merchants/me', { body: params });
  }
}

/**
 * Evidence — TEXT only, in the gateway's field names.
 *
 * Every field is your own words or your own record. They are forwarded to the
 * card network and **never stored by Peable**: they carry a customer's name,
 * their email, a billing address and correspondence, and the gateway keeps none
 * of that. What it records is THAT you responded and when.
 *
 * FILE attachments are not supported. They need the acquirer's upload API and a
 * policy for the bytes on the way through; offering half of it would let you
 * submit — finally — a defence missing the receipt it rests on.
 *
 * An unknown key is REFUSED rather than dropped, so a misspelled field is a 422
 * now instead of a missing argument discovered when the dispute is decided.
 */
/**
 * The evidence set, re-exported from the wire contract rather than restated.
 *
 * It was written out here as well as in the gateway's provider port, its route
 * schema and its Stripe adapter — four copies of one list. A field added to
 * three of them is a field you send, the gateway accepts, and the network never
 * sees; you would find out when the dispute is decided against you.
 */
export type DisputeEvidenceParams = DisputeEvidence;

/**
 * Disputes: read them, and answer one.
 *
 * A dispute is initiated by the card NETWORK, not by you, so there is nothing
 * to create — the only write is a response. This surface was read-only for a
 * while, because the gateway had no way to deliver evidence and a route that
 * accepted it and did nothing would have been worse than none: you would have
 * believed you had responded.
 */
export class DisputesResource {
  constructor(private readonly client: RestClient) {}

  listForPaymentIntent(paymentIntentId: string): Promise<DisputeList> {
    return this.client.request<DisputeList>(
      'GET',
      `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/disputes`,
    );
  }

  /**
   * Answer a dispute. **One shot.**
   *
   * Submitting is one-way at the card network, so this cannot be revised and a
   * second call does not send a second response — it answers 200 with the
   * dispute as it stands. Send everything you have the first time.
   *
   * Refused (409) when the dispute is already answered, already decided, or
   * past `evidenceDueAt`. That last one is checked by the gateway rather than
   * by the acquirer, so you learn it was the clock and not your request — a
   * late response is the one failure here that no retry fixes.
   */
  submitEvidence(disputeId: string, evidence: DisputeEvidenceParams): Promise<Dispute> {
    return this.client.request<Dispute>(
      'POST',
      `/v1/disputes/${encodeURIComponent(disputeId)}/evidence`,
      { body: evidence },
    );
  }
}
