import { z } from 'zod';
import { listOf } from '../../common/envelopes';
import { defineObject, type Expand } from '../../common/objects';
import {
  expandOnlyQuery,
  idParam,
  listQuery,
  queryUnixSeconds,
  unixSecondsParam,
} from '../../common/params';
import { livemode, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { METER_AGGREGATIONS, METER_STATUSES } from '../../vocabulary/catalog';

/**
 * Usage meters (`mtr_…`, ADR 0018 §7): usage events named `event_name`,
 * attributed to a customer by `customer_mapping.event_payload_key` of their
 * payload and measured by `value_settings.event_payload_key`. A metered price
 * (`recurring.meter`) bills its aggregate per period, in arrears.
 */
export const billingMeterSchema = defineObject(
  'billing.meter',
  'BillingMeter',
  z
    .object({
      id: z.string(),
      object: z.literal('billing.meter'),
      livemode,
      display_name: z.string(),
      event_name: z.string().describe('The `event_name` of the meter events it counts.'),
      default_aggregation: z
        .object({
          formula: z
            .enum(METER_AGGREGATIONS)
            .describe("How a period's events combine into the quantity billed."),
        })
        .strict(),
      customer_mapping: z
        .object({
          type: z.literal('by_id'),
          event_payload_key: z
            .string()
            .describe('The payload key carrying the customer (`cus_…`).'),
        })
        .strict(),
      value_settings: z
        .object({
          event_payload_key: z.string().describe('The payload key carrying the value.'),
        })
        .strict(),
      status: z.enum(METER_STATUSES),
      created: unixSeconds,
      updated: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'mtr_0193b8f2c1a87d3e9f4e',
        object: 'billing.meter',
        livemode: false,
        display_name: 'API calls',
        event_name: 'api_call',
        default_aggregation: { formula: 'sum' },
        customer_mapping: { type: 'by_id', event_payload_key: 'peable_customer_id' },
        value_settings: { event_payload_key: 'value' },
        status: 'active',
        created: 1793750400,
        updated: 1793750400,
      },
    ],
  },
);
export type BillingMeter = Expand<z.output<typeof billingMeterSchema>>;

/**
 * One usage event, `POST /v1/billing/meter_events`. `identifier` makes it
 * idempotent: the same identifier is the same event, forever.
 */
export const billingMeterEventSchema = defineObject(
  'billing.meter_event',
  'BillingMeterEvent',
  z
    .object({
      object: z.literal('billing.meter_event'),
      livemode,
      identifier: z.string(),
      event_name: z.string(),
      payload: z
        .record(z.string(), z.string())
        .describe('The payload as received: the customer key and the value, as strings.'),
      timestamp: unixSeconds,
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        object: 'billing.meter_event',
        livemode: false,
        identifier: 'req_8f3a2c',
        event_name: 'api_call',
        payload: { peable_customer_id: 'cus_0193b8f2c1a87d3e9f4a', value: '25' },
        timestamp: 1793750400,
        created: 1793750400,
      },
    ],
  },
);
export type BillingMeterEvent = Expand<z.output<typeof billingMeterEventSchema>>;

/** A customer's aggregate over a window: `GET /v1/billing/meters/{id}/event_summaries`. */
export const billingMeterEventSummarySchema = defineObject(
  'billing.meter_event_summary',
  'BillingMeterEventSummary',
  z
    .object({
      id: z.string(),
      object: z.literal('billing.meter_event_summary'),
      livemode,
      meter: z.string().describe('The meter (`mtr_…`).'),
      aggregated_value: z
        .string()
        .describe('The aggregate, as an integer string (it can exceed a JS number).'),
      start_time: unixSeconds,
      end_time: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'mtrsum_0193b8f2c1a87d3e9f4e_1793750400',
        object: 'billing.meter_event_summary',
        livemode: false,
        meter: 'mtr_0193b8f2c1a87d3e9f4e',
        aggregated_value: '1250',
        start_time: 1793750400,
        end_time: 1796342400,
      },
    ],
  },
);
export type BillingMeterEventSummary = Expand<z.output<typeof billingMeterEventSummarySchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'billing.meter': BillingMeter;
    'billing.meter_event': BillingMeterEvent;
    'billing.meter_event_summary': BillingMeterEventSummary;
  }
}

const payloadKey = z.string().regex(/^[A-Za-z0-9_]{1,100}$/);
const eventName = z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/);
const displayName = z.string().min(1).max(250);

export const createBillingMeterParams = z
  .object({
    display_name: displayName,
    event_name: eventName,
    default_aggregation: z.object({ formula: z.enum(METER_AGGREGATIONS) }).strict(),
    customer_mapping: z
      .object({ type: z.literal('by_id'), event_payload_key: payloadKey })
      .strict()
      .optional()
      .describe("Default `{ type: 'by_id', event_payload_key: 'peable_customer_id' }`."),
    value_settings: z
      .object({ event_payload_key: payloadKey })
      .strict()
      .optional()
      .describe("Default `{ event_payload_key: 'value' }`."),
  })
  .strict();
