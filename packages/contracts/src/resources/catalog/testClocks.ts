import { z } from 'zod';
import { deletedOf, listOf } from '../../common/envelopes';
import { defineComponent, defineObject, type Expand } from '../../common/objects';
import { expandOnlyQuery, listQuery, unixSecondsParam } from '../../common/params';
import { unixSeconds } from '../../common/primitives';
import { defineRoute } from '../../route';
import { TEST_CLOCK_STATUSES } from '../../vocabulary/catalog';

/**
 * Test clocks (`clock_…`, ADR 0018 §3, test mode only). Customers attached to
 * a clock — and every subscription and invoice of theirs — live at
 * `frozen_time` instead of the wall clock, so a trial, a renewal or a dunning
 * schedule runs in seconds. Advancing it runs the engine for everything on the
 * clock up to the new time.
 */
export const testClockSchema = defineObject(
  'test_helpers.test_clock',
  'TestClock',
  z
    .object({
      id: z.string(),
      object: z.literal('test_helpers.test_clock'),
      livemode: z.literal(false).describe('Always `false`: test clocks exist in test mode only.'),
      name: z.string().nullable(),
      frozen_time: unixSeconds.describe('The instant everything on the clock lives at.'),
      status: z.enum(TEST_CLOCK_STATUSES),
      deletes_after: unixSeconds.describe('Deleted, with everything on it, after this instant.'),
      created: unixSeconds,
    })
    .strict(),
  {
    examples: [
      {
        id: 'clock_0193b8f2c1a87d3e9f4d',
        object: 'test_helpers.test_clock',
        livemode: false,
        name: 'Annual renewal',
        frozen_time: 1793750400,
        status: 'ready',
        deletes_after: 1796342400,
        created: 1793750400,
      },
    ],
  },
);
export type TestClock = Expand<z.output<typeof testClockSchema>>;

export const deletedTestClockSchema = defineComponent(
  'DeletedTestClock',
  deletedOf('test_helpers.test_clock'),
);
export type DeletedTestClock = z.output<typeof deletedTestClockSchema>;

declare module '../../common/objects' {
  interface ObjectMap {
    'test_helpers.test_clock': TestClock;
  }
}

export const createTestClockParams = z
  .object({ frozen_time: unixSecondsParam, name: z.string().min(1).max(300).optional() })
  .strict();
export type CreateTestClockParams = z.input<typeof createTestClockParams>;

export const advanceTestClockParams = z
  .object({
    frozen_time: unixSecondsParam.describe(
      "Later than the clock's current `frozen_time`, and at most two years after it.",
    ),
  })
  .strict();
export type AdvanceTestClockParams = z.input<typeof advanceTestClockParams>;

export const listTestClocksQuery = listQuery({});
export type TestClockListParams = z.input<typeof listTestClocksQuery>;

const id = { id: 'The test clock (`clock_…`).' };

export const testClockRoutes = [
  defineRoute({
    operationId: 'createTestClock',
    method: 'post',
    path: '/v1/test_helpers/test_clocks',
    tag: 'Test clocks',
    summary: 'Create a test clock',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    testModeOnly: true,
    body: createTestClockParams,
    response: testClockSchema,
    sdk: 'testHelpers.testClocks.create',
  }),
  defineRoute({
    operationId: 'listTestClocks',
    method: 'get',
    path: '/v1/test_helpers/test_clocks',
    tag: 'Test clocks',
    summary: 'List test clocks',
    auth: 'service',
    scope: 'payments:read',
    testModeOnly: true,
    query: listTestClocksQuery,
    response: listOf(testClockSchema),
    sdk: 'testHelpers.testClocks.list',
    expandable: 'test_helpers.test_clock',
  }),
  defineRoute({
    operationId: 'retrieveTestClock',
    method: 'get',
    path: '/v1/test_helpers/test_clocks/{id}',
    tag: 'Test clocks',
    summary: 'Retrieve a test clock',
    auth: 'service',
    scope: 'payments:read',
    testModeOnly: true,
    params: id,
    query: expandOnlyQuery,
    response: testClockSchema,
    sdk: 'testHelpers.testClocks.retrieve',
  }),
  defineRoute({
    operationId: 'advanceTestClock',
    method: 'post',
    path: '/v1/test_helpers/test_clocks/{id}/advance',
    tag: 'Test clocks',
    summary: 'Advance a test clock',
    description:
      'Moves `frozen_time` forward and runs the billing engine for everything on the clock up to it: trials end, subscriptions renew, invoices finalize and dunning retries.',
    auth: 'service',
    scope: 'payments:write',
    idempotent: true,
    testModeOnly: true,
    params: id,
    body: advanceTestClockParams,
    response: testClockSchema,
    sdk: 'testHelpers.testClocks.advance',
  }),
  defineRoute({
    operationId: 'deleteTestClock',
    method: 'delete',
    path: '/v1/test_helpers/test_clocks/{id}',
    tag: 'Test clocks',
    summary: 'Delete a test clock',
    description:
      'Every live subscription on the clock is cancelled at its frozen time; the clock stays readable to the objects that name it.',
    auth: 'service',
    scope: 'payments:write',
    testModeOnly: true,
    params: id,
    response: deletedTestClockSchema,
    sdk: 'testHelpers.testClocks.del',
  }),
] as const;
