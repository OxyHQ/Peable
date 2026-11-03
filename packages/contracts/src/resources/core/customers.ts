import { z } from 'zod';
import {
  addressParams,
  addressSchema,
  emailParam,
  shippingParams,
  shippingSchema,
} from '../../common/address';
import { deletedOf, listOf, searchResultOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand, expandable } from '../../common/objects';
import {
  clearable,
  expandOnlyQuery,
  expandParam,
  idParam,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
  searchQuery,
} from '../../common/params';
import { currency, livemode, metadata, signedAmount, unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';

/**
 * Customers (`cus_…`) — Orbit's own object (ADR 0016). A provider customer is an
 * internal binding created lazily, per mode, when a card payment method is
 * first attached; it is never serialized.
 */
export const customerSchema = defineObject(
  'customer',
  'Customer',
  z
    .object({
      id: z.string(),
      object: z.literal('customer'),
      livemode,
      email: z.string().nullable(),
      name: z.string().nullable(),
      phone: z.string().nullable(),
      description: z.string().nullable(),
      address: addressSchema.nullable(),
      shipping: shippingSchema.nullable(),
      invoice_settings: z
        .object({
          default_payment_method: expandable(
            'payment_method',
            '`pm_…`, or the PaymentMethod with `expand[]=invoice_settings.default_payment_method`.',
          ).nullable(),
        })
        .strict(),
      metadata,
      balance: signedAmount.describe(
        'SIGNED base units in `currency`: negative is credit the customer holds, positive is owed. Applied to the next invoice when it finalizes.',
      ),
      currency: currency
        .nullable()
        .describe(
          "The customer's billing currency, set by its first balance movement, subscription or invoice.",
        ),
      test_clock: z
        .string()
        .nullable()
        .describe('The test clock (`clock_…`) it lives on; test mode only.'),
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'cus_0193b8f2c1a87d3e9f4a',
        object: 'customer',
        livemode: false,
        email: 'jenny@example.com',
        name: 'Jenny Rosen',
        phone: null,
        description: null,
        address: null,
        shipping: null,
        invoice_settings: { default_payment_method: null },
        metadata: { order_id: '6735' },
        balance: '0',
        currency: 'EUR',
        test_clock: null,
        created: 1793750400,
      },
    ],
  },
);
export type Customer = Expand<z.output<typeof customerSchema>>;

/** A deleted customer: a tombstone that still retrieves. */
export const deletedCustomerSchema = defineComponent('DeletedCustomer', deletedOf('customer'));
export type DeletedCustomer = z.output<typeof deletedCustomerSchema>;

declare module '../../common/objects' {
  interface ObjectMap {
    customer: Customer;
  }
}

const name = z.string().max(500);
const phone = z.string().max(40);
const description = z.string().max(1000);

export const createCustomerParams = z
  .object({
    email: emailParam.optional(),
    name: name.optional(),
    phone: phone.optional(),
    description: description.optional(),
    address: addressParams.optional(),
    shipping: shippingParams.optional(),
    invoice_settings: z.object({ default_payment_method: idParam.optional() }).strict().optional(),
    metadata: metadataCreateParam.optional(),
    test_clock: idParam
      .optional()
      .describe('Create only, test mode only: attach the customer to a test clock (`clock_…`).'),
    expand: expandParam.optional(),
  })
  .strict();
export type CreateCustomerParams = z.input<typeof createCustomerParams>;

/** A field sent as `""` is cleared; `metadata` is a patch. */
export const updateCustomerParams = z
  .object({
    email: clearable(emailParam).optional(),
    name: clearable(name).optional(),
    phone: clearable(phone).optional(),
    description: clearable(description).optional(),
    address: clearable(addressParams).optional(),
    shipping: clearable(shippingParams).optional(),
    invoice_settings: z
      .object({ default_payment_method: clearable(idParam).optional() })
      .strict()
      .optional(),
    metadata: metadataUpdateParam.optional(),
    expand: expandParam.optional(),
  })
  .strict();
export type UpdateCustomerParams = z.input<typeof updateCustomerParams>;

export const listCustomersQuery = listQuery({
  email: z.string().min(1).max(512).optional().describe('Exact match.'),
});
export type ListCustomersParams = z.input<typeof listCustomersQuery>;

const customerOrDeleted = z.union([customerSchema, deletedCustomerSchema]);

export const customerRoutes = [
  defineRoute({
    operationId: 'createCustomer',
    method: 'post',
    path: '/v1/customers',
    tag: 'Customers',
    summary: 'Create a customer',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createCustomerParams,
    response: customerSchema,
    status: 201,
    sdk: 'customers.create',
    expandable: 'customer',
  }),
  defineRoute({
    operationId: 'listCustomers',
    method: 'get',
    path: '/v1/customers',
    tag: 'Customers',
    summary: 'List customers',
    description: 'Your live customers, newest first. Deleted customers are not listed.',
    auth: 'service',
    scope: 'payments:read',
    query: listCustomersQuery,
    response: listOf(customerSchema),
    sdk: 'customers.list',
    expandable: 'customer',
  }),
  defineRoute({
    operationId: 'retrieveCustomer',
    method: 'get',
    path: '/v1/customers/{id}',
    tag: 'Customers',
    summary: 'Retrieve a customer',
    description: 'A deleted customer answers `{ id, object: "customer", deleted: true }`.',
    auth: 'service',
    scope: 'payments:read',
    params: { id: 'The customer (`cus_…`).' },
    query: expandOnlyQuery,
    response: customerOrDeleted,
    sdk: 'customers.retrieve',
    expandable: 'customer',
  }),
  defineRoute({
    operationId: 'updateCustomer',
    method: 'post',
    path: '/v1/customers/{id}',
    tag: 'Customers',
    summary: 'Update a customer',
    description: 'A field sent as `""` is cleared; `metadata` is a patch.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: { id: 'The customer (`cus_…`).' },
    body: updateCustomerParams,
    response: customerSchema,
    sdk: 'customers.update',
    expandable: 'customer',
  }),
  defineRoute({
    operationId: 'deleteCustomer',
    method: 'delete',
    path: '/v1/customers/{id}',
    tag: 'Customers',
    summary: 'Delete a customer',
    description:
      'A tombstone, with every saved payment method of the customer detached. Deleting a deleted customer answers the tombstone again.',
    auth: 'service',
    scope: 'payments:write',
    params: { id: 'The customer (`cus_…`).' },
    response: deletedCustomerSchema,
    sdk: 'customers.del',
  }),
  defineRoute({
    operationId: 'searchCustomers',
    method: 'get',
    path: '/v1/customers/search',
    tag: 'Customers',
    summary: 'Search customers',
    description:
      "Stripe's query language over `email`, `name`, `phone`, `created` and `metadata['key']`.",
    auth: 'service',
    scope: 'payments:read',
    query: searchQuery,
    response: searchResultOf(customerSchema),
    sdk: 'customers.search',
    expandable: 'customer',
  }),
] as const;
