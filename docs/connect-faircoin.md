# Connect for FairCoin

Pay a marketplace's **sellers** in FairCoin, straight to their own wallets,
through Peable — like Stripe Connect, without anyone ever holding the coins.

The model, its guarantees and the decisions behind it are in
[ADR 0012](adr/0012-faircoin-connected-accounts.md). This page is how to use it.

> **State:** implemented and tested against a real database (`impl` in the
> [roadmap](PEABLE-ROADMAP.md)). Not yet exercised end to end on testnet by a
> person, not deployed, not live. Mainnet stays behind the roadmap's gates.

## The model in one paragraph

You are the **platform** — a Peable merchant (a card-only one is fine; you need
no `xpub`). Each of your sellers gets a **connected account** (`ca_…`) holding
the seller's OWN watch-only key. You create payments **on behalf of** a seller
(`connectedAccount: 'ca_…'`): the payer's address derives from the seller's
key, so the coins go payer → seller in one transaction. You own the payment
record and receive every webhook for it, each tagged with the seller. Peable
never holds the coins, and neither do you.

```
platform ──create account──▶ Peable          (network + seller's Oxy user id)
platform ──account link────▶ Peable ──url──▶ seller
seller (Oxy session, wallet) ──registers xpub──▶ Peable ──connected_account.updated──▶ platform
platform ──payment intent { connectedAccount }──▶ Peable ──address from SELLER's key──▶ payer
payer ──FAIR──▶ seller's wallet
Peable ──payment_intent.* { account: 'ca_…' }──▶ platform
```

## 1. Open the seller's FairCoin account

```ts
import { Peable } from '@peable.to/sdk';

const peable = new Peable({ publicKey, secret });

const seller = await peable.accounts.create({
  externalRef: store.id,                       // YOUR id for the seller — the idempotency
  faircoin: { network: 'testnet', oxyUserId: store.ownerOxyUserId },
});
// seller.rails       → ['faircoin']
// seller.faircoin    → { network: 'testnet', status: 'pending', oxyUserId, registeredAt: null }
```

- **`oxyUserId` is the seller's identity**, and the only person allowed to
  register the key. You know who owns the store; Peable does not. It cannot
  change later — a store that changes hands gets a new account (new
  `externalRef`).
- **There is no `xpub` parameter, by design.** The key decides who receives the
  money, so it comes only from the seller (step 2). A body carrying one is a 422.
- **A non-production credential can only open `testnet`.** A production one can
  open either, as merchants can.
- **Repeat freely.** Same `externalRef` → the same `ca_…` (200 instead of 201).
  A card seller (`country` + `businessType`) can be given FairCoin later by the
  same call, and a FairCoin seller cards — one seller, one `ca_…`, both rails.
  Asking for a different network or a different Oxy user on an existing
  FairCoin account is a 409.

`peable.accounts` is `peable.connectedAccounts` under its Stripe name:
`accounts.retrieve(id)`, `accounts.list({ limit, starting_after })`,
`accounts.retrieveByRef(externalRef)`.

## 2. Send the seller to register their key

```ts
const link = await peable.accountLinks.create({
  account: seller.id,
  rail: 'faircoin',
  returnUrl: 'https://mercaria.co/sell/payments/done',
  refreshUrl: 'https://mercaria.co/sell/payments/refresh',
});
redirect(link.url);                            // https://peable.to/connect/<token>
```

The seller opens it in the Peable wallet, **signed in with Oxy as `oxyUserId`**,
picks the pocket that will receive your sales, and confirms. The wallet sends
that pocket's watch-only account key; Peable refuses a private key, a key for
the other network, and a key that already receives payments for anyone else.

- **Mint on demand, never store.** A link works once and for an hour. An
  expired or used link sends the seller to your `refreshUrl` — mint a fresh one
  there.
- **The link alone opens nothing.** It needs the seller's Oxy session; a
  forwarded link is useless to anyone else.
- **`returnUrl` proves nothing.** Wait for the event (step 3) or read the
  account.
- **Recommend a dedicated pocket.** Peable derives addresses on the key's
  receive chain from index 0; a pocket the seller also uses for personal
  receipts would share those addresses. The wallet asks the seller to confirm.

## 3. Learn that the seller is ready

