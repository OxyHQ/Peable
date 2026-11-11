<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Auth

Backend uses `@oxy.so/core/server`: the one `OxyServer` is `src/oxy.ts`
(`oxy`, with `serviceIdentity: 'when-anonymous'`, `applicationId:
PEABLE_OXY_APPLICATION_ID` and `expectedAudience: PEABLE_SERVICE_AUDIENCE` — the
audience every mount accepts, named at no mount; both constants are
`@peable.to/contracts/vocabulary`'s, the same ones the SDK addresses), and the one end-user auth
middleware is `requireOxyUser` in `lib/http.ts` (in the one error envelope),
which `server.ts` hands every
user-authenticated router (none builds its own). `getRequiredOxyUserId`
to read the caller, `oxy.middleware.service()` / `.requireScope()` for merchant
service tokens (EdDSA plus live authority; canonical own audience, bounded external legacy audience), `oxy.middleware.socket()`
for Socket.IO behind `createOxySocketCors` (the same origins as `createOxyCors`,
on polling and on the WebSocket handshake) — the Oxy socket, and the only one an
identity may connect to; the PAYER socket is a second Socket.IO server on
`PAYER_SOCKET_PATH` (`realtime/socket.ts` `initPayerSocket`) that answers any
origin without credentials, refuses a handshake token and handles only
`subscribe` by client secret, the payer routes' rule (Socket.IO's CORS is per
server, so it cannot be a namespace), plus `createOxyCors` and
`createOxyRateLimit` in `server.ts`. There is no
`requireOxyAuth` call site in this repo. Frontend uses `OxyProvider` and `useOxy`
from `@oxy.so/services` (`app/_layout.tsx`, `src/services/oxy-services.ts`).

The hosted checkout is deliberately **anonymous**: a payer has no Oxy session, so
do not add an Oxy auth requirement to a payer-facing route.

**Payer routes answer any origin, without credentials** (`lib/payerCors.ts`):
every `auth: 'public'` contract plus the four dual-auth reads a payer makes with
a client secret (`PAYER_OPERATIONS`) get `Access-Control-Allow-Origin: *`, an
allow-list without `Authorization`, and no cookies — a merchant's own site runs
Pay with Peable. A request carrying `Authorization` is not a payer's and falls
to the Oxy CORS; every other route keeps it. `payerCors.test.ts` walks every
contract both ways.

