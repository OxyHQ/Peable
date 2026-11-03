import { billingEngineRoutes } from './resources/billingEngine';
import { catalogRoutes } from './resources/catalog';
import { checkoutRoutes } from './resources/checkout';
import { connectRoutes } from './resources/connect';
import { coreRoutes } from './resources/core';
import { eventsRoutes } from './resources/events';
import { paymentsRoutes } from './resources/payments';
import { taxRoutes } from './resources/tax';
import type { RouteContract } from './route';

/**
 * Every public route of the gateway (ADR 0014 D5). The backend's coverage test
 * proves this list and the mounted Express routes are the same set (dashboard
 * routes excepted: they are Orbit's private surface), the OpenAPI document is
 * generated from it, and the SDK's resource methods are generated from it.
 */
export const routes = [
  ...coreRoutes,
  ...paymentsRoutes,
  ...checkoutRoutes,
  ...catalogRoutes,
  ...billingEngineRoutes,
  ...connectRoutes,
  ...taxRoutes,
  ...eventsRoutes,
] as const satisfies readonly RouteContract[];

export type AnyRoute = (typeof routes)[number];

/** Every route by its `operationId`. */
export type RouteMap = { [R in AnyRoute as R['operationId']]: R };

export type OperationId = keyof RouteMap;

/** The route of an operation. */
export function routeOf<K extends OperationId>(operationId: K): RouteMap[K] {
  const route = routes.find((candidate) => candidate.operationId === operationId);
  if (!route) throw new Error(`no route '${operationId}'`);
  return route as RouteMap[K];
}