```ts
if (event.type === 'connected_account.updated') {
  const seller = event.data.object;            // ConnectedAccount
  // event.account === seller.id
  if (seller.faircoin?.status === 'active') enableFaircoinCheckout(seller.externalRef);
}
```

It is committed in the same transaction as the key, so it is never lost and
never early. `payable` on the same object is about CARD settlements and says
nothing about FairCoin.

You never see the seller's `xpub`: an account key reveals every address of that
pocket, and nothing you do needs it.

## 4. Take a payment on the seller's behalf

```ts
const intent = await peable.paymentIntents.create(
  {
    amount: '250000000',                       // 2.5 FAIR, in m⊜
    rail: 'faircoin',                          // explicit: never a card intent
    network: 'testnet',                        // must be the SELLER's network
    connectedAccount: seller.id,
    metadata: { orderId: order.id },
  },
  { idempotencyKey: `order:${order.id}` },
);
// intent.address            → derived from the SELLER's key
// intent.connectedAccountId → seller.id
// intent.merchantId         → you
```

or a hosted checkout:

```ts
const session = await peable.checkout.sessions.create({
  amount: '250000000',
  rail: 'faircoin',
  network: 'testnet',
  connectedAccount: seller.id,
  successUrl, cancelUrl,
});
redirect(session.url);
```

Refusals you should handle:

| Status | When |
|---|---|
| 409 `code: 'account_not_ready'` | the seller has no FairCoin account or has not registered their key |
| 422 | `rail: 'card'` with `connectedAccount` (on-behalf card charges are not offered), or a network other than the seller's |
| 404 | the `ca_…` is not one of YOUR sellers |
| 409 | an `Idempotency-Key` replayed for a different seller, amount or rail |

`peable.paymentIntents.list({ connected_account: seller.id })` lists one
seller's payments.

## 5. Webhooks

Every event about an on-behalf payment comes to **your** endpoint, with the
seller on the envelope:

```ts
const event = peable.webhooks.constructEvent(rawBody, signature, secret);
if (event.account) {
  // a payment for seller event.account (also event.data.object.connectedAccountId)
}
```

`event.account` is absent on events about your own payments.

### Never cancel a paid order on your own clock

`expiresAt` applies only while the payer has not paid. Once the payer's wallet
reports the broadcast, the intent is `broadcast` → `confirming` → `settled` and
it **never expires**, whatever `expiresAt` says. `intent.canExpire` (and
`canExpire(status)` from the SDK) tells you which:

```ts
import { canExpire } from '@peable.to/sdk';

// Release the seller's stock ONLY on these:
case 'payment_intent.expired':
case 'payment_intent.rejected':
  releaseHold(event.data.object.metadata.orderId);
```

If you want to stop a checkout early, call `paymentIntents.reject(id)`: a 409
means the payer got there first — the order is paid.

One case is outside Peable's sight: a payer who pays the address from an
external wallet WITHOUT the txid being reported. The intent can then expire
with the coins already in the seller's wallet. The money is safe — it is the
seller's — and the order is resolved between you, the seller and the payer.

## Refunds

A FairCoin refund is a payment from the seller's wallet back to the payer.
Peable never held the coins and cannot return them; `refunds.create` refuses
the FairCoin rail. Your platform decides the policy and the seller pays it.

## Platform fees

Not implemented. Because the coins never pass through you, a fee needs a second
movement of money; the options and a recommendation are in ADR 0012 §D12.

## Mercaria checklist

- [ ] On store creation (or when the owner opts in):
      `accounts.create({ externalRef: storeId, faircoin: { network, oxyUserId: ownerOxyUserId } })`.
- [ ] Seller settings → "Get paid in FairCoin" → `accountLinks.create({ account, rail: 'faircoin', … })` → redirect.
- [ ] Webhook: on `connected_account.updated` with `faircoin.status === 'active'`, enable FairCoin at that store's checkout.
- [ ] Checkout: one `paymentIntents.create` / `checkout.sessions.create` per seller group with `connectedAccount`, explicit `rail: 'faircoin'`.
- [ ] Fulfil on `payment_intent.settled`; release stock only on `expired` / `rejected`.
- [ ] Testnet end to end before anything else.
