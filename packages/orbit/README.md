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
| Payments | List with a status filter and `starting_after` / `has_more` paging; detail with amount by currency decimals, a timeline built only from the intent's own fields, metadata, and its **events** each linked to the request log of the API call that caused it | `GET …/payment_intents`, `GET …/payment_intents/:id`, `GET …/events?payment_intent=` |
| Products | The catalog (ADR 0018): products with an Active / Archived filter and `starting_after` paging; create a product with an optional first price (`default_price_data`); detail to rename, describe, set unit label and statement descriptor, archive / unarchive, delete (refused by the gateway while it has prices); its prices with Active / Default badges — add a price (currency, amount in whole units converted exactly to base units, one-time or every N days/weeks/months/years, tax behavior), archive / unarchive, make default | `GET/POST …/products`, `GET/POST/DELETE …/products/:id`, `GET/POST …/prices`, `POST …/prices/:id` |
| Disputes | List with status, reason, amount by currency decimals and the respond-by deadline (past due flagged); detail with the dispute's facts and the evidence form — 17 text fields and 9 file fields (uploaded as `dispute_evidence` files), **Save draft** (`submit: false`), **Submit response** once behind a one-shot confirmation, **Accept dispute** (close, lost) behind its own; read-only once submitted, closed, under review or past due. Evidence lives only in the detail's query cache | `GET …/disputes`, `GET/POST …/disputes/:id`, `POST …/disputes/:id/close`, `POST …/files` |
| Balances | Available / pending per currency and FairCoin **received in your wallet** (informational, never payable), the balance transactions (type filter, `starting_after` paging; a missing fee or net reads "Not reported", never 0), and unresolved **reconciliation mismatches** as a warning. A merchant with no fiat account (404 `account_missing`) is told so and sent to Account — never shown zeros | `GET …/balance`, `GET …/balance_transactions`, `GET …/reconciliation_mismatches` |
| Payouts | List (status filter, paging) and detail with the **payout reconciliation** report (summary + its balance transactions); **Pay out** on a manual schedule (the instruction and its `Idempotency-Key` are kept per scope until the gateway answers, so a lost response is retried, never repeated); cancel a pending payout; the payout schedule and a form to change it | `GET/POST …/payouts`, `GET …/payouts/:id`, `POST …/payouts/:id/cancel`, `GET …/reports/payout_reconciliation`, `POST …/account` |
| Account | The merchant's own provider account: payments / payouts enabled, capabilities, requirements in words (past due, due now, due later, being verified, why restricted), business profile and statement descriptors; **Start / resume onboarding** mints a hosted link back to `/account` and opens it; with no account, a country + business type form opens one | `GET/POST …/account`, `POST …/account_links` |
| Customers | The native billing engine's customers (ADR 0018): list with an exact-email search and paging; detail with billing currency, **balance** (negative is credit), test clock, **active entitlements**, subscriptions, invoices and balance transactions | `GET …/customers`, `GET …/customers/:id`, `GET …/customers/:id/balance_transactions`, `GET …/entitlements/active_entitlements` |
| Subscriptions | List with a status filter (default hides canceled) and paging; detail with items and prices, current period, trial, collection, latest invoice (expanded), and the actions the status allows — cancel at period end / keep, pause / resume collection (`keep_as_draft`), cancel now (unused time credited), resume a `paused` one | `GET …/subscriptions`, `GET/POST/DELETE …/subscriptions/:id`, `POST …/subscriptions/:id/resume` |
| Invoices | List with a status filter and paging; detail with lines (prorations marked), subtotal, discount, tax (or "calculated at finalization"), total, balance applied, amounts due/paid/remaining, status timeline, the last finalization error, and finalize / email / void / mark uncollectible plus the hosted page and PDF (public token URLs) | `GET …/invoices`, `GET …/invoices/:id`, `POST …/invoices/:id/{finalize,send,void,mark_uncollectible}` |
| Billing | Billing settings — invoice prefix, default days until due, the dunning retry schedule, final subscription and invoice actions, customer emails — and entitlement **features** (create, archive); each product's page attaches and detaches the features it grants | `GET/POST …/billing_settings`, `GET/POST …/entitlements/features`, `POST …/entitlements/features/:id`, `GET/POST …/products/:id/features`, `DELETE …/products/:id/features/:feature` |
| Connect | A marketplace's **sellers** (never the merchant's own account): list with readiness and rails; **open a seller** — card half (country, business type) and/or FairCoin half (network and the seller's Oxy user, never a key — ADR 0012); detail with status, capabilities, FairCoin key status, requirements in words and **Refresh from provider**; **onboarding links** (the provider's hosted page, Peable's FairCoin key page) minted on the click and shown to COPY for the seller, never stored; **transfers** globally and per seller, each with its **reversals** and a **Reverse** form (at most what is left; the reversal's `external_ref` is also its `Idempotency-Key` and is kept per scope and transfer until the gateway answers, so a lost answer is retried, never repeated) | `GET/POST …/connected_accounts`, `GET …/connected_accounts/:id`, `POST …/connected_accounts/:id/refresh`, `POST …/connected_accounts/:id/account_links`, `GET …/transfers`, `GET/POST …/transfers/:id/reversals` |
| Reports | One form for every report type (`payments.itemized.1`, `balance.summary.1`, `balance_transactions.itemized.1`, `payouts.itemized.1`, `refunds.itemized.1`, `disputes.itemized.1`): period presets (last 7 / 30 days, this / last month) or custom UTC days, currency, default or all columns. **Download now** streams the CSV at once; **Run and keep** asks for a run, listed with its status (refreshed while pending) and its file. Both are the SAME request and the same report. The selected type's columns (defaults marked) and the cell rules are shown. Saving a file is web only | `GET …/reporting/report_types`, `GET …/reporting/report_types/:id/csv`, `GET/POST …/reporting/report_runs`, `GET …/files/:id/contents` |
| Developers | Webhook **endpoints** (add with URL + events, enable/disable, **Roll secret** with a 24 h overlap, **Send test event**, delete; the `whsec_…` is shown once, on add and roll), the **events** of the last 30 days, and the delivery log — status, attempts, last error, next attempt, event and endpoint — with **Redeliver**; **Events** with a type filter (exact or `prefix.*`) and a detail page (`data.object`, `previous_attributes`, its deliveries, the request that caused it); **Logs**: the merchant's API requests (status class and method filters) and one request by `Request-Id` | `GET/POST …/webhook_endpoints`, `POST/DELETE …/webhook_endpoints/:id`, `POST …/webhook_endpoints/:id/roll_secret`, `POST …/webhook_endpoints/:id/test`, `GET …/events`, `GET …/events/:id`, `GET …/request_logs`, `GET …/request_logs/:id`, `GET …/webhook_deliveries`, `POST …/webhook_deliveries/:id/redeliver` |
| Tax | Peable Tax (only Orbit has it; the wallet's screen was removed) | `…/tax/*` |
| Contributions | Contribution links over the SDK's `@peable.to/sdk/contributions` resource (only Orbit has them) | `/v1/organizations/:org/applications/:app/contributions*` |
| Settings | Register or update the merchant for the selected application and mode: branding (display name, description), required confirmations, and — at registration — the optional FairCoin network + **watch-only** xpub; the **logo** (`business_logo` file, beside the avatar); **Payment methods**: one row per method of the selected configuration with an on/off switch, availability, the currencies it applies to and, when it cannot be offered, why (shown disabled, never hidden); **Wallet domains** for Apple Pay / Google Pay (add, check again, enable/disable, per-wallet status) | `GET/POST/PATCH …/merchant`, `POST …/files`, `GET/POST …/payment_method_configurations[/:id]`, `GET/POST …/payment_method_domains[/:id]`, `POST …/payment_method_domains/:id/validate` |
| Settings › Business details | The merchant's own account's business profile (name, website, support email and page, what it sells, MCC) and its card and payout statement descriptors, checked as the gateway checks them; a field can be changed, not removed | `GET/POST …/account` |
| Settings › Team | The members of the Oxy account that owns the application (direct, inherited, invited) and what each may do in Peable — Orbit (`apps:read`, what the membership check rests on), view / manage Peable Tax (`billing:read` / `billing:manage`) — read from their effective permissions, never their role name. Read-only: changes are made in Oxy Console (linked). Without `members:read` the page says so | Oxy `accounts.members.list`, `users.getMany` |
| Settings › Language | English or Spanish. The language is the Oxy account's (Oxy ADR 0022): `OxyProvider` resolves it — account, else guest choice, else the device / browser — and calls `setLocale`; the switcher changes it through Oxy (`setLanguage`), and every screen re-renders under the new catalog | Oxy |

`…` is `/v1/dashboard/applications/:applicationId`, always with `?environment=`.
Every call is made as the signed-in **Oxy user**; the gateway asks oxy-api for the
caller's membership of the application on each request. There is no merchant
credential in Orbit, and none may be added: a browser is not a place to keep one.

The wallet has no Tax or Contributions screen: those are Orbit's alone.

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
decimals, the status list, the dispute evidence fields and reasons, the file
policies, the payment method types, the request log methods) are restated in
`src/format/money.ts`, `src/payments/status.ts`, `src/disputes/evidence.ts`,
`src/paymentMethods/configuration.ts` and `src/developers/requestLogs.ts` and **pinned by
tests** to the shared-types originals: the shared-types root barrel also exports the
`node:crypto` webhook signer, which a web or native bundle cannot load. The report layouts
need no restating: their module imports nothing at runtime and is published at
`@peable.to/shared-types/reporting`, and the screen reads each type's columns from the API.

A report's CSV is the one non-JSON read (`responseType: 'blob'`), for a run's stored file and
a download alike; a refusal is still the gateway's JSON error, thrown before anything is
saved.

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
client), `EXPO_PUBLIC_GATEWAY_API_URL`, `EXPO_PUBLIC_OXY_CONSOLE_URL` (where Team links
for member changes).

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
