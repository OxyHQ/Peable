/**
 * Billing settings (ADR 0018 §6) and usage meters (ADR 0018 §7).
 *
 * ## Dunning defaults
 *
 * A merchant that never opens the settings bills with: retries 1, 3, 5 and
 * 7 days after each failed attempt (four retries over 16 days), then the
 * invoice is marked uncollectible and the subscription CANCELLED; invoices
 * are due 30 days after finalization (`send_invoice`); the payer is emailed
 * the invoice and every failed payment.
 *
 * ## Meters
 *
 * A meter listens for events named `event_name`; each event names its
 * customer under `customer_mapping.event_payload_key` (a `cus_…`) and its
 * value under `value_settings.event_payload_key` (a non-negative integer).
 * `identifier` makes an event idempotent forever. A metered price
 * (`recurring.meter`) bills the period's aggregate — `sum`, `count` or the
 * `last` value — in arrears, at renewal.
 */
import type {
  BillingMeter,
  BillingMeterEvent,
  BillingSettings,
  MeterAggregation,
} from '@peable.to/shared-types';
import { randomUUID } from 'node:crypto';
import { findLiveCustomerForMerchant } from '../../db/customers/customerRepository';
import type { MerchantRow } from '../../db/merchants/merchantRepository';
import {
  aggregateMeter,
  findActiveMeterByEvent,
  findMeterForMerchant,
  insertMeter,
  insertMeterEvent,
  updateMeter,
  type MeterEventRow,
  type MeterRow,
} from '../../db/billingEngine/meterRepository';
import {
  ensureBillingSettings,
  updateBillingSettings,
  type BillingSettingsPatch,
  type BillingSettingsRow,
} from '../../db/billingEngine/settingsRepository';
import { getDb } from '../../db/postgres';
import { newId } from '../../lib/ids';
import { toUnix } from '../../lib/time';
import { kickWebhookOutbox } from '../webhookOutbox';
import { BillingEngineError, invalid, missing } from './errors';
import { engineNow } from './runtime';
import { recordBillingEvent } from './transitions';

export function toBillingSettingsDTO(row: BillingSettingsRow, livemode: boolean): BillingSettings {
  return {
    object: 'billing_settings',
    livemode,
    invoice_prefix: row.invoicePrefix,
    next_invoice_sequence: row.nextInvoiceNumber,
    default_days_until_due: row.defaultDaysUntilDue,
    dunning: {
      retry_schedule_days: row.retryScheduleDays,
      final_action: row.finalAction,
      invoice_action: row.invoiceAction,
    },
    emails: {
      invoice_finalized: row.emailInvoiceFinalized,
      payment_failed: row.emailPaymentFailed,
    },
    updated: toUnix(row.updatedAt),
  };
}

export async function getBillingSettings(merchant: MerchantRow): Promise<BillingSettingsRow> {
  return ensureBillingSettings(getDb(), merchant.id);
}

export async function changeBillingSettings(
  merchant: MerchantRow,
  patch: BillingSettingsPatch,
): Promise<BillingSettingsRow> {
  return updateBillingSettings(getDb(), merchant.id, patch);
}

// ---- Meters --------------------------------------------------------------------------

export function toMeterDTO(row: MeterRow): BillingMeter {
  return {
    id: row.publicId,
    object: 'billing.meter',
    livemode: row.livemode,
    display_name: row.displayName,
    event_name: row.eventName,
    default_aggregation: { formula: row.aggregation },
    customer_mapping: { type: 'by_id', event_payload_key: row.customerPayloadKey },
    value_settings: { event_payload_key: row.valuePayloadKey },
    status: row.status,
    created: toUnix(row.createdAt),
    updated: toUnix(row.updatedAt),
  };
}

export async function createMeter(
  merchant: MerchantRow,
  input: {
    displayName: string;
    eventName: string;
    aggregation: MeterAggregation;
    customerPayloadKey?: string;
    valuePayloadKey?: string;
  },
): Promise<MeterRow> {
  const row = await insertMeter(getDb(), {
    publicId: newId('mtr'),
    merchantId: merchant.id,
    displayName: input.displayName,
    eventName: input.eventName,
    aggregation: input.aggregation,
    customerPayloadKey: input.customerPayloadKey ?? 'peable_customer_id',
    valuePayloadKey: input.valuePayloadKey ?? 'value',
  });
  if (row === 'event_name_taken') {
    throw new BillingEngineError(
      'resource_already_exists',
      'an active meter already listens for this event_name',
      'event_name',
    );
  }
  await recordBillingEvent(getDb(), merchant.id, 'billing.meter.created', toMeterDTO(row));
  kickWebhookOutbox();
  return row;
}

