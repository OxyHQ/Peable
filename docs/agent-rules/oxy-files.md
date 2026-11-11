<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Oxy Files (ADR 0043 of the oxy repo)

Peable uses Oxy files two ways, each an `OXY_FILE_ENTITY_TYPES` member:
`merchant_avatar` (the merchant's square identity image, an Oxy file THEY own,
`merchants.avatar_file_id`) and `file` (an Orbit File, `file_…`, `files` — bytes
Peable stored for a merchant, or a merchant-owned Oxy logo imported as one).
Every live `files` row holds its own reference; whatever USES a File (dispute
evidence, the merchant's `business_logo`) uses the row, never the Oxy file. Rules:

- **Ownership is checked at ONE place**, `services/oxyFiles/fileOwnership.ts`
  (`acceptOxyFile`), reached from `registerMerchant` / `applyMerchantPatch`
  (avatar) and `POST /v1/files` with `oxy_file` (an imported logo) — service AND
  dashboard routes. The file must be active and owned by the merchant's
  application, its owner account, the dashboard user or the user a delegated
  token acts as, and Oxy must accept Peable's reference. It FAILS CLOSED (503)
  when Oxy cannot be asked or hides the owner — Oxy reveals owners to verified
  first-party workload authority. Application branding or tier is
  insufficient. An UPLOAD needs no check: Peable stores the bytes as its own
  application file (`storeAppFile`, the reference registered in the same Oxy
  call), private — or public for a `business_logo`.
- **Every use writes its reference sync in the same transaction**
  (`enqueueReferenceSync`, called only from `db/merchants/merchantRepository.ts`
  and `db/files/fileRepository.ts`); `services/oxyFiles/referenceSync.ts` makes
  Oxy agree, and the daily reconciliation (`OXY_FILE_RECONCILIATION_MODE`, `bun
  run oxy-files:reconcile`) repairs the rest, one run per entity type. A new
  kind of file use is a new `OXY_FILE_ENTITY_TYPES` member, and the exhaustive
  switches (`isReferenceWanted`, `inventoryFor`, `fileEvents.ts`) will not
  compile without its rules.
- **`/v1/webhooks/oxy/files` is mounted before `express.json()` and the rate
  limiter**, like the Stripe webhooks: the signature covers the raw bytes.
  Deleted/blocked/lost clears the avatar (audited in `merchant_avatar_audit`)
  and REMOVES every File over the Oxy file (`files.removed_at`/`removed_by` —
  the row stays, so evidence and the logo can say why they stopped working);
  trashed/private withholds both until the owner brings them back.

**Files (`POST /v1/files`, `GET /v1/files[/:id]`).** `routes/files.ts` reads the
`multipart/form-data` body itself, bounded by the largest purpose, recognises
the TYPE from the bytes (never the client's `Content-Type`) and checks it
against `FILE_PURPOSE_POLICIES` (shared-types). It sets `req.body` to the
request's identity — purpose, name, size, sha256 — so the generic idempotency
layer hashes the file without the bytes ever entering a stored hash, a log or
an error. Never log or echo file bytes. Only a `business_logo` has a `url`;
evidence and identity documents leave Peable only to the provider they are
submitted to (`readFileBytes` → `linkedDownloadUrls`).

**The logo sits BESIDE the avatar, and they are not the same thing.** The
avatar is the square identity image (Stripe's branding `icon`), an Oxy file the
merchant owns and the one the Oxy ecosystem renders; `business_logo` is the
wide wordmark payer surfaces put in their header (Stripe's branding `logo`), a
File of purpose `business_logo`, set with `POST /v1/merchants/me` (a File needs a
merchant, so never at registration) and served as `MerchantDisplay.logo_url`
only while the File is `available`.

Peable's own Files calls use its live workload binding through the shared
`OxyServer`; no application scopes or client key pair configure that authority.
Merchant/file ownership and reference visibility checks still apply. See
[`docs/first-party-authority.md`](../../docs/first-party-authority.md).

Repositories (`src/db/`), the only thing that reaches Postgres — there is no
`src/models/`: `merchants/` (`merchantRepository`),
`payments/` (`paymentIntentRepository`, `chargeRepository`,
`paymentLinkRepository`, `checkoutSessionRepository`), `customers/`
(`customerRepository`, `paymentMethodRepository`, `setupIntentRepository`),
`catalog/` (`productRepository`, `priceRepository`, `couponRepository`,
`promotionCodeRepository`), `social/` (`receiveCursor`, `sendAttribution`),
`events/` (`eventRepository`), `webhooks/` (`webhookEndpointRepository`,
`webhookDeliveryRepository`, `webhookOutboxRepository`),
`providers/` (`providerEventRepository`), `accounts/`
(`connectedAccountRepository`,
`accountLinkRepository`), `transfers/` (`transferRepository`,
`transferReversalRepository`), `refunds/` (`refundRepository`), `disputes/`
(`disputeRepository`), `files/` (`fileRepository`), `paymentMethods/`
(`paymentMethodConfigurationRepository`: configurations, their provider
bindings, wallet domains), `money/` (`ledgerRepository`, `payoutRepository`,
`applicationFeeRepository`, `feeScheduleRepository`, `reconciliationRepository`),
`reporting/` (`reportRunRepository`, `reportScheduleRepository`, `reportData`), `search/` (`searchFields`),
`identity/` (`verificationRepository`), `terminal/` (`terminalRepository`).

**Payment method breadth is a card-rail intersection, decided once per
payment.** `services/paymentMethods/configuration.ts`: a merchant's
configurations (`pmc_…`, one default created on first need) hold only their
explicit choices; a method is offered when it is on (or Orbit's default is),
the provider processes it at all (`PROVIDER_PAYMENT_METHODS`), a wallet's card
is on, and the payment's currency is one it takes (`PAYMENT_METHOD_CURRENCIES`).
What cannot be offered says why (`unavailable_reason`) and a toggle that could
never take effect is refused — never a silent no-op. A PaymentIntent stores
the types it offers at creation (`payment_intents.payment_method_types`) and,
unless the merchant named types, its configuration, whose provider binding is
pushed again before use whenever the row's `version` moved — the provider never
offers a method the merchant turned off. Every method Orbit does not model
(the provider's own consumer wallet, BNPL, …) is switched OFF explicitly on
every push. Wallet domains (`pmd_…`) are registered at the provider first and
the row records its answer; Peable's, Oxy's and Kaana's own hosts are refused.
**FairCoin is a LOCKED entry of every configuration (ADR 0021 D2)**: always
`on`, `locked: true`, `available` only once the merchant has a FairCoin key
(`faircoin_account_missing` before); `off` is a 400 `payment_method_locked` and
nothing is ever stored for it. It is the chain rail, so it is never pushed to
the provider and never one of a card PaymentIntent's `payment_method_types`.

**A refund and a dispute run in OPPOSITE directions, and the difference is the
whole handler.** A refund is merchant-initiated: Peable writes the row, then
calls the provider, so an event naming a refund row we do not have is
`unmatched` and retried. A dispute is network-initiated: the first thing that
exists is the event, so "no row" is the NORMAL first state and
`handleDisputeEvent` CREATES one. Its idempotency is therefore not a merchant
`external_ref` but `unique(provider, provider_object_id)` — the only identity a
redelivered creation carries. Its two events carry a **`Dispute`** under
`data.object`, not the intent: `WebhookEventPayload` in `shared-types/event.ts`
is the total map of event type to resource, and `recordEvent` is generic over it,
so a new event type cannot ship the wrong payload.
