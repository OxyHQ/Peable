// The customer portal (ADR 0018 §9) — the closed value sets its schemas are
// built from. Zod-free: `@peable.to/shared-types` re-exports them at runtime.

/** What a portal customer may edit about themselves. */
export const PORTAL_CUSTOMER_UPDATES = ['email', 'name', 'address', 'phone'] as const;
export type PortalCustomerUpdate = (typeof PORTAL_CUSTOMER_UPDATES)[number];

/** When a cancellation from the portal takes effect. */
export const PORTAL_CANCEL_MODES = ['at_period_end', 'immediately'] as const;
export type PortalCancelMode = (typeof PORTAL_CANCEL_MODES)[number];

/** How a cancellation from the portal prorates. */
export const PORTAL_CANCEL_PRORATION_BEHAVIORS = ['create_prorations', 'none'] as const;
export type PortalCancelProrationBehavior = (typeof PORTAL_CANCEL_PRORATION_BEHAVIORS)[number];

/** What a plan change from the portal may change. */
export const PORTAL_SUBSCRIPTION_UPDATES = ['price', 'quantity'] as const;
export type PortalSubscriptionUpdate = (typeof PORTAL_SUBSCRIPTION_UPDATES)[number];

/** What finishing a payment method update from the portal answered. */
export const PORTAL_PAYMENT_METHOD_UPDATE_STATUSES = ['succeeded', 'pending'] as const;
export type PortalPaymentMethodUpdateStatus =
  (typeof PORTAL_PAYMENT_METHOD_UPDATE_STATUSES)[number];
