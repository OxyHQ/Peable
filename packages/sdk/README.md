### Own Oxy applications: shared workload transport

```ts
import { peableForOxyService } from '@peable.to/sdk';
const peable = peableForOxyService({ oxy: mySharedOxyServer });
```

The factory uses `OxyServer.createServiceClient` with Peable's registered
audience `oxy-service:6a2f851751b784a86fd0e958`. Own workloads have no payment
scopes or application consent. The gateway still resolves the merchant from
the verified application and environment and enforces all account, rail,
settlement, idempotency and business rules. The hosted payer checkout stays
anonymous.

An optional `requester: {accountId, token | taskId | requesterContext}` carries
verified account context for a person-bound call. Do not supply a user header,
persist a session bearer, or share a requester-bound client between accounts.
Call `peable.dispose()` when finished with the client.

External customer integrations retain `publicKey` + `secret` or an explicit
`tokenProvider: {getToken(), invalidate()}`. Their existing `oxy-api` audience
remains accepted with live credential/application scope checks. Own traffic
requires the exact registered audience. An external key on an official app
remains external and cannot gain own authority from branding. Only the own
factory bypasses app permission configuration, never merchant/resource rules.


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

### Connect for FairCoin (0.4.0)

Pay a marketplace's sellers in FairCoin straight to their own wallets
(ADR 0012, guide in `docs/connect-faircoin.md`):

```ts
const seller = await peable.accounts.create({
  externalRef: store.id,
  faircoin: { network: 'testnet', oxyUserId: store.ownerOxyUserId },
});
const link = await peable.accountLinks.create({
  account: seller.id, rail: 'faircoin', returnUrl, refreshUrl,
});
// the seller registers their key at link.url, signed in with Oxy;
// you receive connected_account.updated with faircoin.status === 'active'
const intent = await peable.paymentIntents.create(
  { amount: '250000000', rail: 'faircoin', network: 'testnet', connectedAccount: seller.id },
  { idempotencyKey: `order:${order.id}` },
);
```

`peable.accounts` is `peable.connectedAccounts` under its Stripe name. Events for
an on-behalf payment carry `event.account`; `intent.canExpire` is `false` once a
payer has broadcast, so never cancel an order on `expiresAt` alone. A seller
without a registered key is a 409 with `error.code === 'account_not_ready'`.

### Optional checkout presentation (local development)

`@peable.to/sdk/checkout/ui` exposes the controlled `PeableCheckoutSheet` and
checkout view-model types. It composes Bloom's `CheckoutSheet` with Peable's
provided brand asset, localized copy and minor-unit currency formatting. The
host supplies quoted items, requirements, draft state, navigation and the
`onAuthorize` callback. Card collection is a provider-owned `cardEntry` slot;
the component never collects or stores card numbers, calls payment APIs, or
grants access. Shipping is conditional on the request. Optional `brandState`
controls presentation only; a host may restore the logo after confirmed
success before closing. Completion timers and authoritative outcomes belong
to the host.

This entry is ESM/React Native only, with optional React, React Native and Bloom
peers. Neither the server root nor the anonymous `/checkout` core imports it;
the module-graph isolation test enforces that boundary. The Peable logo is
copied into the ESM build and included in the package artifact.

This UI currently requires the coordinated **local** Bloom checkout/status-ring
build and local SDK build. Registry version 0.5.0 does not acquire these APIs
until a separately authorized package release. Local Mention development uses
an explicit source resolver/artifact override; no publication is implied.
