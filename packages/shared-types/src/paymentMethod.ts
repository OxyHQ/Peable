// A PaymentMethod (`pm_…`) — Peable's wrapper over a provider payment method
// (ADR 0016). The wire type is the contract's (`@peable.to/contracts`
// `paymentMethodSchema`), re-exported here as a type.
export type {
  BillingDetails,
  CardDetails,
  DetachPaymentMethodParams,
  ListPaymentMethodsParams,
  PaymentMethod,
  UpdatePaymentMethodParams,
} from '@peable.to/contracts';
