<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# What a signed-in person may do: one module, one map

**`services/oxyAccess.ts` is the ONLY place Peable asks Oxy what a person may
do**, for every user-authorised surface: Orbit's dashboard, Peable Tax and the
tax workspace, Orbit uploads and the contribution routes. It is a thin layer
over `@oxy.so/core`: `oxy.applicationAccessFor(req, A)` (the person's
application permissions through the account that owns A, plus `ownerAccountId`,
`official` and `status`; never `appPermissionsFor`, which answers a different
question) and `oxy.accountAccessFor(req, X)`. The SDK asks Oxy with the
caller's own bearer, refuses a service credential, caches only answers that let
someone in (30 s, per session) and types every other outcome as an
`OxyAccessError`; Peable adds the action's permission, `fresh` on every non-GET
and the answer in its own envelope: 401 → `session_invalid`; 403/404 →
`application_membership_required`; anything else → 503
`membership_unavailable`, never cached as "no". Peable keeps no client, schema
or cache of its own.
`services/__tests__/oxyAccessIsTheOnlyPath.test.ts` fails on an access read or
a `createOxyAuthMiddleware` outside their one module, on a raw `apps.get` /
`accounts.get` / `callerMembership` read, a per-user client (`new OxyServices`,
`withUser`, `asUser`) or the SDK's own access middleware anywhere in the
gateway, and on a permission string spelled out in the gateway.

**Each action needs one permission, defined once** in
`@peable.to/contracts/vocabulary` (`DASHBOARD_PERMISSIONS`,
`allowsDashboardAction`, `FILE_UPLOAD_ACTION`). The gateway's gate
(`routes/dashboardAccess.ts`, `dashboardGate(access)(action, core)`) and Orbit
(`useDashboardPermissions().can(action)`) read the SAME map:

| Action | Oxy permission | What |
|---|---|---|
| `read` | `app:read` | every GET, search, a report run (membership itself) |
| `configure` | `app:update` | branding and customer emails, catalog, checkout sessions, payment links, contribution links, payment methods and wallet domains, report schedules, a `business_logo` upload |
| `webhooks` | `webhooks:update` | webhook endpoints, secrets, test events, redelivery |
| `money` | `billing:manage` | the merchant (its confirmations), the provider account and onboarding, payouts, Connect sellers and transfers, disputes, the billing engine, every Peable Tax change and decision, identity verification sessions, Terminal locations, readers and collections, evidence/identity/tax uploads |
| `taxRead` | `billing:read` | Peable Tax reads and previews (`billing:manage` contains it) |

A new route names its action; `routes/__tests__/dashboardPermissions.realdb.test.ts`
walks the real gateway and fails on a route the table above does not cover or
whose gate disagrees with it. Contributions additionally require the path's
account to be an organization that owns the active application.
