import { z } from 'zod';
import { addressParams, addressSchema } from '../../common/address';
import { deletedOf, listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import {
  emptyQuery,
  listQuery,
  metadataCreateParam,
  metadataUpdateParam,
} from '../../common/params';
import { livemode, metadata } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TERMINAL_LIMITS } from '../../vocabulary/terminal';

/**
 * Terminal locations (ADR 0024) — Stripe's `terminal.location`: a place
 * readers are registered to, and the scope a connection token can be limited
 * to. Created at the provider on the platform account, bound to an Orbit
 * `tml_…`; the provider's id never reaches the wire.
 */
export const terminalLocationSchema = defineObject(
  'terminal.location',
  'TerminalLocation',
  z
    .object({
      id: z.string(),
      object: z.literal('terminal.location'),
      livemode,
      display_name: z.string().describe('The name the location is shown with.'),
      address: addressSchema.describe('Where the location is; `country` is always set.'),
      metadata,
    })
    .strict(),
  {
    examples: [
      {
        id: 'tml_0193b8f2c1a87d3e9f4a',
        object: 'terminal.location',
        livemode: false,
        display_name: 'Valencia Street shop',
        address: {
          line1: '1272 Valencia Street',
          line2: null,
          city: 'San Francisco',
          state: 'CA',
          postal_code: '94110',
          country: 'US',
        },
        metadata: {},
      },
    ],
  },
);
export type TerminalLocation = Expand<z.output<typeof terminalLocationSchema>>;

declare module '../../common/objects' {
  interface ObjectMap {
    'terminal.location': TerminalLocation;
  }
}

export const deletedTerminalLocationSchema = defineComponent(
  'DeletedTerminalLocation',
  deletedOf('terminal.location'),
);

/** A location's address as a request carries it: `country` is required. */
const locationAddressParams = addressParams.extend({
  country: z.string().regex(/^[A-Z]{2}$/, 'country must be an ISO 3166-1 alpha-2 code'),
});

const displayName = z.string().trim().min(1).max(TERMINAL_LIMITS.displayNameMax);

export const createTerminalLocationParams = z
  .object({
    display_name: displayName,
    address: locationAddressParams.describe(
      'Where the readers are. The provider may require more of the address in some countries.',
    ),
    metadata: metadataCreateParam.optional(),
  })
  .strict();
export type CreateTerminalLocationParams = z.input<typeof createTerminalLocationParams>;

export const updateTerminalLocationParams = z
  .object({
    display_name: displayName.optional(),
    address: locationAddressParams.optional(),
    metadata: metadataUpdateParam.optional(),
  })
  .strict();
export type UpdateTerminalLocationParams = z.input<typeof updateTerminalLocationParams>;

export const listTerminalLocationsQuery = listQuery({});
export type ListTerminalLocationsParams = z.input<typeof listTerminalLocationsQuery>;

const locationId = { id: 'The location (`tml_…`).' };

export const terminalLocationRoutes = [
  defineRoute({
    operationId: 'createTerminalLocation',
    method: 'post',
    path: '/v1/terminal/locations',
    tag: 'Terminal',
    summary: 'Create a location',
    description:
      'Created at the provider first. 503 `terminal_unavailable` when Terminal is not enabled in this mode.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    body: createTerminalLocationParams,
    response: terminalLocationSchema,
    status: 201,
    sdk: 'terminal.locations.create',
  }),
  defineRoute({
    operationId: 'listTerminalLocations',
    method: 'get',
    path: '/v1/terminal/locations',
    tag: 'Terminal',
    summary: 'List locations',
    auth: 'service',
    scope: 'payments:read',
    query: listTerminalLocationsQuery,
    response: listOf(terminalLocationSchema),
    sdk: 'terminal.locations.list',
  }),
  defineRoute({
    operationId: 'retrieveTerminalLocation',
    method: 'get',
    path: '/v1/terminal/locations/{id}',
    tag: 'Terminal',
    summary: 'Retrieve a location',
    auth: 'service',
    scope: 'payments:read',
    params: locationId,
    query: emptyQuery,
    response: terminalLocationSchema,
    sdk: 'terminal.locations.retrieve',
  }),
  defineRoute({
    operationId: 'updateTerminalLocation',
    method: 'post',
    path: '/v1/terminal/locations/{id}',
    tag: 'Terminal',
    summary: 'Update a location',
    description: 'The name and address are sent to the provider; metadata stays in Orbit.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    params: locationId,
    body: updateTerminalLocationParams,
    response: terminalLocationSchema,
    sdk: 'terminal.locations.update',
  }),
  defineRoute({
    operationId: 'deleteTerminalLocation',
    method: 'delete',
    path: '/v1/terminal/locations/{id}',
    tag: 'Terminal',
    summary: 'Delete a location',
    description:
      'Refused with 409 `terminal_location_in_use` while readers are registered to it: delete them first.',
    auth: 'service',
    scope: 'payments:write',
    params: locationId,
    response: deletedTerminalLocationSchema,
    sdk: 'terminal.locations.del',
  }),
] as const;
