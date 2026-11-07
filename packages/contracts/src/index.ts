// @peable.to/contracts — the Peable wire, declared once (ADR 0014 D5).
//
// Every public route's request and response schema is a Zod schema here. The
// backend validates with these exact objects, the OpenAPI document
// (`@peable.to/contracts/openapi`) is generated from them, `@peable.to/shared-types`
// re-exports their inferred types, and `@peable.to/sdk`'s resource methods are
// generated from the route list.
//
// Importing this root constructs every schema. A bundle that only needs the
// closed value sets imports `@peable.to/contracts/vocabulary`.

export * from './common/address';
export * from './common/envelopes';
export * from './common/objects';
export * from './common/params';
export * from './common/primitives';
export * from './route';
export * from './routes';
export * from './vocabulary';
export * from './resources/core';
export * from './resources/payments';
export * from './resources/checkout';
export * from './resources/catalog';
export * from './resources/billingEngine';
export * from './resources/connect';
export * from './resources/tax';
export * from './resources/identity';
export * from './resources/events';
