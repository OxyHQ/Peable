import type { Dispute, Merchant } from '@peable.to/shared-types';
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
 * Disputes are READ-ONLY here, and the absence of a write is deliberate.
 *
 * Every other money surface has one because the merchant initiates. A dispute
 * is initiated by the card network, so the only write worth having is
 * submitting EVIDENCE — and offering that before the gateway can actually
 * deliver it would give merchants a route that accepts their evidence and does
 * nothing with it, which is worse for them than no route at all: they would
 * believe they had responded.
 *
 * So the DEADLINE is exposed (`evidenceDueAt`) and the response is not. Respond
 * through the acquirer relationship you hold until that changes.
 */
export class DisputesResource {
  constructor(private readonly client: RestClient) {}

  listForPaymentIntent(paymentIntentId: string): Promise<DisputeList> {
    return this.client.request<DisputeList>(
      'GET',
      `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/disputes`,
    );
  }
}
