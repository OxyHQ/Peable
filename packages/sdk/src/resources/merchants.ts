import type {
  Merchant,
  MerchantBranding,
  MerchantEmailSettings,
  UpdateMerchantBrandingParams,
  UpdateMerchantEmailSettingsParams,
} from '@peable.to/shared-types';
import type { RestClient } from '../core/client';

/**
 * The merchant this credential speaks for. Disputes are `peable.disputes`.
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
  required_confirmations?: number;
  display_name?: string;
  /**
   * A bare Oxy file id, never a URL. It must name an active, public or unlisted
   * file owned by your application, by the account that owns it, or by the
   * user your token acts for — anything else is refused with a 400 (a 503 when
   * Oxy cannot be asked). If the file is later deleted or taken down, Peable
   * clears it.
   */
  avatar_file_id?: string;
  description?: string;
}

/**
 * `null` CLEARS a field; omitting it leaves it alone.
 *
 * The distinction is by `undefined` rather than by falsiness, so a description
 * can be removed rather than only replaced. Where events are sent is not a
 * merchant field: it is `peable.webhookEndpoints`.
 */
export interface UpdateMerchantParams {
  required_confirmations?: number;
  display_name?: string | null;
  /** Same rule as {@link RegisterMerchantParams.avatar_file_id}; `null` removes it. */
  avatar_file_id?: string | null;
  /**
   * The wide wordmark payer surfaces show in their header: a `file_…` of
   * purpose `business_logo` (`peable.files.create`), beside the avatar (the
   * square identity image), never instead of it. Set on an update only — a File
   * needs the merchant that owns it. `null` removes it.
   */
  business_logo?: string | null;
  description?: string | null;
}

/**
 * How your hosted and embedded checkout and Peable's receipts look. Colours
 * are `#rrggbb`, the font and border style come from fixed safe lists, and the
 * logo is your `business_logo` File (`peable.files.create`, purpose
 * `business_logo`) — the same field `merchants.update({ business_logo })` sets.
 */
export class MerchantBrandingResource {
  constructor(private readonly client: RestClient) {}

  retrieve(): Promise<MerchantBranding> {
    return this.client.request<MerchantBranding>('GET', '/v1/merchants/me/branding');
  }

  /** `null` resets a field to Peable's default; omitting it leaves it alone. */
  update(params: UpdateMerchantBrandingParams): Promise<MerchantBranding> {
    return this.client.request<MerchantBranding>('POST', '/v1/merchants/me/branding', {
      body: params,
    });
  }
}

/** Which customer emails Peable sends for you: receipts, refund notices, checkout confirmations. */
export class MerchantEmailSettingsResource {
  constructor(private readonly client: RestClient) {}

  retrieve(): Promise<MerchantEmailSettings> {
    return this.client.request<MerchantEmailSettings>('GET', '/v1/merchants/me/email_settings');
  }

  update(params: UpdateMerchantEmailSettingsParams): Promise<MerchantEmailSettings> {
    return this.client.request<MerchantEmailSettings>('POST', '/v1/merchants/me/email_settings', {
      body: params,
    });
  }
}

export class MerchantsResource {
  readonly branding: MerchantBrandingResource;
  readonly emailSettings: MerchantEmailSettingsResource;

  constructor(private readonly client: RestClient) {
    this.branding = new MerchantBrandingResource(client);
    this.emailSettings = new MerchantEmailSettingsResource(client);
  }

  register(
    params: RegisterMerchantParams = {},
    options?: { idempotencyKey: string },
  ): Promise<Merchant> {
    return this.client.request<Merchant>('POST', '/v1/merchants', {
      body: params,
      idempotencyKey: options?.idempotencyKey,
    });
  }

  retrieve(): Promise<Merchant> {
    return this.client.request<Merchant>('GET', '/v1/merchants/me');
  }

  update(params: UpdateMerchantParams): Promise<Merchant> {
    return this.client.request<Merchant>('POST', '/v1/merchants/me', { body: params });
  }
}
