# Orbit by Peable

Private standalone merchant application. It has its own Expo web entry, Oxy
session prefix, navigation, dev server and build output. It imports no wallet,
SPV, keystore or signing modules. The consumer wallet and anonymous checkout are
separate packages.

From the repository root:

```sh
bun run dev:orbit
bun run build:orbit
bun run --cwd packages/orbit typecheck
bun run --cwd packages/orbit test
```

Development opens `http://localhost:8121/overview`. Desktop uses Bloom Sidebar;
narrow layouts use a named navigation selector. All destinations have real URLs.
Organization/application/environment selection persists across navigation.

Public configuration is in `src/services.ts`. Oxy owns session refresh and live
membership checks; the linked gateway client makes authenticated GET requests.
The default gateway is `https://api.peable.to`; port 4310's local payer test
harness is not an Orbit merchant identity. No service credential enters this app.
A separate production origin and registered auth redirect require deployment
configuration before publishing.

Connected views: merchant identity/settings, paginated payments and details,
webhook delivery history, and tax settings (subject to billing permissions).
Other operational sections describe the missing owner API honestly. No dashboard
statistics are inferred from partial pages, no missing amount becomes zero, and
no refund/evidence/credential mutation is offered by this initial read surface.

Tests use an isolated process for mocked authenticated component transport. They
exercise organization/app/environment changes, pagination, stale details, denied
access and projections that omit payer capabilities. No test session is shipped
or injected into the running app.
