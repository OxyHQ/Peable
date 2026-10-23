# Ecosystem activity

The backend publishes aggregate traffic and its infrastructure heartbeat to the
Oxy API, which broadcasts changes to the website dashboard. Collection runs in
the service process regardless of whether somebody opens the dashboard.

With `AWS_REGION` configured, the publisher uses the shared temporary AWS role
provider, including ECS and authenticated development/SSO roles. Oxy validates
its live application/environment binding (ADR 0049); own apps need no scopes or
customer keys. Missing region omits only telemetry. Invalid region fails at boot;
missing/revoked identity is reported through the shared publisher's retry policy
and must not be interpreted as zero traffic.

The same provider authenticates service introspection and Oxy Files. Reference
outboxes start independently of ECS environment markers and retain their existing
durable retry behavior. Merchant, environment and payment authorization remain
unchanged.

HTTP middleware is mounted before body parsers and routers, including public
routes, webhooks, failures and authenticated internal calls. Outgoing fetch and
Node HTTP requests are observed by the shared SDK, including requests made by
background workers. Socket.IO message sends and receives are observed where
this service exposes Socket.IO. Internal/external scope is independent of
inbound/outbound direction; media is a separate activity category.

Only bounded aggregate fields leave the service. No bodies, message contents,
user identifiers, tokens or IP addresses are added to activity events. Visitor
origins represent the Cloudflare edge PoP, not an IP-derived country. Infrastructure
location follows `AWS_REGION`; registration and graceful removal update the
shared inventory, and crashed instances expire through the API registry.

The publisher does not observe database wire traffic, raw TCP, HTTP/2, WebRTC,
or a separate process that has not installed the collector. These transports
must not be represented by fabricated lines.

## Cloudflare web traffic

The two Cloudflare Pages apps (the wallet at `peable.to` and the hosted checkout
at `checkout.peable.to`) are measured keylessly by Oxy from Cloudflare's own
analytics — see OxyHQ/oxy `docs/operations/cloudflare-web-activity.md`. This repo
holds no Oxy activity secret and runs no activity code at the edge; each
`worker/index.js` only forwards to the static assets.

The `OXY_EDGE_ACTIVITY_*` bindings from the retired edge observer were never
provisioned and nothing reads them now. If an operator ever finds one on a
deployment, it can simply be deleted.
