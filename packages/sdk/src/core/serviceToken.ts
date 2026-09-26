// Mints a short-lived Oxy service token from an `ApplicationCredential`
// (`{publicKey, secret}`) by presenting it to oxy-api's `POST
// /auth/service-token` — the exact mechanism `oxy.middleware.service()`
// validates at the Gateway. Caches the token until near expiry and re-mints
// reactively when `RestClient` sees a 401 (see `client.ts`).

import { resolveConfig, type PeableConfig } from './config';
import { errorFromResponse, PeableApiError } from './errors';

/** Path (relative to `oxyApiUrl`) of oxy-api's service-token mint endpoint. */
const SERVICE_TOKEN_PATH = '/auth/service-token';

/** Refresh proactively this long before the minted token's actual expiry. */
const REFRESH_MARGIN_MS = 60_000;

export interface ServiceTokenProvider {
  /** Mints once, caches until near expiry, re-mints on expiry/401. */
  getToken(): Promise<string>;
  /** Drop the cached token so the next `getToken()` re-mints. Called by
   * `RestClient` after a Gateway request comes back 401. */
  invalidate(): void;
}

interface ServiceTokenMintResponse {
  token: string;
  expiresIn: number;
  appName?: string;
}

/** oxy-api's `sendSuccess` helper wraps every success body in a `data` envelope. */
interface ServiceTokenMintEnvelope {
  data: ServiceTokenMintResponse;
}

function isServiceTokenMintEnvelope(body: unknown): body is ServiceTokenMintEnvelope {
  if (typeof body !== 'object' || body === null || !('data' in body)) return false;
  const { data } = body as { data: unknown };
  if (typeof data !== 'object' || data === null) return false;
  const candidate = data as { token?: unknown; expiresIn?: unknown };
  return typeof candidate.token === 'string' && typeof candidate.expiresIn === 'number';
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createServiceTokenProvider(
  cfg: PeableConfig,
  deps: { fetch?: typeof fetch } = {},
): ServiceTokenProvider {
  const resolved = resolveConfig(cfg);
  const fetchImpl = deps.fetch ?? fetch;

  let cachedToken: string | null = null;
  let cachedExpiresAt = 0;
  let inflight: Promise<string> | null = null;

  async function mint(): Promise<string> {
    let response: Response;
    try {
      response = await fetchImpl(`${resolved.oxyApiUrl}${SERVICE_TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: resolved.publicKey, apiSecret: resolved.secret }),
      });
    } catch (cause) {
      throw new PeableApiError(
        `Failed to reach ${resolved.oxyApiUrl} to mint an Peable service token: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }

    const body = await readJsonBody(response);
    if (!response.ok) {
      throw errorFromResponse(response.status, body);
    }
    if (!isServiceTokenMintEnvelope(body)) {
      throw new PeableApiError(
        'Peable: the service-token mint response was missing `data.token`/`data.expiresIn`',
      );
    }

    cachedToken = body.data.token;
    cachedExpiresAt = Date.now() + body.data.expiresIn * 1000;
    return cachedToken;
  }

  return {
    async getToken(): Promise<string> {
      if (cachedToken !== null && Date.now() < cachedExpiresAt - REFRESH_MARGIN_MS) {
        return cachedToken;
      }
      if (inflight === null) {
        inflight = mint().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
    invalidate(): void {
      cachedToken = null;
      cachedExpiresAt = 0;
    },
  };
}
