/**
 * Typed runtime configuration for Peable.
 *
 * Every value is overridable per-environment via an `EXPO_PUBLIC_*` variable
 * (inlined into the bundle at build time by Expo) and falls back to the
 * production default. No URL, client id, or endpoint is hardcoded elsewhere —
 * import from here.
 */

// Oxy identity platform API. Owns the device-first session that OxyProvider
// restores on cold boot.
export const OXY_BASE_URL =
  process.env.EXPO_PUBLIC_OXY_BASE_URL ?? 'https://api.oxy.so';

// Peable's registered Oxy OAuth client id (ApplicationCredential publicKey),
// reused from the Peable Console client. Required by @oxy.so/services for the
// cross-app device sign-in flow. Public and safe to commit.
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_857cabdaba3f79ec5c931706424f439b67f3bc7b7bc34fca';

/** Registered OAuth redirect surface for the Peable web origin (exact match). */
export const OXY_AUTH_REDIRECT_URI =
  process.env.EXPO_PUBLIC_OXY_AUTH_REDIRECT_URI ?? 'https://peable.to';

// Peable Gateway backend (payment intents, submit-tx). RP backend addressed by
// a linked client that re-mints the Oxy token from the device secret.
export const GATEWAY_API_URL =
  process.env.EXPO_PUBLIC_GATEWAY_API_URL ?? 'https://api.peable.to';

// Gateway realtime (Socket.IO) — live payment-intent status updates.
export const GATEWAY_SOCKET_URL =
  process.env.EXPO_PUBLIC_GATEWAY_SOCKET_URL ?? 'wss://api.peable.to';

// Peable's own display name for user-facing UI (biometric unlock prompt,
// accessibility labels). Must NOT come from `@fairco.in/core`'s `APP_NAME` —
// that constant belongs to the external FairCoin protocol package and equals
// "FAIRWallet", a different app's brand. Keep in sync with `app.json`'s `name`.
export const APP_DISPLAY_NAME = 'Peable';

/**
 * Public web origin a Peable profile link resolves against — the `peable.to`
 * in `peable.to/@john`. Its own value rather than a reuse of any API base: the
 * profile page is served by Cloudflare Pages at the apex while the gateway
 * lives on `api.peable.to`, so the two move independently.
 */
export const PROFILE_WEB_ORIGIN =
  process.env.EXPO_PUBLIC_PROFILE_WEB_ORIGIN ?? 'https://peable.to';