export type CreateBillingMeterParams = z.input<typeof createBillingMeterParams>;

export const updateBillingMeterParams = z.object({ display_name: displayName.optional() }).strict();
export type UpdateBillingMeterParams = z.input<typeof updateBillingMeterParams>;

/** The body of `deactivate` / `reactivate`: nothing. */
export const billingMeterStatusParams = z.object({}).strict();

export const listBillingMetersQuery = listQuery({ status: z.enum(METER_STATUSES).optional() });
export type BillingMeterListParams = z.input<typeof listBillingMetersQuery>;

export const billingMeterEventSummariesQuery = z
  .object({
    customer: idParam.describe('The customer (`cus_…`) whose usage is aggregated.'),
    start_time: queryUnixSeconds.describe('The window start (inclusive).'),
    end_time: queryUnixSeconds.describe('The window end (exclusive), after `start_time`.'),
  })
  .strict();
export type BillingMeterEventSummaryParams = z.input<typeof billingMeterEventSummariesQuery>;

export const createBillingMeterEventParams = z
  .object({
    event_name: eventName,
    payload: z.record(z.string().max(100), z.string().max(255)),
    identifier: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Default: a fresh one — pass your own so a retry is not counted twice.'),
    timestamp: unixSecondsParam
      .optional()
      .describe('Default now. At most 35 days in the past, 5 minutes in the future.'),
  })
  .strict();
export type CreateBillingMeterEventParams = z.input<typeof createBillingMeterEventParams>;

const id = { id: 'The meter (`mtr_…`).' };

export const meterRoutes = [
  defineRoute({
    operationId: 'createBillingMeter',
    method: 'post',
    path: '/v1/billing/meters',
    tag: 'Meters',
    summary: 'Create a meter',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createBillingMeterParams,
    response: billingMeterSchema,
    sdk: 'billing.meters.create',
  }),
  defineRoute({
    operationId: 'listBillingMeters',
    method: 'get',
    path: '/v1/billing/meters',
    tag: 'Meters',
    summary: 'List meters',
    auth: 'service',
    scope: 'payments:read',
    query: listBillingMetersQuery,
    response: listOf(billingMeterSchema),
    sdk: 'billing.meters.list',
    expandable: 'billing.meter',
  }),
  defineRoute({
    operationId: 'retrieveBillingMeter',
    method: 'get',
    path: '/v1/billing/meters/{id}',
    tag: 'Meters',
    summary: 'Retrieve a meter',
    auth: 'service',
    scope: 'payments:read',
    params: id,
    query: expandOnlyQuery,
    response: billingMeterSchema,
    sdk: 'billing.meters.retrieve',
  }),
  defineRoute({
    operationId: 'updateBillingMeter',
    method: 'post',
    path: '/v1/billing/meters/{id}',
    tag: 'Meters',
    summary: 'Update a meter',
    description: 'Only `display_name` changes.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: id,
    body: updateBillingMeterParams,
    response: billingMeterSchema,
    sdk: 'billing.meters.update',
  }),
  defineRoute({
    operationId: 'deactivateBillingMeter',
    method: 'post',
    path: '/v1/billing/meters/{id}/deactivate',
    tag: 'Meters',
    summary: 'Deactivate a meter',
    description: 'An inactive meter accepts no events.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: id,
    body: billingMeterStatusParams,
    response: billingMeterSchema,
    sdk: 'billing.meters.deactivate',
  }),
  defineRoute({
    operationId: 'reactivateBillingMeter',
    method: 'post',
    path: '/v1/billing/meters/{id}/reactivate',
    tag: 'Meters',
    summary: 'Reactivate a meter',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: id,
    body: billingMeterStatusParams,
    response: billingMeterSchema,
    sdk: 'billing.meters.reactivate',
  }),
  defineRoute({
    operationId: 'listBillingMeterEventSummaries',
    method: 'get',
    path: '/v1/billing/meters/{id}/event_summaries',
    tag: 'Meters',
    summary: "A customer's usage over a window",
    description: 'One summary: the aggregate of the window `[start_time, end_time)`.',
    auth: 'service',
    scope: 'payments:read',
    params: id,
    query: billingMeterEventSummariesQuery,
    response: listOf(billingMeterEventSummarySchema),
    sdk: 'billing.meters.listEventSummaries',
  }),
  defineRoute({
    operationId: 'createBillingMeterEvent',
    method: 'post',
    path: '/v1/billing/meter_events',
    tag: 'Meters',
    summary: 'Record a meter event',
    description:
      'The customer must be yours and the value a non-negative integer. A repeated `identifier` answers the stored event.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createBillingMeterEventParams,
    response: billingMeterEventSchema,
    sdk: 'billing.meterEvents.create',
  }),
] as const;
