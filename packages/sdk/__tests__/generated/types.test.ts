// The generated signatures are the CONTRACTS' types — proven here at compile
// time. `tsc --noEmit -p packages/sdk` fails if any generated method's
// parameters or result differ from what its route contract alone derives:
// path parameters in path order, then `BodyOf` (a write) / `QueryOf` (a read),
// optional exactly when the input has no required key, then the options the
// route accepts; and `ResponseOf`, read as its kind (list, search, bytes,
// stream). A new route is checked the moment it is generated.

import { expect, test } from 'bun:test';
import type {
  BinaryResponse,
  BodyOf,
  Customer,
  DeletedCustomer,
  ListCustomersParams,
  OperationId,
  PaymentMethod,
  QueryOf,
  ResponseOf,
  RouteContract,
  RouteMap,
  SearchParams,
  StreamResponse,
  UpdateCustomerParams,
} from '@peable.to/contracts';
import type { z } from 'zod';
import type {
  AccountOptions,
  DownloadedBytes,
  IdempotencyOptions,
  RequestOptions,
} from '../../src/core/client';
import type { ApiListPromise, ApiSearchPromise } from '../../src/core/list';
import type { ListPromiseOf, SearchPromiseOf, StreamOptions } from '../../src/core/routeMethods';
import { type GeneratedResources, ROUTE_SPECS } from '../../src/generated/resources';
import { Peable } from '../../src/index';

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(_proof?: T): void {}

// --- What a route's contract alone says its method is. ----------------------

type PathArgs<P extends string> = P extends `${string}{${string}}${infer Rest}`
  ? [string, ...PathArgs<Rest>]
  : [];

type InputOf<R extends RouteContract> = R['body'] extends z.ZodType
  ? R['query'] extends z.ZodType
    ? BodyOf<R> & QueryOf<R>
    : BodyOf<R>
  : R['query'] extends z.ZodType
    ? QueryOf<R>
    : never;

type ParamsArgs<R extends RouteContract> = [InputOf<R>] extends [never]
  ? []
  : // biome-ignore lint/complexity/noBannedTypes: `{}` is exactly "an input with no required key"
    {} extends InputOf<R>
    ? [params?: InputOf<R>]
    : [params: InputOf<R>];

type OptionsOf<R extends RouteContract> = R['response'] extends StreamResponse
  ? R['peableAccount'] extends true
    ? StreamOptions & AccountOptions
    : StreamOptions
  : R['method'] extends 'post'
    ? R['peableAccount'] extends true
      ? RequestOptions & IdempotencyOptions & AccountOptions
      : RequestOptions & IdempotencyOptions
    : R['peableAccount'] extends true
      ? RequestOptions & AccountOptions
      : RequestOptions;

type ResultOf<R extends RouteContract> = R['response'] extends BinaryResponse
  ? Promise<DownloadedBytes>
  : R['response'] extends StreamResponse
    ? AsyncGenerator<ResponseOf<R>>
    : ResponseOf<R> extends { object: 'list' }
      ? ListPromiseOf<R>
      : ResponseOf<R> extends { object: 'search_result' }
        ? SearchPromiseOf<R>
        : Promise<ResponseOf<R>>;

type ArgsOf<R extends RouteContract> = [
  ...PathArgs<R['path']>,
  ...ParamsArgs<R>,
  options?: OptionsOf<R>,
];

// --- The generated method at a route's `sdk` path. --------------------------

type AtPath<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? AtPath<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

type Generated<K extends OperationId> = RouteMap[K]['sdk'] extends string
  ? AtPath<GeneratedResources, RouteMap[K]['sdk']>
  : never;

type MethodFn = (...args: never[]) => unknown;

/** Every generated operation whose parameters or result differ from its contract's. */
type Mismatched = {
  [K in OperationId]: RouteMap[K]['sdk'] extends string
    ? Generated<K> extends MethodFn
      ? Equals<Parameters<Generated<K>>, ArgsOf<RouteMap[K]>> extends true
        ? Equals<ReturnType<Generated<K>>, ResultOf<RouteMap[K]>> extends true
          ? never
          : K
        : K
      : K
    : never;
}[OperationId];

// On a mismatch the error names the operations: "Type 'true' is not assignable
// to type '"searchCustomers"'".
const everyMethodMatchesItsContract: [Mismatched] extends [never] ? true : Mismatched = true;

// --- Spelled out for the two contracted resources. --------------------------

type Op<K extends OperationId> = RouteMap[K];

assertType<
  Equals<
    Parameters<Peable['customers']['create']>,
    [params?: BodyOf<Op<'createCustomer'>>, options?: RequestOptions & IdempotencyOptions]
  >
>();
assertType<
  Equals<ReturnType<Peable['customers']['create']>, Promise<ResponseOf<Op<'createCustomer'>>>>
>();
assertType<Equals<ResponseOf<Op<'createCustomer'>>, Customer>>();
assertType<
  Equals<
    Parameters<Peable['customers']['update']>,
    [id: string, params?: UpdateCustomerParams, options?: RequestOptions & IdempotencyOptions]
  >
>();
assertType<
  Equals<Awaited<ReturnType<Peable['customers']['retrieve']>>, Customer | DeletedCustomer>
>();
assertType<
  Equals<Parameters<Peable['customers']['del']>, [id: string, options?: RequestOptions]>
>();
assertType<
  Equals<
    Parameters<Peable['customers']['list']>,
    [params?: ListCustomersParams, options?: RequestOptions]
  >
>();
assertType<
  Equals<
    ReturnType<Peable['customers']['list']>,
    ApiListPromise<Customer, ResponseOf<Op<'listCustomers'>>>
  >
>();
// A search needs its `query`: `params` is required.
assertType<
  Equals<
    Parameters<Peable['customers']['search']>,
    [params: QueryOf<Op<'searchCustomers'>>, options?: RequestOptions]
  >
>();
assertType<Equals<QueryOf<Op<'searchCustomers'>>, SearchParams>>();
assertType<
  Equals<
    ReturnType<Peable['customers']['search']>,
    ApiSearchPromise<Customer, ResponseOf<Op<'searchCustomers'>>>
  >
>();
// Listing payment methods needs its `customer`: `params` is required.
assertType<
  Equals<
    Parameters<Peable['paymentMethods']['list']>,
    [params: QueryOf<Op<'listPaymentMethods'>>, options?: RequestOptions]
  >
>();
assertType<Equals<Awaited<ReturnType<Peable['paymentMethods']['detach']>>, PaymentMethod>>();

test('the tree has a function at every spec path, and the proofs above compiled', () => {
  expect(everyMethodMatchesItsContract).toBe(true);
  const peable = new Peable({ tokenProvider: { getToken: async () => 't', invalidate() {} } });
  for (const spec of ROUTE_SPECS) {
    let node: unknown = peable;
    for (const segment of spec.sdk.split('.')) node = (node as Record<string, unknown>)[segment];
    expect(typeof node).toBe('function');
  }
  expect(new Set(ROUTE_SPECS.map((spec) => spec.operationId)).size).toBe(ROUTE_SPECS.length);
});

test('no hand-written namespace shadows a generated one', () => {
  const peable = new Peable({ tokenProvider: { getToken: async () => 't', invalidate() {} } });
  const generated = new Set(ROUTE_SPECS.map((spec) => spec.sdk.split('.')[0] as string));
  for (const namespace of generated) {
    // The generated tree is plain objects; a hand-written resource is a class instance.
    expect(Object.getPrototypeOf((peable as unknown as Record<string, unknown>)[namespace])).toBe(
      Object.prototype,
    );
  }
});
