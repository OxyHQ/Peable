# Native FairCoin subscription acceptance

The native executor is watch-only. Commercial amounts remain USD cents; a fresh
Explorer rate authorizes a short-lived exact FAIR base-unit invoice. Display
currency changes never change this amount. No new private-key custody or automatic
debit is introduced.

Verified locally with PostgreSQL 17 (isolated database per suite), real gateway
HTTP routes, SDK token exchange, signed fiscal/invoice contracts, SettlementWatcher,
and Oxy's central period/grant recovery. Chain observations and the test FX rate
are synthetic; there was no funded transaction, live settlement, or deployment.
The public Explorer returned HTTP 403 from this environment. The real chain and
provider route remain unvalidated.

Reproduce from this repository root with a local Postgres admin URL:

```sh
DATABASE_URL="$TEST_DATABASE_URL" bun test --timeout 30000 packages/backend/src/services/billing/__tests__/faircoinBilling.realdb.test.ts packages/backend/src/services/billing/__tests__/configuredFiscalAuthority.test.ts packages/backend/src/services/billing/__tests__/faircoin-fx.test.ts packages/backend/src/services/billing/__tests__/invoice-authority.test.ts
bun run --filter @peable.to/backend typecheck
bun run --filter @peable.to/sdk test
```

Results: 14 focused tests / 70 assertions; 174 SDK tests / 456 assertions; backend
TypeScript passed. The cross-repository fixture is
`packages/backend/src/__tests__/fixtures/nativeFaircoinLifecycleServer.ts`.
Its public mnemonic is a documented test vector used only to derive a watch-only
fixture address. No private seed is accepted by production billing.

`config/oxy-fiscal-intent.json` records commercial intent, not fiscal authority:
Oxy intended issuer, worldwide commercial scope, proposed company name, and missing
real tax identifier, registration jurisdiction, reviewed country rates, and customer
location evidence. Deployment configuration must pass the strict source validator;
no country, identity, or zero tax is inferred. See the integration guide.

Annual individual offers are also exercised through the real cross-repository HTTP
fixture (`PEABLE_NATIVE_ANNUAL_FIXTURE=1` in Oxy). The subscription freezes month/year
cadence, and a paid annual invoice remains one financial period. Oxy creates its
monthly quota windows. Annual renewal is another explicit quote/payment, not debit.
All 31 schema migrations apply in the test database; six native regressions pass
following the cadence extension. See Oxy's annual/window/refund acceptance commands.
