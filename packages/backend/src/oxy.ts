import { OxyServer } from "@oxy.so/core/server";
import { config } from "./config";

/**
 * The gateway's one Oxy client: user lookups, and the Express / Socket.IO
 * middleware that verifies Oxy user sessions and EdDSA service tokens against
 * Oxy's JWKS.
 */
export const oxy = new OxyServer({ baseURL: config.oxyApiUrl });
