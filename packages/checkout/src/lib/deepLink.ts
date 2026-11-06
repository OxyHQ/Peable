// The `peable://pay?...` deep link the Peable wallet's `parsePaymentRequest`
// parses (packages/frontend/src/pay/payment-request.ts) is the SDK's
// (`@peable.to/sdk/checkout`): ONE definition of the request, a single address
// or every output of a multi-seller payment (ADR 0021 D6). Re-exported so this
// app's round-trip test (`deepLink.test.ts`) keeps proving it against the
// wallet's REAL parser.
export { buildPayDeepLink, payDeepLinkFor, type PayDeepLinkParams } from '@peable.to/sdk/checkout';
