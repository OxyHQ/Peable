import { customerRoutes } from './customers';
import { paymentMethodRoutes } from './paymentMethods';

export * from './customers';
export * from './paymentMethods';

/** Customers and their saved payment methods. */
export const coreRoutes = [...customerRoutes, ...paymentMethodRoutes] as const;
