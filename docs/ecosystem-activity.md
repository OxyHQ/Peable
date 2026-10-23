# Ecosystem activity

The backend publishes aggregate traffic and its infrastructure heartbeat to the
Oxy API, which broadcasts changes to the website dashboard. Collection runs in
the service process regardless of whether somebody opens the dashboard.

Starts automatically once `AWS_REGION` is set and the process can authenticate
to Oxy — there is no separate enable flag. On the infrastructure the gateway
authenticates as ITSELF: an ECS task signs an STS `GetCallerIdentity` request
with its task role and Oxy mints the service token (oxy ADR 0026), so a
deployed task needs no application credential in its environment. Customer API
keys never substitute for workload authority.

No attestable workload identity — a laptop, a CI box —
is a no-op, not an error, and emits a warning that must not be interpreted as
zero traffic. Missing or unrecognized `AWS_REGION` still fails at boot once the
publisher does start.

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
