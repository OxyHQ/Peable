# ADR 0017 — Test and live in one deployment, selected by the credential

**Status:** accepted; implementation replaces the single-key model of ADR 0009 §1.
**Amends:** ADR 0009 consequence 1 ("one deployment serves ONE mode").
**Date:** 2026-11-03.

## Context

ADR 0009 records that the gateway holds one process-wide provider key, so a
deployment serves one mode, and `services/providers/environmentGuard.ts` refuses
a credential from the other environment. That is correct for the model it
describes, and its own comment names the alternative: "two clients keyed by
environment … a bigger change than it looks: the webhook endpoints, their
secrets, the stored `provider_events` and every connected account would each need
a mode beside them".

Orbit needs the alternative. On Stripe one API host serves both modes and the key
decides; a merchant flips a dashboard toggle to see test data. On Peable today a
merchant's test integration needs a second deployment that is not documented and
not run.

## Decision

1. **The provider registry is keyed by `(provider, mode)`**, built from
   `STRIPE_SECRET_KEY_TEST` and `STRIPE_SECRET_KEY_LIVE` (each optional; a
   missing key makes that mode's card rail unavailable, answered as 503 like any
   unavailable rail). `STRIPE_SECRET_KEY` is removed in the same change; the
   deploy secrets and SSM parameters are renamed with it, and the gateway refuses
   to boot if a key's prefix disagrees with the mode it was configured for.
2. **The mode comes from the credential**: `production` ⟺ live, every other Oxy
   environment ⟺ test — exactly `environmentMatchesMode`. The guard stops refusing
   and starts selecting; it still runs before the first provider call of every
   money operation, so a test credential can never reach the live client.
3. **Every provider-bound row stores its mode** (`livemode`), and every lookup of a
   provider object resolves the client by the row's mode, never by the caller's —
   an operation on a stored object uses the key that created it.
4. **Inbound provider webhooks are per mode**: separate endpoint secrets, and
   `provider_events` already records `livemode`; the processor routes by it and
   refuses an event whose mode has no configured key.
5. **`livemode` appears on every Orbit object** (ADR 0014 D1), so a merchant and
   Orbit's test/live toggle can always tell which world an object belongs to.

## Consequences

- One deployment, one database, both modes; merchant rows were already separate
  per environment, so no data is shared across modes.
- The FairCoin rail is unaffected: its mode is the network (`mainnet`/`testnet`),
  and a non-production merchant already cannot register a mainnet key.
- Secrets sync (`deploy-aws.yml` → SSM) gains the two keys and their webhook
  secrets; the skip-empty rule keeps a half-configured deployment serving the mode
  it has.

## Implementation (2026-11-03)

- **Configuration.** Per mode, each optional: `STRIPE_SECRET_KEY_{TEST,LIVE}`,
  `STRIPE_PUBLISHABLE_KEY_{TEST,LIVE}`, `STRIPE_WEBHOOK_SECRET_{TEST,LIVE}`,
  `STRIPE_CONNECT_WEBHOOK_SECRET_{TEST,LIVE}` and the rotation pair
  `STRIPE_WEBHOOK_SECRET_PREVIOUS_{TEST,LIVE}` /
  `STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS_{TEST,LIVE}`. `STRIPE_ENABLED` stays the
  operator's switch for the card rail. The single-mode names are gone with no
  fallback. Boot fails when a secret key is not `sk_<mode>_`/`rk_<mode>_` or a
  publishable key is not `pk_<mode>_` for the variable's mode.
- **Selection.** `registry.ts` is keyed by `(provider, mode)`;
  `environmentGuard.ts` exports `selectCardProvider(environment)` for new
  operations and `selectStoredProvider(provider, livemode)` for operations on a
  stored object. The old mismatch refusal (`EnvironmentModeMismatchError`, 403)
  is removed; a mode without a key answers 503 like any unavailable rail.
- **Where a row's mode is stored.** In ONE place: `merchants.livemode`, which the
  single writer derives from `environment` and `merchants_livemode_agrees_check`
  pins. Every provider-bound row references its merchant, and each repository
  reads the mode in the row's own statement (`db/merchants/merchantLivemode.ts`),
  so no migration was needed and no copy can disagree with its source. A
  per-table `livemode` column would only be needed if a row could ever belong to
  a mode other than its merchant's.
- **Inbound webhooks.** Per-mode secret verification on the existing two paths,
  not new paths: the mode whose endpoint secrets verify a delivery is its mode;
  an event whose `livemode` disagrees with that secret, or of a mode with no key,
  is refused with 400 and nothing is stored. The drain refuses (and leaves
  visible) an event of a key-less mode and one naming an object of the other
  mode.
- **Tax and billing.** One Stripe Tax provider per configured mode, chosen by the
  merchant's environment; a billing cohort uses the key of the mode its
  `deployment.livemode` names.
