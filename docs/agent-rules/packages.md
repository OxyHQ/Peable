<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Packages

There are **nine**. Four are published to npm (and `cli` will be), so a change
in `contracts`, `shared-types`, `sdk`, `pay` or `cli` is an external API change,
not an internal refactor.

| Path | Name | What it is |
|---|---|---|
| `packages/backend/` | `@peable.to/backend` | Express + Socket.IO gateway API. PostgreSQL-native — see below |
| `packages/frontend/` | `@peable.to/frontend` | Expo / expo-router self-custodial FairCoin wallet, forked from FAIRWallet, with Oxy identity. Also packages as an Electron desktop app |
| `packages/orbit/` | `@peable.to/orbit` | **Orbit by Peable**, the merchant dashboard at orbit.peable.to. Expo + expo-router + Bloom, web first. A SEPARATE app from the wallet: it signs in with Oxy and calls `/v1/dashboard/applications/:id/*` and the contribution routes as the signed-in USER, never with a merchant credential. See `packages/orbit/README.md` |
| `packages/cli/` | **`@peable.to/cli`** | The `peable` command, to be published (`private` until the owner configures its npm trusted publisher) (ESM bin, `dist/bin.js`): `login` (Oxy application credential per profile and mode, 0600 config), `listen` (test-mode events from `GET /v1/events/stream`, signed with a per-session `whsec_` by the SDK's own `signWebhook`, forwarded to localhost), `trigger` (fixtures over the public API and `/v1/test_helpers/*`), `logs tail`, resource commands. Built on `@peable.to/sdk` and `shared-types`; see `packages/cli/README.md` |
| `packages/checkout/` | `@peable.to/checkout` | Vite + React + react-router-dom SPA. The **anonymous** payer-facing hosted checkout at checkout.peable.to. Not Expo, not React Native |
| `packages/sdk/` | **`@peable.to/sdk`** | Published client. Server entry uses `peableForOxyService({ oxy })` for own workloads; external customers use an `ApplicationCredential` or `tokenProvider`, and exposes `paymentIntents` / `paymentLinks` / `checkout.sessions` / `merchants.branding` / `products` / `prices` / `coupons` / `promotionCodes` / `webhookEndpoints` / `events` / `webhooks`; the `@peable.to/sdk/checkout` browser entry is the payer-side core (sessions, `mountCheckout`, `createPeableElements`, `appearance`); `@peable.to/sdk/checkout/ui`'s `PeableSheetCheckout` is THE in-app payment sheet (Bloom, card + always FairCoin, shipping only when the session collects it) every Oxy app pays with — Mention and Mercaria keep no copy |
| `packages/contracts/` | **`@peable.to/contracts`** | THE wire, declared once (ADR 0014 D5): Zod route contracts for every public route, the object registry, the OpenAPI 3.1 generator (`/openapi`) and the zod-free closed value sets (`/vocabulary`); built first |
| `packages/shared-types/` | **`@peable.to/shared-types`** | The zod-free face of the contract for consumers: wire types re-exported from `contracts` as TYPES, the vocabulary re-exported from `contracts/vocabulary`, and the runtime helpers (state machine, webhook signer, report layouts) |
| `packages/pay/` | **`@peable.to/pay`** | Published client for paying FROM an Oxy app. Holds the money code the wallet used to own — HD derivation, the UTXO set, coin selection — so there is exactly one implementation of "how much money is this", not one per app. `sendPayment` / `quotePayment` / `readBalance` (`src/payment.ts`) are the whole surface: seed in, txid out, no key custody |

`packages/pay` is consumed from its BUILD OUTPUT, like `shared-types`: root
`postinstall` builds both, and `ci.yml` / `deploy-frontend.yml` state
`bun run build:pay` rather than relying on that side effect. The frontend
imports `KeyManager`, `UTXOSet` and coin selection from it — those files live
there now, and a copy in the app would be a second answer to the same
question.

**`@peable.to/pay/ui` is a SEPARATE entry and must never be reachable from the
root barrel.** It is `PeablePaySheet` — the Bloom dialog an Oxy app renders to
pay a person — plus the pure modules under it (`src/ui/machine.ts`, `amount.ts`,
`failure.ts`), and it names React, React Native, `@oxy.so/bloom` and
`react-native-qrcode-svg`, all of them OPTIONAL peers. `tsc` resolves a
re-exported specifier whether or not anything calls it, so one line of
`export * from './ui'` turns four optional peers into hard install requirements
for the backend and every server-side consumer of `sendPayment`.
`src/ui/barrelIsolation.test.ts` walks the real module graph and fails if that
line ever appears. The `./ui` subpath has **no CJS build** and no `require`
condition: the CJS pass must use node10 resolution (`@fairco.in/core` is
ESM-only), which cannot see the Bloom subpath exports `./ui` imports.

The sheet takes a `getSeed` CALLBACK, never a seed. The bytes live in one async
function's local and are zeroed in its `finally`; a seed passed as a prop would
sit in the parent's element tree for as long as the sheet is mounted. Its
ABSENCE — not `Platform.OS` — is what selects the "continue on your phone" state
with the `faircoin:` QR, same capability-over-platform rule as the wallet's own
web build.

**`@peable.to/sdk`'s resource methods are GENERATED from the route contracts**
(ADR 0014 D5): `packages/sdk/src/generated/resources.ts` is written by
`bun run generate:sdk-resources` from every `service` contract with an `sdk` path
(payer and user-session routes never become server-SDK methods), and CI's
`check:sdk-resources` fails when the committed file drifts. Never edit it by hand;
change the contract and regenerate. It imports the contracts as TYPES only — the
SDK never constructs a schema at runtime (`ui-isolation.test.ts` walks the
runtime graph), and `__tests__/generated/types.test.ts` proves every generated
signature equals what the contract's `BodyOf` / `QueryOf` / `ResponseOf` derive. There is no
hand-written resource: the only hand-written behaviour is `webhooks` (local
signature verification) and the `files.create` JSON form's widened signature.

`bunfig.toml` sets `linker = "hoisted"`. Expo, Metro and Babel resolve transitive
deps through the standard `node_modules` chain, and the default isolated linker
breaks that plus ECS image resolution. Copy `bunfig.toml` into any Dockerfile
before `bun install`.

The root `overrides` entry `"@peable.to/sdk": "workspace:*"` points
`@oxy.so/services`' exact `@peable.to/sdk` dependency (it imports
`@peable.to/sdk/display` for display prices) at this workspace. Without it bun
nests the published copy under services, with its own older
`@peable.to/contracts`, and the wallet bundles two SDKs.