export async function changeMeter(
  merchant: MerchantRow,
  publicId: string,
  change: { displayName?: string; status?: 'active' | 'inactive' },
): Promise<MeterRow> {
  const db = getDb();
  const meter = await findMeterForMerchant(db, publicId, merchant.id);
  if (!meter) throw missing('meter');
  const row = await updateMeter(db, meter.id, change);
  if (row === 'event_name_taken') {
    throw new BillingEngineError(
      'resource_already_exists',
      'another active meter now listens for this event_name',
      'event_name',
    );
  }
  const type =
    change.status && change.status !== meter.status
      ? change.status === 'inactive'
        ? 'billing.meter.deactivated'
        : 'billing.meter.reactivated'
      : 'billing.meter.updated';
  await recordBillingEvent(db, merchant.id, type, toMeterDTO(row));
  kickWebhookOutbox();
  return row;
}

const MAX_PAST_MS = 35 * 86_400_000;
const MAX_FUTURE_MS = 5 * 60_000;

export function toMeterEventDTO(row: MeterEventRow, livemode: boolean): BillingMeterEvent {
  return {
    object: 'billing.meter_event',
    livemode,
    identifier: row.identifier,
    event_name: row.eventName,
    payload: row.payload,
    timestamp: toUnix(row.timestamp),
    created: toUnix(row.createdAt),
  };
}

/**
 * `POST /v1/billing/meter_events`. The customer must be the merchant's, the
 * value a non-negative integer; a repeated identifier answers the stored event.
 */
export async function recordMeterEvent(
  merchant: MerchantRow,
  input: {
    eventName: string;
    payload: Record<string, string>;
    identifier?: string;
    timestamp?: number;
  },
): Promise<MeterEventRow> {
  const db = getDb();
  const meter = await findActiveMeterByEvent(db, merchant.id, input.eventName);
  if (!meter)
    throw new BillingEngineError(
      'resource_missing',
      `no active meter listens for '${input.eventName}'`,
      'event_name',
    );
  const customerId = input.payload[meter.customerPayloadKey];
  if (!customerId) {
    throw new BillingEngineError(
      'parameter_missing',
      `the payload names no customer under '${meter.customerPayloadKey}'`,
      `payload[${meter.customerPayloadKey}]`,
    );
  }
  const customer = await findLiveCustomerForMerchant(db, customerId, merchant.id);
  if (!customer) {
    throw new BillingEngineError(
      'meter_event_customer_missing',
      `no such customer: '${customerId}'`,
      `payload[${meter.customerPayloadKey}]`,
    );
  }
  const value =
    input.payload[meter.valuePayloadKey] ?? (meter.aggregation === 'count' ? '1' : undefined);
  if (value === undefined || !/^(0|[1-9][0-9]{0,17})$/.test(value)) {
    throw invalid(
      `the payload's '${meter.valuePayloadKey}' is a non-negative integer`,
      `payload[${meter.valuePayloadKey}]`,
    );
  }
  // The customer's clock (a test clock's frozen time in test mode, ADR 0018 §3).
  const now = await engineNow(db, customer.testClockId);
  const timestamp = input.timestamp !== undefined ? new Date(input.timestamp * 1000) : now;
  if (
    timestamp.getTime() < now.getTime() - MAX_PAST_MS ||
    timestamp.getTime() > now.getTime() + MAX_FUTURE_MS
  ) {
    throw invalid(
      'timestamp is at most 35 days in the past and 5 minutes in the future',
      'timestamp',
    );
  }
  const { event } = await insertMeterEvent(db, {
    merchantId: merchant.id,
    meterId: meter.id,
    customerId: customer.id,
    identifier: input.identifier ?? randomUUID(),
    eventName: input.eventName,
    value,
    payload: input.payload,
    timestamp,
  });
  return event;
}

export async function meterSummary(
  merchant: MerchantRow,
  publicId: string,
  input: { customer: string; startTime: number; endTime: number },
) {
  const db = getDb();
  const meter = await findMeterForMerchant(db, publicId, merchant.id);
  if (!meter) throw missing('meter');
  const customer = await findLiveCustomerForMerchant(db, input.customer, merchant.id);
  if (!customer)
    throw new BillingEngineError(
      'resource_missing',
      `no such customer: '${input.customer}'`,
      'customer',
    );
  if (input.endTime <= input.startTime) throw invalid('end_time is after start_time', 'end_time');
  const value = await aggregateMeter(db, {
    meterId: meter.id,
    customerId: customer.id,
    start: new Date(input.startTime * 1000),
    end: new Date(input.endTime * 1000),
    aggregation: meter.aggregation,
  });
  return {
    id: `mtrsum_${meter.publicId.slice(4)}_${input.startTime}`,
    object: 'billing.meter_event_summary' as const,
    livemode: meter.livemode,
    meter: meter.publicId,
    aggregated_value: value.toString(),
    start_time: input.startTime,
    end_time: input.endTime,
  };
}
