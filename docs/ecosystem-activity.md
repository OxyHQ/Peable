# Ecosystem activity

The backend publishes aggregate traffic and its infrastructure heartbeat to the
Oxy API, which broadcasts changes to the website dashboard. Collection runs in
the service process regardless of whether somebody opens the dashboard.

Starts automatically once `AWS_REGION` is set and the process can authenticate
to Oxy — there is no separate enable flag. On the infrastructure the gateway
authenticates as ITSELF: an ECS task signs an STS `GetCallerIdentity` request
with its task role and Oxy mints the service token (oxy ADR 0026), so a
deployed task needs no credential in its environment. A registered application
credential (`OXY_SERVICE_API_KEY` and `OXY_SERVICE_API_SECRET`) is still
accepted and still preferred where one is present.

Neither an attestable workload identity nor a credential — a laptop, a CI box —
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

## Cloudflare edge requests

Every deployed frontend request, including static files, runs the shared `@oxy.so/telemetry/edge` observer. Workers use `run_worker_first = true`; Pages builds emit a bundled Advanced Mode `_worker.js` with `_routes.json` including `/*`. The original asset handler still owns responses, redirects, streams, MIME handling and cache headers. This increases Worker/Functions invocations for static requests.

Configure **server-only** bindings `OXY_EDGE_ACTIVITY_ENABLED=true`, `OXY_EDGE_ACTIVITY_API_KEY`, `OXY_EDGE_ACTIVITY_API_SECRET`, and optionally `OXY_EDGE_ACTIVITY_API_URL` (default `https://api.oxy.so`). Use a dedicated activity credential, separate from the backend application credential. Never place these bindings in public Expo/Vite variables or committed files. Enabled publication failures emit a fixed error while preserving website availability. Deployment and valid credentials are required before this is live; a code merge alone does not enable coverage.

Each completed response publishes a batch with incoming and outgoing counters through `ctx.waitUntil`. Failed handlers count only the incoming request. Health, collector and authentication control requests are excluded. No URLs, payloads, IP addresses, user identifiers or query strings are sent. Cloudflare `request.cf.colo` identifies the serving PoP; the visitor endpoint stays unknown, so external static activity is a PoP pulse, not a fabricated geographic arc. Credentials and counters never enter frontend bundles.
