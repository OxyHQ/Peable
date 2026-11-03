/**
 * Typed runtime configuration for Orbit.
 *
 * Every value is overridable per environment through an `EXPO_PUBLIC_*`
 * variable (inlined into the bundle by Metro, which is why each is read as a
 * static member expression; `eslint.config.js` enforces it) and falls back to
 * the production default. No URL or client id is hardcoded elsewhere.
 */

/** Oxy identity API. Owns the device-first session `OxyProvider` restores. */
export const OXY_BASE_URL = process.env.EXPO_PUBLIC_OXY_BASE_URL ?? 'https://api.oxy.so';

/**
 * Peable's registered Oxy OAuth client (ApplicationCredential public key), the
 * same client the wallet signs in with. Public and safe to commit. Orbit's
 * origin must be a registered redirect on it (see `OXY_AUTH_REDIRECT_URI`).
 */
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_857cabdaba3f79ec5c931706424f439b67f3bc7b7bc34fca';

/** Registered OAuth redirect for Orbit's web origin. Must match EXACTLY. */
export const OXY_AUTH_REDIRECT_URI =
  process.env.EXPO_PUBLIC_OXY_AUTH_REDIRECT_URI ?? 'https://orbit.peable.to';

/** The Peable gateway. Its `/v1/dashboard/*` routes take the signed-in user's Oxy bearer. */
export const GATEWAY_API_URL = process.env.EXPO_PUBLIC_GATEWAY_API_URL ?? 'https://api.peable.to';
