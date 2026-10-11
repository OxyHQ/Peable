### Authenticating without a key pair

SDK 0.2.5-oxy-one.0 accepts `tokenProvider: { getToken(), invalidate() }` on
`new Peable(...)` in place of `publicKey` + `secret`, for a workload that already
holds an Oxy identity (workload identity, for instance) and so has no
ApplicationCredential to hand over. The SDK then mints nothing: every Gateway
request carries `getToken()`'s result as the bearer, and a 401 calls
`invalidate()` before the one existing retry. Passing both, or neither, throws at
construction. The credential path is unchanged.


### HTTP deadlines and existing operation keys

SDK0.2.1 accepts `requestTimeoutMs` on `new Peable(...)`. It bounds each token
mint and gateway HTTP attempt, including reading its body. Omitting it preserves
the previous timeout behavior. A consumer replacing a20s HTTP client should
pass `requestTimeoutMs: 20_000`. A401 may still trigger the existing single token
refresh/retry; timeouts and interrupted responses never retry a payment POST.
The remote outcome may be unknown: recover explicitly with the same durable key.

`paymentIntents.reject`, `refunds.create`, and `transfers.create` now accept an
optional second `{ idempotencyKey }` argument, forwarding the existing header.
Refund/transfer `externalRef` remains their durable business identity; the option
neither replaces it nor changes gateway financial semantics.
