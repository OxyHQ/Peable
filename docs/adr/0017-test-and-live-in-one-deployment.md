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
   unavailable rail). The legacy `STRIPE_SECRET_KEY` is read as whichever mode its
   prefix declares, so an existing deployment keeps working unchanged.
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
