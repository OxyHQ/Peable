// A Customer (`cus_…`) — Orbit's own object (ADR 0016). The wire type is the
// contract's (`@peable.to/contracts` `customerSchema`), re-exported here as a
// type so a consumer needs no schema at runtime.
export type {
  CreateCustomerParams,
  Customer,
  DeletedCustomer,
  ListCustomersParams,
  UpdateCustomerParams,
} from '@peable.to/contracts';
