# Native FairCoin subscription periods

Peable now executes USD-priced, inclusive monthly subscription invoices through its existing watch-only FairCoin payment intents. Oxy is the financial owner for Oxy One and declared Alia product offers. No automatic debit or wallet signing authority is introduced. Each renewal requires the payer to open a new quoted checkout and authorize a transfer.

The backend boot path accepts `PEABLE_BILLING_COHORT` with `rail: "faircoin"` and the strict `faircoinBillingConfigurationSchema`: explicit owner cohorts, reviewed offers, `priceSource: "faircoin_explorer_indexed_usd"`, `taxQuoteAdapterRef`, and `invoiceSigningKeyId`. FairCoin does not require a Stripe credential. Production requires a mainnet merchant watch-only xpub; nonproduction uses testnet. Configuration never enables a foreign application's merchant.

`PEABLE_BILLING_FISCAL_FILE` selects a reviewed declaration file parsed by `configuredFiscalAuthoritySchema`. `PEABLE_BILLING_INVOICE_PRIVATE_KEY_FILE` selects an operator-owned Ed25519 signing key file, separate from wallet keys. Consumers pin its PUBLIC key for both invoice and tax authority (using the corresponding configured key IDs). No private key belongs in a repository, browser, app or customer request.

Each fiscal declaration must specify its owner, legal seller name, actual assigned tax identifier, registration jurisdiction, exact product price and inclusive treatment, seller/issuer/remitter/service IDs, covered countries and coverage evidence, country rates with evidence and validity dates, and reviewed customer-location evidence references. Inclusive net is rounded half up in minor units. Even a zero rate must be explicitly reviewed and evidenced. Location is never inferred from IP, timezone, language or display currency.

Validate deployment files before boot:

```
DATABASE_URL=<local-test-database> bun packages/backend/scripts/validate-native-billing.ts cohort.json reviewed-fiscal.json
```

This validates shapes and exact price bindings, not legal correctness or network readiness. `configuredFiscalAuthority.test.ts` contains a machine-validated **synthetic** declaration and signature round-trip through the existing verifier. It is not a tax table for production. `config/oxy-fiscal-intent.json` records the user's worldwide commercial intention and proposed legal name; it deliberately is not executable fiscal configuration. Oxy's current repository license leaves incorporation jurisdiction and registration number explicitly unsupplied. A company name does not supply a tax identifier. Worldwide sales remain the objective; only countries with applicable reviewed declarations can produce a payment quote.

The official FairCoin Explorer `/api/price` USD rate must be fresh (at most two minutes old). There is no cached or invented fallback. USD cents convert exactly to FAIR base units with upward rounding. A quote expires after ten minutes or earlier when its fiscal evidence expires. The exact deadline is also persisted on the underlying intent, so direct intent URLs cannot extend it. Display-currency estimates never alter the commercial USD price or authorized FAIR transfer.

A payer-reported txid does not lock a rate. Only the settlement watcher observing the full amount at the reserved address establishes `acceptedAt`. Confirmations can arrive after quote expiry if that trusted observation was timely. A payment first observed late has no paid invoice authority and grants no entitlement; it requires operator reconciliation. A quote's signature is single-use across invoices, enforced by a PostgreSQL unique index. The same checkout/idempotency key replays the same address and invoice.

Renewal is available during the final seven days or after expiry, through `billing.renewSubscription`. Prepaying the next month extends the contiguous paid horizon without moving today's access start into the future. Cancellation forbids subsequent invoices, preserves historical paid periods and honors already issued quotes until their short deadline; it neither initiates nor signs a refund. No paid or refund status is fabricated. Expiry without payment ends access; no grace period is assumed.

Oxy uses its persisted checkout authority and `retrieveCheckoutOperation` to recover a lost response, and reconciles immutable invoice IDs through the SDK. Public hosted checkout receives only the authorized USD/FAIR quote; private seller/customer-location evidence stays server-side. The shared display selector is presentation-only.

Verification includes real PostgreSQL migrations and contention, repeated/lost replies, owner boundaries, single-use tax quotes, actual settlement watcher processing with injected Explorer transaction fixtures, fabricated early txids, delayed confirmations and explicit renewal/cancellation. External chain/provider acceptance has **not** been demonstrated: public Explorer calls returned HTTP 403 in this environment and no funded test wallet or local node is configured. No funds were spent, credentials published, or service deployed.

Individual offers may explicitly use `interval: "year"` with the existing annual USD total. The native subscription freezes cadence; renewal requires another explicit payment for the same cadence. One remains monthly at its central authority. Annual monthly quota windows are owned by Oxy, not Peable or Alia.
