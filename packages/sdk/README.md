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

The controlled UI also accepts `methodDetails` for a provider handoff or
FairCoin wallet/external-wallet presentation. Available choices come from host
capabilities and the request's allowed method IDs. Wallet availability is an
explicit callback/data capability, never inferred from a signed-in account or
platform. The host supplies quoted amounts, balance and remaining balance;
the UI performs no FX conversion, wallet reads, signing or automatic debits.
A wallet top-up uses the wallet owner's receive details, separately from the
merchant payment destination. Neither flow buys or sells cryptocurrency.
The external QR merely renders the host-provided payload; payment confirmation
and any incoming-funds recognition must remain authoritative host operations.

`checkoutFeedbackSounds` exposes the supplied success/failure AAC assets for
host-controlled playback. Original OGG files are retained byte-for-byte in the
artifact. The host owns terminal-transition deduplication, mute preferences,
playback cancellation and platform audio capabilities; the SDK imports no Expo
audio runtime. `resultIllustration` can carry a host-owned catalogue sticker,
without adding sticker services or account data to the SDK.

The optional installment detail variant displays a host-supplied schedule,
amount due today, full total and fees. It neither calculates a financing quote
nor approves credit. The host restricts this method to eligible requests and
supplies the corresponding review totals; it is not modeled as an automatically
renewing subscription. The generic checkout shell blocks interactive dismissal
while processing, while the host retains ownership of terminal outcomes and
session teardown.

Wallet observations are independent of spending permission. A ready public balance
can be displayed without an authorization callback; loading, unavailable and error
states never manufacture a zero. Retry/connect actions are optional host capabilities,
not a new identity-to-wallet synchronization API.

Installment presentation accepts supplied plan choices, decision states, dated
schedules and optional repayment/APR/terms details. `validInstallmentQuote` checks
structural consistency of integer amounts and dates only; it cannot authenticate a
provider, establish eligibility or approve credit. The host binds selected quotes to
the current order and merchant configuration. Method completion uses the compositor's
forward continuation and explicit payment confirmation rather than charging on selection.

External wallet presentation accepts authoritative observation phases. Waiting displays
a QR/address and progress ring; detection/confirmation are distinct from settlement.
The host owns observation and cancellation. Full addresses remain selectable and the
optional copy callback must resolve successfully before the UI reports a copy. Local
preview simulations and their nonpayable QR values stay in the consuming app.
