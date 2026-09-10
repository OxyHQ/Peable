import { OxyServices } from '@oxy.so/core';
import { OXY_BASE_URL } from '@/config';

/**
 * Shared OxyServices instance used throughout Peable. This is the SAME instance
 * passed to `OxyProvider` in `app/_layout.tsx`, so every module reads and writes
 * the one canonical Oxy session.
 *
 * Session restore is device-first and owned entirely by OxyProvider's cold boot:
 * a per-origin `{deviceId, deviceSecret}` mints a short access token on demand.
 * Only `baseURL` is configured here — no token providers, no auth interceptors.
 */
export const oxyServices = new OxyServices({ baseURL: OXY_BASE_URL });
