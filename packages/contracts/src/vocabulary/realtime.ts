/**
 * The PAYER realtime endpoint: the Socket.IO path a payer's browser opens to
 * hear its payment move, by the intent's `client_secret` alone.
 *
 * It is a SEPARATE Socket.IO server from the gateway's default `/socket.io/`
 * one, because Socket.IO decides CORS per server (per engine), before it
 * knows which namespace or token a connection carries. The payer server
 * answers any origin and takes no credentials — the same rule as the payer
 * HTTP routes (`lib/payerCors.ts`): a merchant's own site runs Pay with
 * Peable, and the capability is the secret, never the page. The default
 * server keeps the Oxy origins (`createOxySocketCors`) for every socket that
 * carries an Oxy identity.
 */
export const PAYER_SOCKET_PATH = '/payer-socket.io';
