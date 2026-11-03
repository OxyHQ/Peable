import type { WebhookEventType } from './event';

/**
 * A webhook endpoint (`we_…`) — one URL a merchant receives events at, with
 * the event types it wants and the secret deliveries to it are signed with
 * (ADR 0014 D4).
 *
 * A merchant may hold several; every event fans out to each ENABLED endpoint
 * whose `enabled_events` matches it, as one delivery per endpoint.
 */

/** `'*'` subscribes to every event type, including ones added later. */
export type WebhookEnabledEvent = WebhookEventType | '*';

export const WEBHOOK_ENDPOINT_STATUSES = ['enabled', 'disabled'] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

/**
 * Why an endpoint is `disabled`.
 *
 *  - `disabled_by_merchant` — its owner set `disabled: true`.
 *  - `delivery_failures`    — every delivery to it failed for three days
 *    straight, so Peable stopped sending. Re-enabling it (`disabled: false`)
 *    starts the clock again.
 */
export const WEBHOOK_ENDPOINT_DISABLED_REASONS = [
  'disabled_by_merchant',
  'delivery_failures',
] as const;
export type WebhookEndpointDisabledReason = (typeof WEBHOOK_ENDPOINT_DISABLED_REASONS)[number];

/** At most this many endpoints per merchant (per mode). */
export const WEBHOOK_ENDPOINTS_MAX_PER_MERCHANT = 16;

/** The longest a rolled secret may keep signing beside its replacement. */
export const WEBHOOK_SECRET_ROLL_MAX_EXPIRES_IN_SECONDS = 24 * 60 * 60;

export interface WebhookEndpoint {
  id: string;
  object: 'webhook_endpoint';
  /** The mode of the merchant that owns it (ADR 0017). */
  livemode: boolean;
  url: string;
  description: string | null;
  enabled_events: WebhookEnabledEvent[];
  status: WebhookEndpointStatus;
  /** `null` exactly when `status` is `enabled`. */
  disabled_reason: WebhookEndpointDisabledReason | null;
  /** The wire version events are rendered with for this endpoint. */
  api_version: string;
  metadata: Record<string, string>;
  /**
   * The signing secret (`whsec_…`). Present ONLY on the response that
   * created it — the create, and a `roll_secret`. Peable never shows it again;
   * a lost secret is rolled, not retrieved.
   */
  secret?: string;
  created: number;
  updated_at: number;
}

/** What `DELETE /v1/webhook_endpoints/:id` answers. */
export interface DeletedWebhookEndpoint {
  id: string;
  object: 'webhook_endpoint';
  deleted: true;
}

export interface CreateWebhookEndpointParams {
  /** An `https` URL (a test-mode endpoint may also use `http`), ports 80/443 only. */
  url: string;
  enabled_events: WebhookEnabledEvent[];
  description?: string;
  metadata?: Record<string, string>;
}

export interface UpdateWebhookEndpointParams {
  url?: string;
  enabled_events?: WebhookEnabledEvent[];
  /** `true` stops deliveries; `false` re-enables an endpoint, whatever disabled it. */
  disabled?: boolean;
  /** `''` clears it. */
  description?: string;
  /** Merged: named keys are set, a key sent as `''` is removed. */
  metadata?: Record<string, string>;
}

export interface RollWebhookEndpointSecretParams {
  /**
   * How long the PREVIOUS secret keeps signing beside the new one, in seconds
   * (0–86400, default 0). While both are live every delivery carries two
   * `v1=` signatures, so a receiver can switch secrets without a gap.
   */
  expires_in_seconds?: number;
}
