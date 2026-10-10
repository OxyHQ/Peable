/**
 * Explorer WebSocket protocol codec.
 *
 * The pure, side-effect-free half of the Explorer realtime channel: Zod schemas
 * for the inbound frames plus validators that turn an untrusted socket message
 * into typed data. It deliberately imports nothing stateful (no socket, no query
 * client, no React Native), so it can be unit-tested in isolation and reused by
 * any future consumer of the channel. The stateful connection lifecycle lives in
 * `explorer-socket.ts`.
 *
 * Event names and payload shapes mirror the Explorer's own contract
 * (`Explorer/shared/websocket-types.ts`). We only model the fields the wallet
 * acts on; unknown extra fields on a frame are ignored by Zod, not rejected.
 */

import { z } from 'zod';
import type { NetworkType } from '@fairco.in/core';

/** Event types the wallet subscribes to on the Explorer socket. */
export const SUBSCRIBED_EVENTS = ['new-block', 'block-count', 'network-stats'] as const;

const networkSchema = z.enum(['mainnet', 'testnet']);

// `new-block` (full BlockData) and `block-count` ({ height, previousHeight })
// both advance the chain tip. We only read the height off either one; every
// other field is intentionally ignored.
const tipEventSchema = z.object({
  type: z.enum(['new-block', 'block-count']),
  network: networkSchema,
  data: z.object({ height: z.number() }),
});

const serverErrorSchema = z.object({
  type: z.literal('error'),
  data: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

/** A validated chain-tip advance extracted from a raw WS frame. */
export interface TipUpdate {
  network: NetworkType;
  height: number;
}

/** A validated server-side error frame. */
export interface ServerError {
  code: string;
  message: string;
}

/**
 * Validate a raw (already JSON-parsed) WS frame and extract a chain-tip height
 * if it is a `new-block` or `block-count` event. Returns null for every other
 * frame — ping/pong, subscribe acks, `network-stats`, or malformed input.
 */
export function parseTipUpdate(raw: unknown): TipUpdate | null {
  const parsed = tipEventSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { network: parsed.data.network, height: parsed.data.data.height };
}

/**
 * Validate a raw WS frame as a server `error` event. Returns null when the
 * frame is any other (or malformed) message.
 */
export function parseServerError(raw: unknown): ServerError | null {
  const parsed = serverErrorSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { code: parsed.data.data.code, message: parsed.data.data.message };
}
