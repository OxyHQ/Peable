// Contracts of this group: one module per resource, re-exported here, and
// their routes concatenated into `billingEngineRoutes`.
import { billingPortalRoutes } from './billingPortal';
import { creditNoteRoutes } from './creditNotes';
import { customerBalanceTransactionRoutes } from './customerBalanceTransactions';
import { invoiceItemRoutes } from './invoiceItems';
import { invoiceRoutes } from './invoices';
import { publicBillingRoutes } from './public';
import { quoteRoutes } from './quotes';
import { subscriptionRoutes } from './subscriptions';

export * from './billingPortal';
export * from './creditNotes';
export * from './customerBalanceTransactions';
export * from './invoiceItems';
export * from './invoices';
export * from './public';
export * from './quotes';
export * from './subscriptions';

/** Orbit's native billing engine (ADR 0018): subscriptions, invoices, credit notes, quotes, the balance ledger and the customer portal. */
export const billingEngineRoutes = [
  ...subscriptionRoutes,
  ...invoiceRoutes,
  ...invoiceItemRoutes,
  ...creditNoteRoutes,
  ...quoteRoutes,
  ...customerBalanceTransactionRoutes,
  ...billingPortalRoutes,
  ...publicBillingRoutes,
] as const;
