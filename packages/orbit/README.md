# Orbit by Peable

The merchant dashboard — Oxy's equivalent of the Stripe Dashboard — served at
**orbit.peable.to**. A separate app from the Peable wallet (`packages/frontend`),
which stays a personal app.

Expo + expo-router + Bloom, web first (a desktop-width layout with Bloom's `Rail`,
narrowing to Bloom's floating `TabBar` below 768 px), and still a valid Expo app for
iOS and Android.

## What it does (first version)

| Area | Screen | Gateway routes |
|---|---|---|
| Shell | Oxy sign-in; organization + application picker; **Test / Live** toggle (`environment=development` / `production`) | Oxy `accounts.list`, `apps.list` |
| Home | Counts and gross volume **computed in the browser from the first page (100) of payments**, labelled as such; five most recent payments | `GET …/payment_intents` |
| Payments | List with a status filter and `starting_after` / `has_more` paging; detail with amount by currency decimals, a timeline built only from the intent's own fields, and metadata | `GET …/payment_intents`, `GET …/payment_intents/:id` |
| Developers | Webhook **endpoints** (add with URL + events, enable/disable, **Roll secret** with a 24 h overlap, **Send test event**, delete; the `whsec_…` is shown once, on add and roll), the **events** of the last 30 days, and the delivery log — status, attempts, last error, next attempt, event and endpoint — with **Redeliver** | `GET/POST …/webhook_endpoints`, `POST/DELETE …/webhook_endpoints/:id`, `POST …/webhook_endpoints/:id/roll_secret`, `POST …/webhook_endpoints/:id/test`, `GET …/events`, `GET …/webhook_deliveries`, `POST …/webhook_deliveries/:id/redeliver` |
| Tax | Peable Tax, ported from the wallet's `app/tax.tsx` | `…/tax/*` |
| Contributions | Contribution links, ported from the wallet's `app/contributions.tsx` (same `@peable.to/sdk/contributions` resource) | `/v1/organizations/:org/applications/:app/contributions*` |
| Settings | Register or update the merchant for the selected application and mode: branding (display name, description), required confirmations, and — at registration — the optional FairCoin network + **watch-only** xpub | `GET/POST/PATCH …/merchant` |

`…` is `/v1/dashboard/applications/:applicationId`, always with `?environment=`.
Every call is made as the signed-in **Oxy user**; the gateway asks oxy-api for the
caller's membership of the application on each request. There is no merchant
credential in Orbit, and none may be added: a browser is not a place to keep one.

The wallet's Tax and Contributions screens are still in the wallet; removing them is
a separate change.

## How it talks to the gateway

`src/api/transport.ts` is the one transport. It rides the Oxy linked client's raw
authenticated response (the linked client owns the bearer and its refresh), because
the client's `get`/`post` helpers unwrap any `{data}` body and would drop a list's
`has_more` and `url`, and because reading the error body ourselves keeps the gateway's
ADR 0014 error — `type`, `code`, `param`, `message`, `request_id` — which every screen
shows with its request id. Query strings use the SDK's `encodeQuery`.

`src/api/dashboard.ts` maps the dashboard routes; `src/api/contributions.ts` puts the
SDK's `ContributionsResource` on the same transport. A 404 from a merchant-scoped route
means "no merchant in this mode", and the screens offer Settings for it.

Values from `@peable.to/shared-types` that a browser needs at runtime (currency
decimals, the status list) are restated in `src/format/money.ts` and
`src/payments/status.ts` and **pinned by tests** to the shared-types originals: the
shared-types root barrel also exports the `node:crypto` webhook signer, which a web or
native bundle cannot load.

## Commands

```bash
bun run dev:orbit                                  # expo start --web on :8082
bun run build:orbit                                # expo export --platform web → dist/
bun run --filter @peable.to/orbit typecheck
bun run --filter @peable.to/orbit test             # bun test src
bun run --filter @peable.to/orbit lint             # expo lint . (EXPO_PUBLIC_* rules only)
```

Configuration (`src/config.ts`), each with a production default:
`EXPO_PUBLIC_OXY_BASE_URL`, `EXPO_PUBLIC_OXY_CLIENT_ID`,
`EXPO_PUBLIC_OXY_AUTH_REDIRECT_URI` (must equal a redirect registered on the Oxy
client), `EXPO_PUBLIC_GATEWAY_API_URL`.

For local development against a local gateway, `http://localhost:8082` must be in the
backend's `PEABLE_ALLOWED_ORIGINS` (it is in `packages/backend/.env.example`);
`https://orbit.peable.to` is built into `config.ts`.

## Deploy

`.github/workflows/deploy-orbit.yml`: after CI succeeds on main, `deploy-scope.sh`
decides whether anything Orbit builds from changed, then the web export is uploaded with
`wrangler pages deploy` to the Cloudflare Pages project **`peable-orbit`**. The export is
a single-page app with no `404.html`, so Pages serves `index.html` for deep links;
`public/_headers` forbids framing and sniffing.

External setup it needs: the `peable-orbit` Pages project, the `orbit.peable.to` custom
domain on it, `https://orbit.peable.to` registered as a redirect URI on Peable's Oxy
client, and the repository's existing `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
secrets (shared with the other Pages deploys).
